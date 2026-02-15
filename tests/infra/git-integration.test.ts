
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TaskOrchestrator } from '../../src/orchestrator/task-orchestrator.js';
import { TaskState } from '../../src/core/entities/task.js';
import { createPlanStep } from '../../src/core/entities/plan.js';
import type { Plan, PlanStep } from '../../src/core/entities/plan.js';
import type { ILLMAdapter, PlanGenerationResult, CodeGenerationResult, SummarizationResult, FileContext } from '../../src/core/ports/llm-adapter.js';
import type { INotificationChannel, ApprovalDecision, StepResultPayload } from '../../src/core/ports/notification-channel.js';
import type { ISandboxRunner, SandboxConfig, StepExecutionResult } from '../../src/core/ports/sandbox-runner.js';
import type { Task } from '../../src/core/entities/task.js';
import { SQLiteTaskStore } from '../../src/infrastructure/persistence/sqlite-task-store.js';
import type { AppConfig } from '../../src/config/index.js';
import * as gitAdapter from '../../src/infrastructure/git/git-adapter.js';

// === Mock Git Adapter ===
vi.mock('../../src/infrastructure/git/git-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/infrastructure/git/git-adapter.js')>();
  return {
    ...actual,
    commitChanges: vi.fn(),
    pushBranch: vi.fn(),
    createPullRequest: vi.fn().mockReturnValue('https://github.com/owner/repo/pull/1'),
    checkoutNewBranch: vi.fn(), // Mock this as it's used via dynamic import or static
    checkGhInstalled: vi.fn().mockReturnValue(true),
    checkGhAuth: vi.fn().mockReturnValue(true),
  };
});

// === Test fixtures ===

const WORKSPACE_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const TEST_DIR = join(WORKSPACE_ROOT, '.test-tmp', 'git-integration');
const TEST_REPO_DIR = join(TEST_DIR, 'test-repo');

const createTestConfig = (dbPath: string): AppConfig => ({
  llmProvider: 'anthropic',
  anthropicApiKey: 'test-key',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  telegramBotToken: 'test-token',
  telegramChatId: 'test-chat',
  workspaceDir: join(TEST_DIR, 'workspaces'),
  dbPath,
  tokenBudgetPerTask: 50_000,
  dockerSocket: '/var/run/docker.sock',
  sandboxImage: 'ai-dev-sandbox:latest',
  sandboxTimeoutSec: 120,
  sandboxMemoryMb: 256,
  sandboxCpuCount: 1,
  logLevel: 'error',
});

// Mock LLM
class MockLLMAdapter implements ILLMAdapter {
  async generatePlan(goal: string, repoStructure: string): Promise<PlanGenerationResult> {
    return {
      plan: {
        taskId: '',
        summary: `Plan for: ${goal}`,
        estimatedTokens: 100,
        steps: [
          createPlanStep(0, 'Step 1', 'Do something', 'Instruction', ['file1.txt'], { newFilesAllowed: true }),
        ],
        createdAt: new Date().toISOString(),
      },
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 10,
    };
  }

  async generateCode(step: PlanStep, fileContents: FileContext[], planSummary: string): Promise<CodeGenerationResult> {
    return {
      code: 'some code',
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 10,
    };
  }

  async summarize(diff: string, testResults: string, stepTitle: string): Promise<SummarizationResult> {
    return {
      summary: 'Summary',
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 10,
    };
  }
}

// Mock Notification
class MockNotificationChannel implements INotificationChannel {
  decisionQueue: ApprovalDecision[] = [];
  lastCompletionPrUrl?: string;

  pushDecision(decision: ApprovalDecision) {
    this.decisionQueue.push(decision);
  }

  async sendPlanForApproval(task: Task, plan: Plan): Promise<void> {}
  async sendStepResult(task: Task, result: StepResultPayload): Promise<void> {}
  async sendFailureReport(task: Task, reason: string, stepIndex?: number): Promise<void> {}
  async sendScopeViolationForApproval(task: Task, reason: string, allowedFiles: string[], modifiedFiles: string[], stepIndex: number, justifications?: unknown[]): Promise<void> {}
  async sendBudgetExceeded(task: Task, totalUsed: number, budgetLimit: number): Promise<void> {}
  async sendStatus(task: Task, message: string): Promise<void> {}
  
