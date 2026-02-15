/**
 * Plan and step entities.
 * A plan is the structured breakdown of a task goal into executable steps.
 * Each step defines strict file scope boundaries — no exceptions.
 */

export interface PlanStep {
  index: number;
  title: string;
  description: string;
  instruction: string; // Precise instruction for code generation

  // === File scope enforcement (critical) ===
  allowedFiles: string[];      // Exact file paths allowed to be modified
  allowedGlobs: string[];      // Optional glob patterns (e.g., "src/components/*.tsx")
  newFilesAllowed: boolean;    // Whether this step can create new files

  // === Optional skill ===
  skillId: string | null;      // Max 1 skill per step (v1)

  // === Results (populated after execution) ===
  status: StepStatus;
  diff: string | null;
  testResults: string | null;
  tokensUsed: number;
}

export enum StepStatus {
  PENDING = 'PENDING',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export interface Plan {
  taskId: string;
  summary: string;
  steps: PlanStep[];
  estimatedTokens: number;
  createdAt: string; // ISO 8601
}

/** Helper: create a fresh plan step with defaults. */
export const createPlanStep = (
  index: number,
  title: string,
  description: string,
  instruction: string,
  allowedFiles: string[],
  opts?: Partial<Pick<PlanStep, 'allowedGlobs' | 'newFilesAllowed' | 'skillId'>>,
): PlanStep => ({
  index,
  title,
  description,
  instruction,
  allowedFiles,
  allowedGlobs: opts?.allowedGlobs ?? [],
  newFilesAllowed: opts?.newFilesAllowed ?? false,
  skillId: opts?.skillId ?? null,
  status: StepStatus.PENDING,
  diff: null,
  testResults: null,
  tokensUsed: 0,
});
