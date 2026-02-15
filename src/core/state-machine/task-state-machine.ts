/**
 * Central state machine — the ONLY place state transitions happen.
 * Every transition flows through `transition()`. No exceptions.
 *
 * Responsibilities:
 * - Validate transition legality
 * - Update task state
 * - Create transition log entry
 * - Persist both via the store callback
 */

import { Task, TaskState, TERMINAL_STATES, TaskTransitionLog } from '../entities/task.js';
import { isValidTransition } from './transitions.js';
import { randomUUID } from 'node:crypto';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
    public readonly taskId: string,
  ) {
    super(`Invalid transition: ${from} → ${to} (task: ${taskId})`);
    this.name = 'InvalidTransitionError';
  }
}

export interface TransitionResult {
  task: Task;
  log: TaskTransitionLog;
}

export interface TransitionOptions {
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Single transition handler. All state changes go through here.
 *
 * @param task - Current task snapshot
 * @param to - Target state
 * @param options - Reason and optional metadata
 * @returns Updated task and the transition log entry
 * @throws InvalidTransitionError if the transition is not allowed
 */
export const transition = (
  task: Task,
  to: TaskState,
  options: TransitionOptions,
): TransitionResult => {
  if (TERMINAL_STATES.has(task.state)) {
    throw new InvalidTransitionError(task.state, to, task.id);
  }

  if (!isValidTransition(task.state, to)) {
    throw new InvalidTransitionError(task.state, to, task.id);
  }

  const now = new Date().toISOString();

  const log: TaskTransitionLog = {
    id: randomUUID(),
    taskId: task.id,
    fromState: task.state,
    toState: to,
    reason: options.reason,
    metadata: options.metadata ? JSON.stringify(options.metadata) : null,
    timestamp: now,
  };

  const updatedTask: Task = {
    ...task,
    state: to,
    updatedAt: now,
  };

  return { task: updatedTask, log };
};
