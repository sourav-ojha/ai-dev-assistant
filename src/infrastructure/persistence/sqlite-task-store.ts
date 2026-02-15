/**
 * SQLite implementation of ITaskStore.
 * Uses better-sqlite3 (synchronous, fast, zero-config).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ITaskStore } from '../../core/ports/task-store.js';
import type { Task, TaskState, TaskTransitionLog } from '../../core/entities/task.js';
import type { Plan, PlanStep } from '../../core/entities/plan.js';
import type { LLMCallRecord } from '../../core/entities/token-budget.js';
import { runMigrations } from './migrations.js';

export class SQLiteTaskStore implements ITaskStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    runMigrations(this.db);
  }

  createTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, goal, state, repo_url, feature_branch, current_step_index, total_steps, tokens_in, tokens_out, call_count, failure_reason, created_at, updated_at)
      VALUES (@id, @goal, @state, @repoUrl, @featureBranch, @currentStepIndex, @totalSteps, @tokensIn, @tokensOut, @callCount, @failureReason, @createdAt, @updatedAt)
    `).run({
      id: task.id,
      goal: task.goal,
      state: task.state,
      repoUrl: task.repoUrl,
      featureBranch: task.featureBranch,
      currentStepIndex: task.currentStepIndex,
      totalSteps: task.totalSteps,
      tokensIn: task.tokenUsage.totalTokensIn,
      tokensOut: task.tokenUsage.totalTokensOut,
      callCount: task.tokenUsage.callCount,
      failureReason: task.failureReason,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  updateTask(task: Task): void {
    this.db.prepare(`
      UPDATE tasks SET
        state = @state,
        feature_branch = @featureBranch,
        current_step_index = @currentStepIndex,
        total_steps = @totalSteps,
        tokens_in = @tokensIn,
        tokens_out = @tokensOut,
        call_count = @callCount,
        failure_reason = @failureReason,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: task.id,
      state: task.state,
      featureBranch: task.featureBranch,
      currentStepIndex: task.currentStepIndex,
      totalSteps: task.totalSteps,
      tokensIn: task.tokenUsage.totalTokensIn,
      tokensOut: task.tokenUsage.totalTokensOut,
      callCount: task.tokenUsage.callCount,
      failureReason: task.failureReason,
      updatedAt: task.updatedAt,
    });
  }

  listTasks(filter?: { states?: TaskState[] }): Task[] {
    if (filter?.states?.length) {
      const placeholders = filter.states.map(() => '?').join(', ');
      const rows = this.db.prepare(`SELECT * FROM tasks WHERE state IN (${placeholders}) ORDER BY created_at DESC`).all(...filter.states) as TaskRow[];
      return rows.map(rowToTask);
    }
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]).map(rowToTask);
  }

  savePlan(plan: Plan): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO plans (task_id, summary, steps_json, estimated_tokens, created_at)
      VALUES (@taskId, @summary, @stepsJson, @estimatedTokens, @createdAt)
    `).run({
      taskId: plan.taskId,
      summary: plan.summary,
      stepsJson: JSON.stringify(plan.steps),
      estimatedTokens: plan.estimatedTokens,
      createdAt: plan.createdAt,
    });
  }

  getPlan(taskId: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE task_id = ?').get(taskId) as PlanRow | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      summary: row.summary,
      steps: JSON.parse(row.steps_json) as PlanStep[],
      estimatedTokens: row.estimated_tokens,
      createdAt: row.created_at,
    };
  }

  logTransition(log: TaskTransitionLog): void {
    this.db.prepare(`
      INSERT INTO transition_logs (id, task_id, from_state, to_state, reason, metadata, timestamp)
      VALUES (@id, @taskId, @fromState, @toState, @reason, @metadata, @timestamp)
    `).run(log);
  }

  getTransitionLogs(taskId: string): TaskTransitionLog[] {
    return this.db.prepare('SELECT * FROM transition_logs WHERE task_id = ? ORDER BY timestamp ASC').all(taskId) as TaskTransitionLog[];
  }

  logLLMCall(record: LLMCallRecord): void {
    this.db.prepare(`
      INSERT INTO llm_calls (task_id, step_index, call_type, tokens_in, tokens_out, model, duration_ms, timestamp)
      VALUES (@taskId, @stepIndex, @callType, @tokensIn, @tokensOut, @model, @durationMs, @timestamp)
    `).run(record);
  }

  getLLMCalls(taskId: string): LLMCallRecord[] {
    return this.db.prepare('SELECT * FROM llm_calls WHERE task_id = ? ORDER BY timestamp ASC').all(taskId) as LLMCallRecord[];
  }

  close(): void {
    this.db.close();
  }
}

// === Row types (DB shape) ===

interface TaskRow {
  id: string;
  goal: string;
  state: string;
  repo_url: string;
  feature_branch: string | null;
  current_step_index: number;
  total_steps: number;
  tokens_in: number;
  tokens_out: number;
  call_count: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  task_id: string;
  summary: string;
  steps_json: string;
  estimated_tokens: number;
  created_at: string;
}

const rowToTask = (row: TaskRow): Task => ({
  id: row.id,
  goal: row.goal,
  state: row.state as TaskState,
  repoUrl: row.repo_url,
  featureBranch: row.feature_branch,
  currentStepIndex: row.current_step_index,
  totalSteps: row.total_steps,
  tokenUsage: {
    totalTokensIn: row.tokens_in,
    totalTokensOut: row.tokens_out,
    callCount: row.call_count,
  },
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
