/**
 * Port: Notification channel (Telegram in v1).
 * Sends messages and receives approval decisions.
 */

import type { Task } from '../entities/task.js';
import type { Plan, PlanStep } from '../entities/plan.js';
import type { ScopeExtensionJustification } from '../validation/file-scope-validator.js';

export type ApprovalDecision =
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'abort' }
  | { type: 'retry' }
  | { type: 'skip' }
  | { type: 'fix' }
  | { type: 'modify'; feedback: string }
  | { type: 'allow_scope' }
  | { type: 'revise_scope' };

export interface StepResultPayload {
  step: PlanStep;
  diff: string;
  testResults: string;
  summary: string;
  tokensUsed: number;
  totalTokensUsed: number;
  budgetRemaining: number;
}

export interface INotificationChannel {
  /** Send a plan to the user for approval. Returns when message is sent. */
  sendPlanForApproval(task: Task, plan: Plan): Promise<void>;

  /** Send step execution results for approval. */
  sendStepResult(task: Task, result: StepResultPayload): Promise<void>;

  /** Send a failure report. */
  sendFailureReport(task: Task, reason: string, stepIndex?: number): Promise<void>;

  /** Ask user whether to allow file-scope violation and proceed, or revise the plan. */
  sendScopeViolationForApproval(
    task: Task,
    reason: string,
    allowedFiles: string[],
    modifiedFiles: string[],
    stepIndex: number,
    /** Per-file justification: what changes and why (for out-of-scope files). */
    justifications?: ScopeExtensionJustification[],
  ): Promise<void>;

  /** Notify user that token budget was exceeded; progress is saved, they can increase budget and resume or abort. */
  sendBudgetExceeded(task: Task, totalUsed: number, budgetLimit: number): Promise<void>;

  /** Send a generic status message. */
  sendStatus(task: Task, message: string): Promise<void>;

  /** Send task completion summary. */
  sendCompletion(task: Task, totalTokens: number, totalSteps: number): Promise<void>;

  /**
   * Wait for a user decision on a specific task.
   * Blocks until the user responds via Telegram inline keyboard.
   */
  waitForDecision(taskId: string): Promise<ApprovalDecision>;

  /** Start the bot (webhook or polling). */
  start(): Promise<void>;

  /** Stop the bot gracefully. */
  stop(): Promise<void>;
}
