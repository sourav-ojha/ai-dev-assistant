/**
 * Port: Sandbox execution environment (Docker in v1).
 * Each step runs in an isolated container.
 */

import type { PlanStep } from '../entities/plan.js';

export interface SandboxConfig {
  repoUrl: string;
  branch: string;
  timeoutSec: number;
  memoryMb: number;
  cpuCount: number;
}

export interface StepExecutionResult {
  success: boolean;
  diff: string;
  testOutput: string;
  testsPassed: boolean;
  filesModified: string[];
  linesChanged: number;
  exitCode: number;
  durationMs: number;
  error?: string;
}

export interface ISandboxRunner {
  /**
   * Execute a single step's code changes inside an isolated container.
   *
   * Flow:
   * 1. Clone repo + checkout branch
   * 2. Apply generated code changes
   * 3. Run tests
   * 4. Collect diff + test results
   * 5. Destroy container
   */
  executeStep(
    step: PlanStep,
    generatedCode: string,
    config: SandboxConfig,
  ): Promise<StepExecutionResult>;
}
