/**
 * Tests for the full orchestrator flow — mock LLM + mock notification.
 * Exercises the complete lifecycle:
 * SUBMITTED → PLANNING → AWAITING_PLAN_APPROVAL → EXECUTING_STEP →
 * CHECKPOINT → AWAITING_STEP_APPROVAL → COMPLETED
 *
 * Uses REAL: SQLite persistence, state machine, git adapter, file scope validation
 * Uses MOCK: LLM adapter (returns canned responses), notification channel (auto-approves)
 * Docker sandbox is mocked to avoid needing Docker for this test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TaskOrchestrator } from '../../src/orchestrator/task-orchestrator.js';
import { TaskState } from '../../src/core/entities/task.js';
import { StepStatus, createPlanStep } from '../../src/core/entities/plan.js';
import type { Plan, PlanStep } from '../../src/core/entities/plan.js';
import type {
  ILLMAdapter,
  FileContext,
  PlanGenerationResult,
  CodeGenerationResult,
  SummarizationResult,
} from '../../src/core/ports/llm-adapter.js';
import type {
  INotificationChannel,
  ApprovalDecision,
  StepResultPayload,
} from '../../src/core/ports/notification-channel.js';
import type { ISandboxRunner, SandboxConfig, StepExecutionResult } from '../../src/core/ports/sandbox-runner.js';
import type { Task } from '../../src/core/entities/task.js';
import { SQLiteTaskStore } from '../../src/infrastructure/persistence/sqlite-task-store.js';
import type { AppConfig } from '../../src/config/index.js';

// === Test fixtures ===

const WORKSPACE_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const TEST_DIR = join(WORKSPACE_ROOT, '.test-tmp', 'orchestrator');
const TEST_REPO_DIR = join(TEST_DIR, 'test-repo');

const createTestConfig = (dbPath: string): AppConfig => ({
  llmProvider: 'anthropic',
  anthropicApiKey: 'test-key-not-used',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  telegramBotToken: 'test-token-not-used',
  telegramChatId: 'test-chat-not-used',
  workspaceDir: join(TEST_DIR, 'workspaces'),
  dbPath,
  tokenBudgetPerTask: 50_000,
  dockerSocket: '/var/run/docker.sock',
  sandboxImage: 'ai-dev-sandbox:latest',
  sandboxTimeoutSec: 120,
  sandboxMemoryMb: 256,
  sandboxCpuCount: 1,
  logLevel: 'warn',
});

/**
 * Mock LLM adapter — returns deterministic responses without calling any API.
 * Simulates plan generation, code generation, and summarization.
 */
class MockLLMAdapter implements ILLMAdapter {
  planCallCount = 0;
  codeGenCallCount = 0;
  summarizeCallCount = 0;

  async generatePlan(goal: string, repoStructure: string): Promise<PlanGenerationResult> {
    this.planCallCount++;

    const plan: Plan = {
      taskId: '', // will be set by orchestrator
      summary: `Mock plan for: ${goal}`,
      estimatedTokens: 2000,
      steps: [
        createPlanStep(
          0,
          'Create README.md',
          'Add a README with project info',
          'Create README.md with title and description',
          ['README.md'],
          { newFilesAllowed: true },
        ),
      ],
      createdAt: new Date().toISOString(),
    };

    return {
      plan,
      tokensIn: 200,
      tokensOut: 100,
      durationMs: 50,
    };
  }

  async generateCode(
    step: PlanStep,
    fileContents: FileContext[],
    planSummary: string,
  ): Promise<CodeGenerationResult> {
    this.codeGenCallCount++;

    const code = `--- FILE: README.md ---
# Test Project

This is a mock-generated README.
Created by step: ${step.title}
--- END FILE ---`;

    return {
      code,
      tokensIn: 150,
      tokensOut: 80,
      durationMs: 30,
    };
  }

  async summarize(diff: string, testResults: string, stepTitle: string): Promise<SummarizationResult> {
    this.summarizeCallCount++;

    return {
      summary: `Step "${stepTitle}" completed. Files modified. Tests: ${testResults ? 'ran' : 'none'}.`,
      tokensIn: 50,
      tokensOut: 30,
      durationMs: 20,
    };
  }
}

/**
 * Mock notification channel — auto-approves everything.
 * Records all messages sent for verification.
 */
class MockNotificationChannel implements INotificationChannel {
  messages: string[] = [];
  decisionQueue: ApprovalDecision[] = [];

  /** Pre-load decisions that will be returned by waitForDecision */
  pushDecision(decision: ApprovalDecision): void {
    this.decisionQueue.push(decision);
  }

  async sendPlanForApproval(task: Task, plan: Plan): Promise<void> {
    this.messages.push(`PLAN: ${plan.summary} (${plan.steps.length} steps)`);
  }

