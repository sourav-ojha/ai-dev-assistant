/**
 * Mock LLM adapter — returns canned responses without calling any API.
 * Use for testing the orchestration flow (Telegram, Docker, state machine) without LLM costs.
 *
 * Set LLM_PROVIDER=mock to use.
 */

import type { ILLMAdapter, FileContext, PlanGenerationResult, CodeGenerationResult, SummarizationResult } from '../../core/ports/llm-adapter.js';
import type { Plan, PlanStep } from '../../core/entities/plan.js';
import { StepStatus } from '../../core/entities/plan.js';
import { createPlanStep } from '../../core/entities/plan.js';
import { createLogger } from '../logger.js';

const log = createLogger('mock-llm');

export class MockLLMAdapter implements ILLMAdapter {
  async generatePlan(goal: string, repoStructure: string): Promise<PlanGenerationResult> {
    log.info({ goal }, 'Mock: generating plan');

    const plan: Plan = {
      taskId: '',
      summary: `Mock plan for: ${goal}`,
      estimatedTokens: 2000,
      steps: [
        createPlanStep(
          0,
          'Create README.md',
          'Add a README with project info',
          'Create README.md with title and description',
          ['README.md'],
          { newFilesAllowed: true },
        ),
      ],
      createdAt: new Date().toISOString(),
    };

    return {
      plan,
      tokensIn: 200,
      tokensOut: 100,
      durationMs: 50,
    };
  }

  async generateCode(
    step: PlanStep,
    fileContents: FileContext[],
    planSummary: string,
  ): Promise<CodeGenerationResult> {
    log.info({ step: step.index, title: step.title }, 'Mock: generating code');

    const code = `--- FILE: README.md ---
# Project

This is a mock-generated README.
Created by step: ${step.title}
--- END FILE ---`;

    return {
      code,
      tokensIn: 150,
      tokensOut: 80,
      durationMs: 30,
    };
  }

  async summarize(diff: string, testResults: string, stepTitle: string): Promise<SummarizationResult> {
    log.info({ stepTitle }, 'Mock: summarizing');

    return {
      summary: `Step "${stepTitle}" completed. Files modified. Tests: ${testResults ? 'ran' : 'none'}.`,
      tokensIn: 50,
      tokensOut: 30,
      durationMs: 20,
    };
  }
}
