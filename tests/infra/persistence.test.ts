/**
 * Tests for SQLite persistence — task CRUD, plans, transitions, LLM calls.
 * Uses a temporary in-memory (file-based tmp) database.
 * No AI API calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteTaskStore } from '../../src/infrastructure/persistence/sqlite-task-store.js';
import { TaskState, createTask } from '../../src/core/entities/task.js';
import type { TaskTransitionLog } from '../../src/core/entities/task.js';
import type { Plan } from '../../src/core/entities/plan.js';
import { StepStatus, createPlanStep } from '../../src/core/entities/plan.js';
import type { LLMCallRecord } from '../../src/core/entities/token-budget.js';
import { randomUUID } from 'node:crypto';

const WORKSPACE_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const TEST_DB_DIR = join(WORKSPACE_ROOT, '.test-tmp', 'db');
let store: SQLiteTaskStore;
let dbPath: string;

beforeEach(() => {
  mkdirSync(TEST_DB_DIR, { recursive: true });
  dbPath = join(TEST_DB_DIR, `test-${randomUUID()}.db`);
  store = new SQLiteTaskStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dbPath, { force: true });
});

describe('SQLite — Task CRUD', () => {
  it('should create and retrieve a task', () => {
    const task = createTask('task-1', 'Test goal', 'https://github.com/test/repo');
    store.createTask(task);

    const retrieved = store.getTask('task-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('task-1');
    expect(retrieved!.goal).toBe('Test goal');
    expect(retrieved!.state).toBe(TaskState.SUBMITTED);
    expect(retrieved!.repoUrl).toBe('https://github.com/test/repo');
  });

  it('should update a task', () => {
    const task = createTask('task-2', 'Update test', 'https://github.com/test/repo');
    store.createTask(task);

    const updated = {
      ...task,
      state: TaskState.PLANNING,
      featureBranch: 'ai/task-2/update-test',
      totalSteps: 3,
      updatedAt: new Date().toISOString(),
    };
    store.updateTask(updated);

    const retrieved = store.getTask('task-2');
    expect(retrieved!.state).toBe(TaskState.PLANNING);
    expect(retrieved!.featureBranch).toBe('ai/task-2/update-test');
    expect(retrieved!.totalSteps).toBe(3);
  });

  it('should return null for non-existent task', () => {
    expect(store.getTask('nonexistent')).toBeNull();
  });

  it('should list all tasks', () => {
    store.createTask(createTask('task-a', 'A', 'url'));
    store.createTask(createTask('task-b', 'B', 'url'));

    const tasks = store.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it('should list tasks filtered by state', () => {
    const taskA = createTask('task-a', 'A', 'url');
    const taskB = { ...createTask('task-b', 'B', 'url'), state: TaskState.COMPLETED };

    store.createTask(taskA);
    store.createTask(taskB);

    const active = store.listTasks({ states: [TaskState.SUBMITTED] });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('task-a');

    const terminal = store.listTasks({ states: [TaskState.COMPLETED] });
    expect(terminal).toHaveLength(1);
    expect(terminal[0].id).toBe('task-b');
  });
});

describe('SQLite — Plan Storage', () => {
  it('should save and retrieve a plan', () => {
    const task = createTask('plan-task-1', 'Plan test', 'url');
    store.createTask(task);

    const plan: Plan = {
      taskId: 'plan-task-1',
      summary: 'Add a readme file',
      estimatedTokens: 5000,
      steps: [
        createPlanStep(0, 'Create README', 'Create a README.md file', 'Write README.md with project info', ['README.md'], { newFilesAllowed: true }),
        createPlanStep(1, 'Update package.json', 'Add description', 'Update description field', ['package.json']),
      ],
      createdAt: new Date().toISOString(),
    };
    store.savePlan(plan);

    const retrieved = store.getPlan('plan-task-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.summary).toBe('Add a readme file');
    expect(retrieved!.steps).toHaveLength(2);
    expect(retrieved!.steps[0].title).toBe('Create README');
    expect(retrieved!.steps[0].allowedFiles).toEqual(['README.md']);
    expect(retrieved!.steps[0].newFilesAllowed).toBe(true);
    expect(retrieved!.steps[1].title).toBe('Update package.json');
  });

  it('should return null for non-existent plan', () => {
    expect(store.getPlan('nonexistent')).toBeNull();
  });

  it('should overwrite plan on re-save (upsert)', () => {
    const task = createTask('plan-task-2', 'Upsert test', 'url');
    store.createTask(task);

    const plan1: Plan = {
      taskId: 'plan-task-2',
      summary: 'Version 1',
      estimatedTokens: 1000,
      steps: [],
      createdAt: new Date().toISOString(),
    };
    store.savePlan(plan1);

    const plan2: Plan = {
      ...plan1,
      summary: 'Version 2',
      steps: [createPlanStep(0, 'New step', 'desc', 'instruction', ['file.ts'])],
    };
    store.savePlan(plan2);

    const retrieved = store.getPlan('plan-task-2');
    expect(retrieved!.summary).toBe('Version 2');
    expect(retrieved!.steps).toHaveLength(1);
  });
});

describe('SQLite — Transition Logs', () => {
  it('should log and retrieve transitions', () => {
    const task = createTask('log-task-1', 'Log test', 'url');
    store.createTask(task);

    const log1: TaskTransitionLog = {
      id: randomUUID(),
      taskId: 'log-task-1',
      fromState: TaskState.SUBMITTED,
      toState: TaskState.PLANNING,
      reason: 'Start planning',
      metadata: null,
      timestamp: new Date().toISOString(),
    };

    const log2: TaskTransitionLog = {
      id: randomUUID(),
      taskId: 'log-task-1',
      fromState: TaskState.PLANNING,
      toState: TaskState.AWAITING_PLAN_APPROVAL,
      reason: 'Plan generated',
      metadata: JSON.stringify({ tokens: 500 }),
      timestamp: new Date().toISOString(),
    };

    store.logTransition(log1);
    store.logTransition(log2);

    const logs = store.getTransitionLogs('log-task-1');
    expect(logs).toHaveLength(2);
    expect(logs[0].fromState).toBe(TaskState.SUBMITTED);
    expect(logs[1].toState).toBe(TaskState.AWAITING_PLAN_APPROVAL);
  });
});

describe('SQLite — LLM Call Logging', () => {
  it('should log and retrieve LLM calls', () => {
    const task = createTask('llm-task-1', 'LLM test', 'url');
    store.createTask(task);

    const record: LLMCallRecord = {
      taskId: 'llm-task-1',
      stepIndex: 0,
      callType: 'code_generation',
      tokensIn: 300,
      tokensOut: 150,
      model: 'claude-sonnet-4-20250514',
      durationMs: 2500,
      timestamp: new Date().toISOString(),
    };

    store.logLLMCall(record);

    const calls = store.getLLMCalls('llm-task-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].tokensIn).toBe(300);
    expect(calls[0].callType).toBe('code_generation');
  });
});
