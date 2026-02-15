/**
 * Task Orchestrator — the main loop.
 *
 * Coordinates the entire lifecycle:
 * SUBMITTED → PLANNING → AWAITING_PLAN_APPROVAL → EXECUTING_STEP →
 * CHECKPOINT → AWAITING_STEP_APPROVAL → ... → COMPLETED
 *
 * All state changes go through the central transition handler.
 * All LLM calls go through token budget enforcement.
 * All code changes go through file scope validation.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { transition, InvalidTransitionError } from '../core/state-machine/task-state-machine.js';
import { TaskState, createTask } from '../core/entities/task.js';
import type { Task, TokenUsage } from '../core/entities/task.js';
import type { Plan } from '../core/entities/plan.js';
import { StepStatus } from '../core/entities/plan.js';
import { wouldExceedBudget, remainingBudget } from '../core/entities/token-budget.js';
import type { LLMCallRecord, LLMCallType } from '../core/entities/token-budget.js';
import { validateFileScope } from '../core/validation/file-scope-validator.js';
import { parseDiff } from '../core/validation/diff-parser.js';
import type { ILLMAdapter } from '../core/ports/llm-adapter.js';
import type { ITaskStore } from '../core/ports/task-store.js';
import type { INotificationChannel, ApprovalDecision } from '../core/ports/notification-channel.js';
import type { ISandboxRunner, SandboxConfig } from '../core/ports/sandbox-runner.js';
import { getRepoStructure, createBranchName, readFiles } from '../infrastructure/git/git-adapter.js';
import type { AppConfig } from '../config/index.js';
import { createLogger } from '../infrastructure/logger.js';

const log = createLogger('orchestrator');

export class TaskOrchestrator {
  constructor(
    private readonly llm: ILLMAdapter,
    private readonly store: ITaskStore,
    private readonly notify: INotificationChannel,
    private readonly sandbox: ISandboxRunner,
    private readonly config: AppConfig,
  ) {}

  /**
   * Submit a new task and run the full lifecycle.
   * This is the main entry point — blocks until task reaches a terminal state.
   */
  async submitAndRun(goal: string, repoUrl: string): Promise<Task> {
    const taskId = randomUUID();
    let task = createTask(taskId, goal, repoUrl);

    this.store.createTask(task);
    log.info({ taskId, goal }, 'Task submitted');

    try {
      task = await this.runLifecycle(task);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ taskId, error: errMsg }, 'Unhandled error in lifecycle');

      task = { ...task, failureReason: errMsg };
      this.store.updateTask(task);
      await this.notify.sendFailureReport(task, `Unhandled error: ${errMsg}`);
    }

    return task;
  }

  /**
   * Resume a task from its current state (e.g., after restart).
   */
  async resume(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    log.info({ taskId, state: task.state }, 'Resuming task');
    return this.runLifecycle(task);
  }

  // === Main lifecycle loop ===

  private async runLifecycle(task: Task): Promise<Task> {
    // Keep running until we hit a terminal state
    while (!isTerminal(task.state)) {
      task = await this.processState(task);
      this.store.updateTask(task);
    }

    return task;
  }

  /**
   * Process the current state and transition to the next.
   * This is where the orchestration logic lives.
   */
  private async processState(task: Task): Promise<Task> {
    switch (task.state) {
      case TaskState.SUBMITTED:
        return this.doTransition(task, TaskState.PLANNING, 'Starting plan generation');

      case TaskState.PLANNING:
        return this.handlePlanning(task);

      case TaskState.AWAITING_PLAN_APPROVAL:
        return this.handlePlanApproval(task);

      case TaskState.EXECUTING_STEP:
        return this.handleStepExecution(task);

      case TaskState.CHECKPOINT:
        return this.doTransition(task, TaskState.AWAITING_STEP_APPROVAL, 'Step complete, awaiting approval');

      case TaskState.AWAITING_STEP_APPROVAL:
        return this.handleStepApproval(task);

      case TaskState.STEP_FAILED:
        return this.doTransition(task, TaskState.PAUSED_ON_FAILURE, 'Step failed, pausing');

      case TaskState.PAUSED_ON_FAILURE:
        return this.doTransition(task, TaskState.AWAITING_FAILURE_GUIDANCE, 'Awaiting failure guidance');

      case TaskState.AWAITING_FAILURE_GUIDANCE:
        return this.handleFailureGuidance(task);

      case TaskState.AWAITING_SCOPE_APPROVAL:
        return this.handleScopeApproval(task);

      default:
        throw new Error(`Unexpected state: ${task.state}`);
    }
  }

  // === State handlers ===

  private async handlePlanning(task: Task): Promise<Task> {
    // Budget check before LLM call
    if (wouldExceedBudget(task.tokenUsage.totalTokensIn, task.tokenUsage.totalTokensOut, 8000, this.config.tokenBudgetPerTask)) {
      task = { ...task, failureReason: 'Token budget would be exceeded by planning call' };
      return this.doTransition(task, TaskState.PAUSED_ON_FAILURE, 'Budget exceeded');
    }

    try {
      // Clone repo locally for context reading
      const repoDir = this.ensureRepoCloned(task);
      const repoStructure = getRepoStructure(repoDir);

      log.info({ taskId: task.id, repoDir }, 'Repo cloned for planning context');

      const result = await this.llm.generatePlan(task.goal, repoStructure);

      // Set taskId on the plan
      const plan: Plan = { ...result.plan, taskId: task.id };

      // Track token usage
      task = this.addTokenUsage(task, result.tokensIn, result.tokensOut);
      this.logLLMCall(task.id, null, 'planning', result.tokensIn, result.tokensOut, result.durationMs);

      // Create branch name
      const featureBranch = createBranchName(task.id, task.goal);

      // Persist plan
      this.store.savePlan(plan);

      task = {
        ...task,
        featureBranch,
        totalSteps: plan.steps.length,
      };

      return this.doTransition(task, TaskState.AWAITING_PLAN_APPROVAL, 'Plan generated');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      task = { ...task, failureReason: `Planning failed: ${errMsg}` };
      return this.doTransition(task, TaskState.PAUSED_ON_FAILURE, errMsg);
    }
  }

  private async handlePlanApproval(task: Task): Promise<Task> {
    const plan = this.store.getPlan(task.id);
    if (!plan) throw new Error(`Plan not found for task: ${task.id}`);

    // Send plan to Telegram and wait for decision
    await this.notify.sendPlanForApproval(task, plan);
    const decision = await this.notify.waitForDecision(task.id);

    switch (decision.type) {
      case 'approve':
        return this.doTransition(task, TaskState.EXECUTING_STEP, 'Plan approved');
      case 'reject':
        return this.doTransition(task, TaskState.REJECTED, 'Plan rejected by user');
      case 'abort':
        return this.doTransition(task, TaskState.ABORTED, 'Aborted by user');
      default:
        return this.doTransition(task, TaskState.REJECTED, `Unexpected decision: ${decision.type}`);
    }
  }

  private async handleStepExecution(task: Task): Promise<Task> {
    const plan = this.store.getPlan(task.id);
    if (!plan) throw new Error(`Plan not found for task: ${task.id}`);

    const step = plan.steps[task.currentStepIndex];
    if (!step) {
      // All steps done
      return this.doTransition(task, TaskState.COMPLETED, 'All steps completed');
    }

    log.info({ taskId: task.id, step: step.index, title: step.title }, 'Executing step');

    // Budget check before code generation
    if (wouldExceedBudget(task.tokenUsage.totalTokensIn, task.tokenUsage.totalTokensOut, 4000, this.config.tokenBudgetPerTask)) {
      task = { ...task, failureReason: 'Token budget exceeded' };
      return this.doTransition(task, TaskState.STEP_FAILED, 'Budget exceeded');
    }

    try {
      // Read file contents for context (scoped to allowed files)
      const repoDir = this.getRepoDir(task.id);
      const fileContents = readFiles(repoDir, step.allowedFiles);

      // Generate code
      const codeResult = await this.llm.generateCode(step, fileContents, plan.summary);
      task = this.addTokenUsage(task, codeResult.tokensIn, codeResult.tokensOut);
      this.logLLMCall(task.id, step.index, 'code_generation', codeResult.tokensIn, codeResult.tokensOut, codeResult.durationMs);

      // Execute in sandbox
      const sandboxConfig: SandboxConfig = {
        repoUrl: task.repoUrl,
        branch: task.featureBranch!,
        timeoutSec: this.config.sandboxTimeoutSec,
        memoryMb: this.config.sandboxMemoryMb,
        cpuCount: this.config.sandboxCpuCount,
      };

      const execResult = await this.sandbox.executeStep(step, codeResult.code, sandboxConfig);

      // === FILE SCOPE VALIDATION (CRITICAL) ===
      const diffFiles = parseDiff(execResult.diff);
      const violations = validateFileScope(step, diffFiles);

      if (violations.length > 0) {
        const violationMsg = violations.map((v) => `[${v.type}] ${v.detail}`).join('\n');
        const allowedHint = `Only these files may be modified in this step: [${step.allowedFiles.join(', ')}].`;
        task = { ...task, failureReason: `File scope violation:\n${violationMsg}\n${allowedHint}` };
        // Store diff/testOutput on step so we can proceed if user allows
        step.diff = execResult.diff;
        step.testResults = execResult.testOutput;
        this.store.savePlan(plan);
        return this.doTransition(task, TaskState.AWAITING_SCOPE_APPROVAL, 'File scope violation — awaiting user allow/revise');
      }

      // Summarize results
      const summaryResult = await this.llm.summarize(execResult.diff, execResult.testOutput, step.title);
      task = this.addTokenUsage(task, summaryResult.tokensIn, summaryResult.tokensOut);
      this.logLLMCall(task.id, step.index, 'summarization', summaryResult.tokensIn, summaryResult.tokensOut, summaryResult.durationMs);

      // Update step results in plan
      step.status = execResult.success ? StepStatus.COMPLETED : StepStatus.FAILED;
      step.diff = execResult.diff;
      step.testResults = execResult.testOutput;
      step.tokensUsed = codeResult.tokensOut + summaryResult.tokensOut;
      this.store.savePlan(plan);

      if (!execResult.success) {
        task = { ...task, failureReason: `Tests failed: ${execResult.testOutput.slice(0, 500)}` };
        return this.doTransition(task, TaskState.STEP_FAILED, 'Tests failed');
      }

      // Send results to Telegram
      const { totalTokensIn, totalTokensOut } = task.tokenUsage;
      const totalUsed = totalTokensIn + totalTokensOut;
      await this.notify.sendStepResult(task, {
        step,
        diff: execResult.diff,
        testResults: execResult.testOutput,
        summary: summaryResult.summary,
        tokensUsed: step.tokensUsed,
        totalTokensUsed: totalUsed,
        budgetRemaining: remainingBudget(totalTokensIn, totalTokensOut, this.config.tokenBudgetPerTask),
      });

      return this.doTransition(task, TaskState.CHECKPOINT, `Step ${step.index} complete`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      task = { ...task, failureReason: errMsg };
      return this.doTransition(task, TaskState.STEP_FAILED, errMsg);
    }
  }

  private async handleStepApproval(task: Task): Promise<Task> {
    const decision = await this.notify.waitForDecision(task.id);

    switch (decision.type) {
      case 'approve': {
        const nextIndex = task.currentStepIndex + 1;
        task = { ...task, currentStepIndex: nextIndex };

        if (nextIndex >= task.totalSteps) {
          const { totalTokensIn, totalTokensOut } = task.tokenUsage;
          await this.notify.sendCompletion(task, totalTokensIn + totalTokensOut, task.totalSteps);
          return this.doTransition(task, TaskState.COMPLETED, 'All steps approved and completed');
        }

        return this.doTransition(task, TaskState.EXECUTING_STEP, `Step approved, moving to step ${nextIndex}`);
      }
      case 'abort':
        return this.doTransition(task, TaskState.ABORTED, 'Aborted by user during step approval');
      default:
        return this.doTransition(task, TaskState.ABORTED, `Unexpected decision: ${decision.type}`);
    }
  }

  private async handleFailureGuidance(task: Task): Promise<Task> {
    await this.notify.sendFailureReport(task, task.failureReason ?? 'Unknown failure', task.currentStepIndex);
    const decision = await this.notify.waitForDecision(task.id);

    switch (decision.type) {
      case 'retry':
        task = { ...task, failureReason: null };
        return this.doTransition(task, TaskState.EXECUTING_STEP, 'Retrying current step');
      case 'fix': {
        const plan = this.store.getPlan(task.id);
        if (!plan) throw new Error(`Plan not found for task: ${task.id}`);
        const step = plan.steps[task.currentStepIndex];
        if (!step) throw new Error(`Step not found for task: ${task.id}`);

        if (wouldExceedBudget(task.tokenUsage.totalTokensIn, task.tokenUsage.totalTokensOut, 2500, this.config.tokenBudgetPerTask)) {
          const budgetMsg = 'Fix-it skipped: token budget would be exceeded by investigation.';
          task = { ...task, failureReason: budgetMsg };
          await this.notify.sendStatus(task, budgetMsg);
          return this.doTransition(task, TaskState.STEP_FAILED, 'Budget exceeded for fix-it');
        }

        const repoDir = this.getRepoDir(task.id);
        const fileContents = readFiles(repoDir, step.allowedFiles);

        const investigation = await this.llm.investigateFailure(
          step,
          task.failureReason ?? 'Unknown failure',
          step.testResults ?? '',
          fileContents,
          step.diff ?? undefined,
        );

        task = this.addTokenUsage(task, investigation.tokensIn, investigation.tokensOut);
        this.logLLMCall(task.id, step.index, 'investigation', investigation.tokensIn, investigation.tokensOut, investigation.durationMs);

        log.info(
          { taskId: task.id, stepIndex: step.index, diagnosis: investigation.diagnosis, revisedInstruction: investigation.revisedInstruction },
          'Investigation complete — diagnosis and plan logged',
        );

        const resolutionMessage = `🔧 Fix-it investigation\n\nDiagnosis: ${investigation.diagnosis}\n\nRevised plan: ${investigation.revisedInstruction}`;
        await this.notify.sendStatus(task, resolutionMessage);

        step.instruction = investigation.revisedInstruction;
        this.store.savePlan(plan);

        task = { ...task, failureReason: null };
        return this.doTransition(task, TaskState.EXECUTING_STEP, 'Retrying with revised instruction from fix-it');
      }
      case 'skip': {
        const nextIndex = task.currentStepIndex + 1;
        task = { ...task, currentStepIndex: nextIndex, failureReason: null };

        if (nextIndex >= task.totalSteps) {
          return this.doTransition(task, TaskState.COMPLETED, 'Last step skipped, task complete');
        }
        return this.doTransition(task, TaskState.EXECUTING_STEP, `Skipping to step ${nextIndex}`);
      }
      case 'abort':
        return this.doTransition(task, TaskState.ABORTED, 'Aborted by user after failure');
      default:
        return this.doTransition(task, TaskState.ABORTED, `Unexpected decision: ${decision.type}`);
    }
  }

  private async handleScopeApproval(task: Task): Promise<Task> {
    const plan = this.store.getPlan(task.id);
    if (!plan) throw new Error(`Plan not found for task: ${task.id}`);

    const step = plan.steps[task.currentStepIndex];
    if (!step || !step.diff) throw new Error(`Step or diff not found for scope approval: ${task.id}`);

    const modifiedFiles = parseDiff(step.diff).map((f) => f.path);
    await this.notify.sendScopeViolationForApproval(
      task,
      task.failureReason ?? 'File scope violation',
      step.allowedFiles,
      modifiedFiles,
      task.currentStepIndex,
    );

    const decision = await this.notify.waitForDecision(task.id);

    switch (decision.type) {
      case 'allow_scope': {
        // User allowed — treat step as complete: summarize, update step, send result, continue
        const summaryResult = await this.llm.summarize(step.diff, step.testResults ?? '', step.title);
        task = this.addTokenUsage(task, summaryResult.tokensIn, summaryResult.tokensOut);
        this.logLLMCall(task.id, step.index, 'summarization', summaryResult.tokensIn, summaryResult.tokensOut, summaryResult.durationMs);

        step.status = StepStatus.COMPLETED;
        step.tokensUsed = summaryResult.tokensOut;
        this.store.savePlan(plan);

        const { totalTokensIn, totalTokensOut } = task.tokenUsage;
        const totalUsed = totalTokensIn + totalTokensOut;
        await this.notify.sendStepResult(task, {
          step,
          diff: step.diff,
          testResults: step.testResults ?? '',
          summary: summaryResult.summary,
          tokensUsed: step.tokensUsed,
          totalTokensUsed: totalUsed,
          budgetRemaining: remainingBudget(totalTokensIn, totalTokensOut, this.config.tokenBudgetPerTask),
        });

        task = { ...task, failureReason: null };
        return this.doTransition(task, TaskState.CHECKPOINT, 'User allowed scope — step accepted');
      }
      case 'revise_scope': {
        // Revise: retry step with strict instruction so generator stays in scope
        const strictPrefix = `STRICT: Only modify these files: ${step.allowedFiles.join(', ')}. Do not output any other file.\n\n`;
        step.instruction = strictPrefix + step.instruction;
        step.diff = null;
        step.testResults = null;
        this.store.savePlan(plan);
        task = { ...task, failureReason: null };
        return this.doTransition(task, TaskState.EXECUTING_STEP, 'Revise plan — retrying with strict scope');
      }
      case 'abort':
        return this.doTransition(task, TaskState.ABORTED, 'Aborted by user after scope violation');
      default:
        return this.doTransition(task, TaskState.ABORTED, `Unexpected scope decision: ${decision.type}`);
    }
  }

  // === Repo management ===

  /**
   * Get the local repo directory for a task.
   * Located at: WORKSPACE_DIR/<taskId>/repo
   */
  private getRepoDir(taskId: string): string {
    return join(this.config.workspaceDir, taskId, 'repo');
  }

  /**
   * Clone the repo locally if not already cloned.
   * Used for reading repo structure (planning) and file contents (code gen context).
   */
  private ensureRepoCloned(task: Task): string {
    const repoDir = this.getRepoDir(task.id);

    if (existsSync(repoDir)) {
      log.info({ taskId: task.id, repoDir }, 'Repo already cloned');
      return repoDir;
    }

    const taskDir = join(this.config.workspaceDir, task.id);
    mkdirSync(taskDir, { recursive: true });

    log.info({ taskId: task.id, repoUrl: task.repoUrl, repoDir }, 'Cloning repo...');
    execSync(`git clone --depth 1 ${task.repoUrl} ${repoDir}`, {
      stdio: 'pipe',
      timeout: 120_000,
    });

    return repoDir;
  }

  // === Helpers ===

  /**
   * Central transition — ALL state changes go through here.
   */
  private doTransition(task: Task, to: TaskState, reason: string): Task {
    const result = transition(task, to, { reason });
    this.store.logTransition(result.log);
    log.info({ taskId: task.id, from: task.state, to, reason }, 'State transition');
    return result.task;
  }

  private addTokenUsage(task: Task, tokensIn: number, tokensOut: number): Task {
    return {
      ...task,
      tokenUsage: {
        totalTokensIn: task.tokenUsage.totalTokensIn + tokensIn,
        totalTokensOut: task.tokenUsage.totalTokensOut + tokensOut,
        callCount: task.tokenUsage.callCount + 1,
      },
    };
  }

  private logLLMCall(
    taskId: string,
    stepIndex: number | null,
    callType: LLMCallType,
    tokensIn: number,
    tokensOut: number,
    durationMs: number,
  ): void {
    this.store.logLLMCall({
      taskId,
      stepIndex,
      callType,
      tokensIn,
      tokensOut,
      model: 'claude-sonnet-4-20250514',
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }
}

// === Helpers ===

const isTerminal = (state: TaskState): boolean =>
  state === TaskState.COMPLETED ||
  state === TaskState.ABORTED ||
  state === TaskState.REJECTED;
