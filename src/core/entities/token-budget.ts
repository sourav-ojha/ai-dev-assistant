/**
 * Token budget — first-class domain concept, not logging.
 * Enforced per-call and per-task. Exceeding budget = task pauses.
 */

export const TOKEN_BUDGET = {
  /** Hard ceiling per task (input + output tokens combined). */
  PER_TASK_MAX: 50_000,

  /** Max output tokens for a planning call. */
  PER_PLANNING_CALL_OUT: 8_000,

  /** Max output tokens for a code generation step. */
  PER_CODE_GEN_STEP_OUT: 4_000,

  /** Max output tokens for a summarization call. */
  PER_SUMMARY_CALL_OUT: 1_000,
} as const;

export type LLMCallType = 'planning' | 'code_generation' | 'summarization';

export interface LLMCallRecord {
  taskId: string;
  stepIndex: number | null;
  callType: LLMCallType;
  tokensIn: number;
  tokensOut: number;
  model: string;
  durationMs: number;
  timestamp: string; // ISO 8601
}

/**
 * Check if a task has remaining budget for a new LLM call.
 * Returns the remaining tokens or a negative number if over budget.
 */
export const remainingBudget = (
  currentUsageIn: number,
  currentUsageOut: number,
  maxBudget: number = TOKEN_BUDGET.PER_TASK_MAX,
): number => maxBudget - (currentUsageIn + currentUsageOut);

/**
 * Get the max output tokens allowed for a given call type.
 */
export const maxOutputTokensFor = (callType: LLMCallType): number => {
  switch (callType) {
    case 'planning': return TOKEN_BUDGET.PER_PLANNING_CALL_OUT;
    case 'code_generation': return TOKEN_BUDGET.PER_CODE_GEN_STEP_OUT;
    case 'summarization': return TOKEN_BUDGET.PER_SUMMARY_CALL_OUT;
  }
};

/**
 * Check if a proposed call would exceed the task budget.
 */
export const wouldExceedBudget = (
  currentUsageIn: number,
  currentUsageOut: number,
  estimatedNewTokens: number,
  maxBudget: number = TOKEN_BUDGET.PER_TASK_MAX,
): boolean => (currentUsageIn + currentUsageOut + estimatedNewTokens) > maxBudget;
