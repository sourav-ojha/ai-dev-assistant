/**
 * Core task entity — the unit of work in the system.
 * Pure domain. Zero external dependencies.
 */

export enum TaskState {
  SUBMITTED = 'SUBMITTED',
  PLANNING = 'PLANNING',
  AWAITING_PLAN_APPROVAL = 'AWAITING_PLAN_APPROVAL',
  EXECUTING_STEP = 'EXECUTING_STEP',
  CHECKPOINT = 'CHECKPOINT',
  AWAITING_STEP_APPROVAL = 'AWAITING_STEP_APPROVAL',
  STEP_FAILED = 'STEP_FAILED',
  PAUSED_ON_FAILURE = 'PAUSED_ON_FAILURE',
  AWAITING_FAILURE_GUIDANCE = 'AWAITING_FAILURE_GUIDANCE',
  AWAITING_SCOPE_APPROVAL = 'AWAITING_SCOPE_APPROVAL',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  REJECTED = 'REJECTED',
}

/** Terminal states — no further transitions possible. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
  TaskState.ABORTED,
  TaskState.REJECTED,
]);

export interface Task {
  id: string;
  goal: string;
  state: TaskState;
  repoUrl: string;
  featureBranch: string | null;
  currentStepIndex: number;
  totalSteps: number;
  tokenUsage: TokenUsage;
  failureReason: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface TokenUsage {
  totalTokensIn: number;
  totalTokensOut: number;
  callCount: number;
}

export interface TaskTransitionLog {
  id: string;
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  reason: string;
  metadata: string | null; // JSON string for extra context
  timestamp: string; // ISO 8601
}

export const createTask = (id: string, goal: string, repoUrl: string): Task => ({
  id,
  goal,
  state: TaskState.SUBMITTED,
  repoUrl,
  featureBranch: null,
  currentStepIndex: 0,
  totalSteps: 0,
  tokenUsage: { totalTokensIn: 0, totalTokensOut: 0, callCount: 0 },
  failureReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
