/**
 * Tests for the state machine — validates all transitions are correct.
 * No external dependencies. Pure domain logic.
 */

import { describe, it, expect } from 'vitest';
import { TaskState, createTask } from '../../src/core/entities/task.js';
import { transition, InvalidTransitionError } from '../../src/core/state-machine/task-state-machine.js';
import { isValidTransition, VALID_TRANSITIONS } from '../../src/core/state-machine/transitions.js';

describe('State Machine — Transition Validation', () => {
  it('should allow SUBMITTED → PLANNING', () => {
    expect(isValidTransition(TaskState.SUBMITTED, TaskState.PLANNING)).toBe(true);
  });

  it('should allow PLANNING → AWAITING_PLAN_APPROVAL', () => {
    expect(isValidTransition(TaskState.PLANNING, TaskState.AWAITING_PLAN_APPROVAL)).toBe(true);
  });

  it('should allow PLANNING → PAUSED_ON_FAILURE', () => {
    expect(isValidTransition(TaskState.PLANNING, TaskState.PAUSED_ON_FAILURE)).toBe(true);
  });

  it('should allow AWAITING_PLAN_APPROVAL → EXECUTING_STEP (approve)', () => {
    expect(isValidTransition(TaskState.AWAITING_PLAN_APPROVAL, TaskState.EXECUTING_STEP)).toBe(true);
  });

  it('should allow AWAITING_PLAN_APPROVAL → REJECTED', () => {
    expect(isValidTransition(TaskState.AWAITING_PLAN_APPROVAL, TaskState.REJECTED)).toBe(true);
  });

  it('should allow AWAITING_PLAN_APPROVAL → ABORTED', () => {
    expect(isValidTransition(TaskState.AWAITING_PLAN_APPROVAL, TaskState.ABORTED)).toBe(true);
  });

  it('should allow EXECUTING_STEP → CHECKPOINT', () => {
    expect(isValidTransition(TaskState.EXECUTING_STEP, TaskState.CHECKPOINT)).toBe(true);
  });

  it('should allow EXECUTING_STEP → STEP_FAILED', () => {
    expect(isValidTransition(TaskState.EXECUTING_STEP, TaskState.STEP_FAILED)).toBe(true);
  });

  it('should allow STEP_FAILED → PAUSED_ON_FAILURE', () => {
    expect(isValidTransition(TaskState.STEP_FAILED, TaskState.PAUSED_ON_FAILURE)).toBe(true);
  });

  it('should allow PAUSED_ON_FAILURE → AWAITING_FAILURE_GUIDANCE', () => {
    expect(isValidTransition(TaskState.PAUSED_ON_FAILURE, TaskState.AWAITING_FAILURE_GUIDANCE)).toBe(true);
  });

  it('should allow AWAITING_FAILURE_GUIDANCE → EXECUTING_STEP (retry)', () => {
    expect(isValidTransition(TaskState.AWAITING_FAILURE_GUIDANCE, TaskState.EXECUTING_STEP)).toBe(true);
  });

  it('should allow AWAITING_FAILURE_GUIDANCE → ABORTED', () => {
    expect(isValidTransition(TaskState.AWAITING_FAILURE_GUIDANCE, TaskState.ABORTED)).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(isValidTransition(TaskState.SUBMITTED, TaskState.COMPLETED)).toBe(false);
    expect(isValidTransition(TaskState.PLANNING, TaskState.EXECUTING_STEP)).toBe(false);
    expect(isValidTransition(TaskState.EXECUTING_STEP, TaskState.COMPLETED)).toBe(false);
  });

  it('should reject transitions from terminal states', () => {
    expect(isValidTransition(TaskState.COMPLETED, TaskState.SUBMITTED)).toBe(false);
    expect(isValidTransition(TaskState.ABORTED, TaskState.PLANNING)).toBe(false);
    expect(isValidTransition(TaskState.REJECTED, TaskState.EXECUTING_STEP)).toBe(false);
  });
});