  async sendCompletion(task: Task, totalTokens: number, totalSteps: number, prUrl?: string, message?: string): Promise<void> {
    this.lastCompletionPrUrl = prUrl;
  }

  async waitForDecision(taskId: string): Promise<ApprovalDecision> {
    return this.decisionQueue.shift() || { type: 'abort' };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

// Mock Sandbox
class MockSandboxRunner implements ISandboxRunner {
  async executeStep(step: PlanStep, generatedCode: string, config: SandboxConfig): Promise<StepExecutionResult> {
    return {
      success: true,
      diff: 'diff',
      testOutput: 'pass',
      testsPassed: true,
      filesModified: ['file1.txt'],
      linesChanged: 1,
      exitCode: 0,
      durationMs: 10,
    };
  }
}

let store: SQLiteTaskStore;
let dbPath: string;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  
  // Setup dummy repo
  mkdirSync(TEST_REPO_DIR, { recursive: true });
  execSync('git init', { cwd: TEST_REPO_DIR });
  execSync('git config user.email "test@example.com"', { cwd: TEST_REPO_DIR });
  execSync('git config user.name "Test User"', { cwd: TEST_REPO_DIR });
  writeFileSync(join(TEST_REPO_DIR, 'README.md'), '# Test');
  execSync('git add . && git commit -m "init"', { cwd: TEST_REPO_DIR });

  dbPath = join(TEST_DIR, `test-${randomUUID()}.db`);
  store = new SQLiteTaskStore(dbPath);
  
  vi.clearAllMocks();
});

afterEach(() => {
  if (store) store.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Git Integration in Orchestrator', () => {
  it('should commit changes after successful step and push/PR on completion', async () => {
    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'approve' }); // Plan
    notify.pushDecision({ type: 'approve' }); // Step

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    await orchestrator.submitAndRun('Git Test', TEST_REPO_DIR);

    // Verify commitChanges was called
    expect(gitAdapter.commitChanges).toHaveBeenCalled();
    const commitCall = vi.mocked(gitAdapter.commitChanges).mock.calls[0];
    expect(commitCall[1]).toBe('step 1'); // "Step 1" -> "step 1" (lowercase, no period)

    // Verify pushBranch was called
    expect(gitAdapter.pushBranch).toHaveBeenCalled();

    // Verify createPullRequest was called
    expect(gitAdapter.createPullRequest).toHaveBeenCalled();
    
    // Verify notification received PR URL
    expect(notify.lastCompletionPrUrl).toBe('https://github.com/owner/repo/pull/1');
  });

  it('should handle GhCliNotConfiguredError gracefully', async () => {
    // Mock createPullRequest to throw GhCliNotConfiguredError
    vi.mocked(gitAdapter.createPullRequest).mockImplementationOnce(() => {
        throw new gitAdapter.GhCliNotConfiguredError('Not configured');
    });

    const config = createTestConfig(dbPath);
    const llm = new MockLLMAdapter();
    const notify = new MockNotificationChannel();
    const sandbox = new MockSandboxRunner();

    notify.pushDecision({ type: 'approve' }); // Plan
    notify.pushDecision({ type: 'approve' }); // Step

    const orchestrator = new TaskOrchestrator(llm, store, notify, sandbox, config);
    const task = await orchestrator.submitAndRun('Git Test Fail', TEST_REPO_DIR);

    // Should complete successfully even if PR fails
    expect(task.state).toBe(TaskState.COMPLETED);
    
    // Check notification didn't crash and maybe didn't strictly have PR URL (or handled it)
    // The implementation handles it by sending notification with undefined PR url and a message
    // We can't check the message content easily in this mock without updating mock, 
    // but the fact it finished COMPLETED is good.
    expect(gitAdapter.pushBranch).toHaveBeenCalled(); // Push still happens
    expect(gitAdapter.createPullRequest).toHaveBeenCalled();
  });
});