  async sendStepResult(task: Task, result: StepResultPayload): Promise<void> {
    this.messages.push(`STEP_RESULT: ${result.step.title} — ${result.summary}`);
  }

  async sendFailureReport(task: Task, reason: string, stepIndex?: number): Promise<void> {
    this.messages.push(`FAILURE: step=${stepIndex ?? 'N/A'} reason=${reason}`);
  }

  async sendScopeViolationForApproval(
    task: Task,
    reason: string,
    allowedFiles: string[],
    modifiedFiles: string[],
    stepIndex: number,
    _justifications?: unknown[],
  ): Promise<void> {
    this.messages.push(`SCOPE_VIOLATION: allowed=[${allowedFiles.join(',')}] modified=[${modifiedFiles.join(',')}]`);
  }

  async sendBudgetExceeded(task: Task, totalUsed: number, budgetLimit: number): Promise<void> {
    this.messages.push(`BUDGET_EXCEEDED: used=${totalUsed} limit=${budgetLimit}`);
  }

  async sendStatus(task: Task, message: string): Promise<void> {
    this.messages.push(`STATUS: ${message}`);
  }

  async sendCompletion(task: Task, totalTokens: number, totalSteps: number): Promise<void> {
    this.messages.push(`COMPLETE: ${totalSteps} steps, ${totalTokens} tokens`);
  }

  async waitForDecision(taskId: string): Promise<ApprovalDecision> {
    const decision = this.decisionQueue.shift();
    if (!decision) {
      throw new Error(`MockNotificationChannel: no decision queued for task ${taskId}`);
    }
    return decision;
  }

  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }
}

/**
 * Mock sandbox runner — simulates container execution.
 * Returns a fake diff that matches the generated code.
 */
class MockSandboxRunner implements ISandboxRunner {
  executeCallCount = 0;
  shouldFail = false;

  async executeStep(
    step: PlanStep,
    generatedCode: string,
    config: SandboxConfig,
  ): Promise<StepExecutionResult> {
    this.executeCallCount++;

    if (this.shouldFail) {
      return {
        success: false,
        diff: '',
        testOutput: 'FAIL: Mock test failure',
        testsPassed: false,
        filesModified: [],
        linesChanged: 0,
        exitCode: 1,
        durationMs: 100,
        error: 'Mock sandbox failure',
      };
    }

    // Simulate a successful execution
    const diff = `diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,4 @@
+# Test Project
+
+This is a mock-generated README.
+Created by step: ${step.title}`;

    return {
      success: true,
      diff,
      testOutput: 'All tests passed (mock)',
      testsPassed: true,
      filesModified: ['README.md'],
      linesChanged: 4,
      exitCode: 0,
      durationMs: 200,
    };
  }
}

// === Tests ===

let store: SQLiteTaskStore;
let dbPath: string;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Create a local test repo for the orchestrator to clone from
  mkdirSync(TEST_REPO_DIR, { recursive: true });
  execSync('git init', { cwd: TEST_REPO_DIR, stdio: 'pipe' });
  writeFileSync(join(TEST_REPO_DIR, 'package.json'), '{"name": "test-repo"}');
  execSync('git add -A && git commit -m "init"', { cwd: TEST_REPO_DIR, stdio: 'pipe' });

  dbPath = join(TEST_DIR, `test-${randomUUID()}.db`);
  store = new SQLiteTaskStore(dbPath);
});

afterEach(() => {
  if (store) store.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Orchestrator — Happy Path (full lifecycle)', () => {
  it('should complete a single-step task end-to-end', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    // Queue decisions: approve plan, then approve step
    notify.pushDecision({ type: 'approve' }); // plan approval
    notify.pushDecision({ type: 'approve' }); // step approval

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    // Verify terminal state
    expect(task.state).toBe(TaskState.COMPLETED);

    // Verify LLM was called
    expect(llm.planCallCount).toBe(1);
    expect(llm.codeGenCallCount).toBe(1);
    expect(llm.summarizeCallCount).toBe(1);

    // Verify sandbox was called
    expect(sandbox.executeCallCount).toBe(1);

    // Verify notifications were sent
    expect(notify.messages.some((m) => m.startsWith('PLAN:'))).toBe(true);
    expect(notify.messages.some((m) => m.startsWith('STEP_RESULT:'))).toBe(true);
    expect(notify.messages.some((m) => m.startsWith('COMPLETE:'))).toBe(true);

    // Verify token usage was tracked
    expect(task.tokenUsage.totalTokensIn).toBeGreaterThan(0);
    expect(task.tokenUsage.totalTokensOut).toBeGreaterThan(0);
    expect(task.tokenUsage.callCount).toBe(3); // plan + code gen + summarize

    // Verify task was persisted
    const storedTask = store.getTask(task.id);
    expect(storedTask).not.toBeNull();
    expect(storedTask!.state).toBe(TaskState.COMPLETED);

    // Verify plan was persisted
    const storedPlan = store.getPlan(task.id);
    expect(storedPlan).not.toBeNull();
    expect(storedPlan!.steps).toHaveLength(1);

    // Verify transition logs
    const logs = store.getTransitionLogs(task.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].fromState).toBe(TaskState.SUBMITTED);
    expect(logs[logs.length - 1].toState).toBe(TaskState.COMPLETED);

    // Verify LLM calls were logged
    const llmCalls = store.getLLMCalls(task.id);
    expect(llmCalls).toHaveLength(3);

    console.log('Happy path transitions:', logs.map((l) => `${l.fromState} → ${l.toState}`).join(', '));
    console.log('Notifications:', notify.messages);
  });
});

