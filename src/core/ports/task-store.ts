/**
 * Port: Task persistence.
 * Stores tasks, plans, transition logs, and token usage records.
 */

import type { Task, TaskState, TaskTransitionLog } from '../entities/task.js';
import type { Plan } from '../entities/plan.js';
import type { LLMCallRecord } from '../entities/token-budget.js';

export interface ITaskStore {
  // === Task CRUD ===
  createTask(task: Task): void;
  getTask(id: string): Task | null;
  updateTask(task: Task): void;
  listTasks(filter?: { states?: TaskState[] }): Task[];

  // === Plan storage ===
  savePlan(plan: Plan): void;
  getPlan(taskId: string): Plan | null;

  // === Transition log ===
  logTransition(log: TaskTransitionLog): void;
  getTransitionLogs(taskId: string): TaskTransitionLog[];

  // === Token usage ===
  logLLMCall(record: LLMCallRecord): void;
  getLLMCalls(taskId: string): LLMCallRecord[];
}