describe('State Machine — transition() function', () => {
  it('should transition and return updated task + log', () => {
    const task = createTask('test-1', 'Test goal', 'https://github.com/test/repo');

    const result = transition(task, TaskState.PLANNING, { reason: 'Start planning' });

    expect(result.task.state).toBe(TaskState.PLANNING);
    expect(result.task.id).toBe('test-1');
    expect(result.log.fromState).toBe(TaskState.SUBMITTED);
    expect(result.log.toState).toBe(TaskState.PLANNING);
    expect(result.log.reason).toBe('Start planning');
    expect(result.log.taskId).toBe('test-1');
  });

  it('should chain through the full happy-path lifecycle', () => {
    let task = createTask('test-2', 'Happy path', 'https://github.com/test/repo');
    const logs: string[] = [];

    // SUBMITTED → PLANNING
    let result = transition(task, TaskState.PLANNING, { reason: 'Planning' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    // PLANNING → AWAITING_PLAN_APPROVAL
    result = transition(task, TaskState.AWAITING_PLAN_APPROVAL, { reason: 'Plan generated' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    // AWAITING_PLAN_APPROVAL → EXECUTING_STEP
    result = transition(task, TaskState.EXECUTING_STEP, { reason: 'Plan approved' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    // EXECUTING_STEP → CHECKPOINT
    result = transition(task, TaskState.CHECKPOINT, { reason: 'Step done' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    // CHECKPOINT → AWAITING_STEP_APPROVAL
    result = transition(task, TaskState.AWAITING_STEP_APPROVAL, { reason: 'Awaiting approval' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    // AWAITING_STEP_APPROVAL → COMPLETED
    result = transition(task, TaskState.COMPLETED, { reason: 'All done' });
    task = result.task;
    logs.push(`${result.log.fromState} → ${result.log.toState}`);

    expect(task.state).toBe(TaskState.COMPLETED);
    expect(logs).toEqual([
      'SUBMITTED → PLANNING',
      'PLANNING → AWAITING_PLAN_APPROVAL',
      'AWAITING_PLAN_APPROVAL → EXECUTING_STEP',
      'EXECUTING_STEP → CHECKPOINT',
      'CHECKPOINT → AWAITING_STEP_APPROVAL',
      'AWAITING_STEP_APPROVAL → COMPLETED',
    ]);
  });

  it('should chain through failure → retry path', () => {
    let task = createTask('test-3', 'Failure path', 'https://github.com/test/repo');

    // Get to EXECUTING_STEP
    task = transition(task, TaskState.PLANNING, { reason: '' }).task;
    task = transition(task, TaskState.AWAITING_PLAN_APPROVAL, { reason: '' }).task;
    task = transition(task, TaskState.EXECUTING_STEP, { reason: '' }).task;

    // Fail
    task = transition(task, TaskState.STEP_FAILED, { reason: 'Tests failed' }).task;
    task = transition(task, TaskState.PAUSED_ON_FAILURE, { reason: 'Pausing' }).task;
    task = transition(task, TaskState.AWAITING_FAILURE_GUIDANCE, { reason: 'Waiting for guidance' }).task;

    // Retry
    task = transition(task, TaskState.EXECUTING_STEP, { reason: 'Retrying' }).task;
    expect(task.state).toBe(TaskState.EXECUTING_STEP);
  });

  it('should throw InvalidTransitionError for illegal transitions', () => {
    const task = createTask('test-4', 'Bad transition', 'https://github.com/test/repo');

    expect(() =>
      transition(task, TaskState.COMPLETED, { reason: 'Skip everything' })
    ).toThrow(InvalidTransitionError);
  });

  it('should throw when transitioning from a terminal state', () => {
    let task = createTask('test-5', 'Terminal', 'https://github.com/test/repo');
    task = transition(task, TaskState.PLANNING, { reason: '' }).task;
    task = transition(task, TaskState.AWAITING_PLAN_APPROVAL, { reason: '' }).task;
    task = transition(task, TaskState.REJECTED, { reason: 'Rejected' }).task;

    expect(() =>
      transition(task, TaskState.PLANNING, { reason: 'Try again' })
    ).toThrow(InvalidTransitionError);
  });

  it('should preserve metadata in transition log', () => {
    const task = createTask('test-6', 'Metadata', 'https://github.com/test/repo');
    const result = transition(task, TaskState.PLANNING, {
      reason: 'Starting',
      metadata: { attempt: 1, source: 'test' },
    });

    expect(result.log.metadata).toBe(JSON.stringify({ attempt: 1, source: 'test' }));
  });
});

describe('State Machine — VALID_TRANSITIONS completeness', () => {
  it('should have an entry for every TaskState', () => {
    for (const state of Object.values(TaskState)) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it('terminal states should have no outgoing transitions', () => {
    expect(VALID_TRANSITIONS[TaskState.COMPLETED].size).toBe(0);
    expect(VALID_TRANSITIONS[TaskState.ABORTED].size).toBe(0);
    expect(VALID_TRANSITIONS[TaskState.REJECTED].size).toBe(0);
  });
});
