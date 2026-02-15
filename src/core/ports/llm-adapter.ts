/**
 * Port: LLM adapter.
 * Single interface for all LLM operations (v1 = one model does everything).
 */

import type { Plan, PlanStep } from '../entities/plan.js';

export interface FileContext {
  path: string;
  content: string;
}

export interface PlanGenerationResult {
  plan: Plan;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface CodeGenerationResult {
  /** The generated code as a unified diff or full file content. */
  code: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface SummarizationResult {
  summary: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface ILLMAdapter {
  /**
   * Generate a structured plan from a goal description.
   * Returns a Plan with steps, each defining file scope boundaries.
   */
  generatePlan(
    goal: string,
    repoStructure: string,
    skillContext?: string,
  ): Promise<PlanGenerationResult>;

  /**
   * Generate code changes for a single plan step.
   * Input is the step instruction + relevant file contents (scoped).
   */
  generateCode(
    step: PlanStep,
    fileContents: FileContext[],
    planSummary: string,
  ): Promise<CodeGenerationResult>;

  /**
   * Summarize a diff and test results into a concise Telegram-friendly message.
   */
  summarize(
    diff: string,
    testResults: string,
    stepTitle: string,
  ): Promise<SummarizationResult>;
}