describe('Orchestrator — Plan Rejection', () => {
  it('should abort when user rejects the plan', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'reject' }); // reject plan

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    expect(task.state).toBe(TaskState.REJECTED);
    expect(llm.planCallCount).toBe(1);
    expect(llm.codeGenCallCount).toBe(0); // no code generation
    expect(sandbox.executeCallCount).toBe(0); // no sandbox execution
  });
});

describe('Orchestrator — Plan Abort', () => {
  it('should abort when user aborts during plan approval', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'abort' }); // abort

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    expect(task.state).toBe(TaskState.ABORTED);
  });
});

describe('Orchestrator — Step Failure + Retry', () => {
  it('should handle step failure and retry successfully', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    // First execution will fail
    sandbox.shouldFail = true;

    // Queue: approve plan → (step fails) → retry → (step succeeds) → approve step
    notify.pushDecision({ type: 'approve' }); // plan approval
    notify.pushDecision({ type: 'retry' });   // retry after failure
    notify.pushDecision({ type: 'approve' }); // step approval after retry

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);

    // After first failure, make sandbox succeed on retry
    const origExecuteStep = sandbox.executeStep.bind(sandbox);
    let callCount = 0;
    sandbox.executeStep = async (step, code, cfg) => {
      callCount++;
      if (callCount === 2) sandbox.shouldFail = false; // succeed on second try
      return origExecuteStep(step, code, cfg);
    };

    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    expect(task.state).toBe(TaskState.COMPLETED);

    // Verify failure was reported
    expect(notify.messages.some((m) => m.startsWith('FAILURE:'))).toBe(true);

    // Verify transition logs include failure path
    const logs = store.getTransitionLogs(task.id);
    const stateSequence = logs.map((l) => l.toState);
    expect(stateSequence).toContain(TaskState.STEP_FAILED);
    expect(stateSequence).toContain(TaskState.PAUSED_ON_FAILURE);
    expect(stateSequence).toContain(TaskState.AWAITING_FAILURE_GUIDANCE);

    console.log('Failure+retry transitions:', logs.map((l) => `${l.fromState} → ${l.toState}`).join(', '));
  });
});

describe('Orchestrator — Step Failure + Abort', () => {
  it('should abort when user chooses abort after failure', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();
    sandbox.shouldFail = true;

    notify.pushDecision({ type: 'approve' }); // plan approval
    notify.pushDecision({ type: 'abort' });   // abort after failure

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    expect(task.state).toBe(TaskState.ABORTED);
  });
});

describe('Orchestrator — Abort During Step Approval', () => {
  it('should abort when user aborts during step approval', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'approve' }); // plan approval
    notify.pushDecision({ type: 'abort' });   // abort during step approval

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README', TEST_REPO_DIR);

    expect(task.state).toBe(TaskState.ABORTED);
  });
});

describe('Orchestrator — Task Persistence', () => {
  it('should persist task state after each transition', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'approve' });
    notify.pushDecision({ type: 'approve' });

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Persistence test', TEST_REPO_DIR);

    // Verify task is in DB
    const stored = store.getTask(task.id);
    expect(stored).not.toBeNull();
    expect(stored!.state).toBe(TaskState.COMPLETED);

    // Verify all transitions were logged
    const logs = store.getTransitionLogs(task.id);
    expect(logs.length).toBeGreaterThanOrEqual(6); // at least 6 transitions for happy path

    // Verify LLM calls were logged
    const llmCalls = store.getLLMCalls(task.id);
    expect(llmCalls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Orchestrator — Feature Branch Naming', () => {
  it('should create a properly formatted branch name', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'approve' });
    notify.pushDecision({ type: 'approve' });

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Add a README file', TEST_REPO_DIR);

    expect(task.featureBranch).not.toBeNull();
    expect(task.featureBranch).toMatch(/^ai\/[a-f0-9]{8}\//);
    console.log('Feature branch:', task.featureBranch);
  });
});
