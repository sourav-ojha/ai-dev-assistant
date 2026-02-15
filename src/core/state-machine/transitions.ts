/**
 * All valid state transitions — single source of truth.
 * No ad-hoc transitions. Every transition goes through this map.
 */

import { TaskState } from '../entities/task.js';

/**
 * Map of current state → set of valid next states.
 * If a transition is not listed here, it is illegal.
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  [TaskState.SUBMITTED]: new Set([
    TaskState.PLANNING,
  ]),

  [TaskState.PLANNING]: new Set([
    TaskState.AWAITING_PLAN_APPROVAL,
    TaskState.PAUSED_ON_FAILURE, // planning LLM call failed or budget exceeded
  ]),

  [TaskState.AWAITING_PLAN_APPROVAL]: new Set([
    TaskState.EXECUTING_STEP,    // approved
    TaskState.REJECTED,          // user rejected the plan
    TaskState.ABORTED,           // user chose to abort
  ]),

  [TaskState.EXECUTING_STEP]: new Set([
    TaskState.CHECKPOINT,              // step completed successfully
    TaskState.STEP_FAILED,             // step execution error
    TaskState.AWAITING_SCOPE_APPROVAL,  // file scope violation — ask user allow/revise
  ]),

  [TaskState.CHECKPOINT]: new Set([
    TaskState.AWAITING_STEP_APPROVAL,
  ]),

  [TaskState.AWAITING_STEP_APPROVAL]: new Set([
    TaskState.EXECUTING_STEP,    // approved, more steps remain
    TaskState.COMPLETED,         // approved, was the last step
    TaskState.ABORTED,           // user chose to abort
  ]),

  [TaskState.STEP_FAILED]: new Set([
    TaskState.PAUSED_ON_FAILURE,
  ]),

  [TaskState.PAUSED_ON_FAILURE]: new Set([
    TaskState.AWAITING_FAILURE_GUIDANCE,
  ]),

  [TaskState.AWAITING_FAILURE_GUIDANCE]: new Set([
    TaskState.EXECUTING_STEP,    // retry current step or skip to next
    TaskState.ABORTED,           // user chose to abort
  ]),

  [TaskState.AWAITING_SCOPE_APPROVAL]: new Set([
    TaskState.CHECKPOINT,        // user allowed out-of-scope changes — proceed
    TaskState.EXECUTING_STEP,    // user chose revise — retry step with strict scope
    TaskState.ABORTED,           // user chose to abort
  ]),

  // Terminal states — no outgoing transitions
  [TaskState.COMPLETED]: new Set(),
  [TaskState.ABORTED]: new Set(),
  [TaskState.REJECTED]: new Set(),
};

/**
 * Check if a transition from `from` to `to` is valid.
 */
export const isValidTransition = (from: TaskState, to: TaskState): boolean =>
  VALID_TRANSITIONS[from].has(to);
