/**
 * Claude adapter — single model for v1.
 * Handles planning, code generation, and summarization.
 * No model router. No fallback chains. One model does everything.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ILLMAdapter, FileContext, PlanGenerationResult, CodeGenerationResult, SummarizationResult, InvestigationResult } from '../../core/ports/llm-adapter.js';
import type { Plan, PlanStep } from '../../core/entities/plan.js';
import { StepStatus } from '../../core/entities/plan.js';
import { maxOutputTokensFor } from '../../core/entities/token-budget.js';
import { createLogger } from '../logger.js';

const log = createLogger('claude-adapter');

const MODEL = 'claude-sonnet-4-20250514';

export class ClaudeAdapter implements ILLMAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generatePlan(
    goal: string,
    repoStructure: string,
    skillContext?: string,
  ): Promise<PlanGenerationResult> {
    const systemPrompt = buildPlannerSystemPrompt();
    const userPrompt = buildPlannerUserPrompt(goal, repoStructure, skillContext);

    const start = Date.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxOutputTokensFor('planning'),
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const durationMs = Date.now() - start;
    const text = extractText(response);
    const plan = parsePlanFromJSON(text, ''); // taskId set by orchestrator

    log.info({ tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens, durationMs }, 'Plan generated');

    return {
      plan,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs,
    };
  }

  async generateCode(
    step: PlanStep,
    fileContents: FileContext[],
    planSummary: string,
  ): Promise<CodeGenerationResult> {
    const systemPrompt = buildCodeGenSystemPrompt();
    const userPrompt = buildCodeGenUserPrompt(step, fileContents, planSummary);

    const start = Date.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxOutputTokensFor('code_generation'),
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const durationMs = Date.now() - start;
    const code = extractText(response);

    log.info({ step: step.index, tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens, durationMs }, 'Code generated');

    return {
      code,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs,
    };
  }

  async summarize(
    diff: string,
    testResults: string,
    stepTitle: string,
  ): Promise<SummarizationResult> {
    const start = Date.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxOutputTokensFor('summarization'),
      system: 'You summarize code diffs and test results into concise Telegram messages. Use plain text, no markdown. Be brief — max 5 lines.',
      messages: [{
        role: 'user',
        content: `Step: ${stepTitle}\n\nDiff:\n${diff.slice(0, 3000)}\n\nTest Results:\n${testResults.slice(0, 2000)}\n\nSummarize in 3-5 lines for Telegram notification.`,
      }],
    });

    const durationMs = Date.now() - start;

    return {
      summary: extractText(response),
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs,
    };
  }

  async investigateFailure(
    step: PlanStep,
    failureReason: string,
    testOutput: string,
    fileContents: FileContext[],
    diff?: string,
  ): Promise<InvestigationResult> {
    const systemPrompt = `You are a senior developer investigating a failed build/test step.

OUTPUT FORMAT: Respond with ONLY a valid JSON object. No markdown, no code fences.
{
  "diagnosis": "1-3 sentences explaining why the step failed (root cause).",
  "revisedInstruction": "A concrete, revised instruction for the same step that will fix the failure. Same format as the original step instruction: clear, actionable, and scoped to the allowed files."
}

RULES:
- diagnosis: Be specific (e.g. missing import, wrong path, test expectation mismatch).
- revisedInstruction: Must be a single instruction the code generator can follow to produce a fix. Do not output code yourself.`;

    const fileContextStr = fileContents.length
      ? fileContents.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 3000)}\n`).join('\n')
      : '(no file context)';
    const userPrompt = `STEP: ${step.title}
ORIGINAL INSTRUCTION: ${step.instruction}
ALLOWED FILES: ${step.allowedFiles.join(', ')}

FAILURE REASON:
${failureReason.slice(0, 1500)}

TEST OUTPUT:
${testOutput.slice(0, 2000)}
${diff ? `\nDIFF (if any):\n${diff.slice(0, 1500)}` : ''}

CURRENT FILE CONTENTS:
${fileContextStr}

Provide diagnosis and revisedInstruction as JSON.`;

    const start = Date.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const durationMs = Date.now() - start;
    const text = extractText(response);
    const parsed = parseInvestigationJSON(text);

    log.info({ step: step.index, tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens, durationMs }, 'Investigation completed');

    return {
      diagnosis: parsed.diagnosis,
      revisedInstruction: parsed.revisedInstruction,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      durationMs,
    };
  }
}

// === Prompt builders ===

const buildPlannerSystemPrompt = (): string => `You are a senior software architect that creates structured development plans.

OUTPUT FORMAT: You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no code fences.

The JSON must follow this exact schema:
{
  "summary": "Brief description of the plan",
  "estimatedTokens": <number>,
  "steps": [
    {
      "index": <number starting from 0>,
      "title": "Step title",
      "description": "What this step does",
      "instruction": "Precise code generation instruction",
      "allowedFiles": ["exact/file/paths.ts"],
      "allowedGlobs": ["optional/glob/**/*.ts"],
      "newFilesAllowed": <boolean>,
      "skillId": null
    }
  ]
}

RULES:
- Each step must be small and focused (1-3 files max)
- allowedFiles must list EVERY file the step may modify
- instruction must be precise enough for code generation
- Steps must be ordered by dependency
- Include a test step after implementation steps where appropriate`;

const buildPlannerUserPrompt = (goal: string, repoStructure: string, skillContext?: string): string => {
  let prompt = `GOAL:\n${goal}\n\nREPO STRUCTURE:\n${repoStructure}`;
  if (skillContext) {
    prompt += `\n\nSKILL CONTEXT:\n${skillContext}`;
  }
  prompt += '\n\nGenerate a structured plan as JSON.';
  return prompt;
};

const buildCodeGenSystemPrompt = (): string => `You are a precise code generator. You output ONLY the code changes needed.

OUTPUT FORMAT: For each file, output the COMPLETE updated file content wrapped in markers:

--- FILE: path/to/file.ts ---
<complete file content>
--- END FILE ---

RULES:
- Output COMPLETE file contents (not diffs)
- Only modify files listed in the allowed scope
- Follow existing code style and conventions
- Include all necessary imports
- Do not add comments explaining what you changed`;

const buildCodeGenUserPrompt = (step: PlanStep, fileContents: FileContext[], planSummary: string): string => {
  let prompt = `PLAN CONTEXT: ${planSummary}\n\n`;
  prompt += `STEP ${step.index}: ${step.title}\n`;
  prompt += `INSTRUCTION: ${step.instruction}\n\n`;
  prompt += `ALLOWED FILES: ${step.allowedFiles.join(', ')}\n`;
  prompt += `NEW FILES ALLOWED: ${step.newFilesAllowed}\n\n`;

  if (fileContents.length > 0) {
    prompt += 'CURRENT FILE CONTENTS:\n\n';
    for (const fc of fileContents) {
      prompt += `--- ${fc.path} ---\n${fc.content}\n--- END ---\n\n`;
    }
  }

  prompt += 'Generate the code changes now.';
  return prompt;
};

// === Helpers ===

const extractText = (response: Anthropic.Message): string => {
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
};

const parsePlanFromJSON = (text: string, taskId: string): Plan => {
  // Strip markdown code fences if the model wraps output
  const cleaned = text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();

  const parsed = JSON.parse(cleaned);

  return {
    taskId,
    summary: parsed.summary ?? '',
    estimatedTokens: parsed.estimatedTokens ?? 0,
    steps: (parsed.steps ?? []).map((s: Record<string, unknown>, i: number) => ({
      index: s.index ?? i,
      title: s.title ?? `Step ${i}`,
      description: s.description ?? '',
      instruction: s.instruction ?? '',
      allowedFiles: (s.allowedFiles as string[]) ?? [],
      allowedGlobs: (s.allowedGlobs as string[]) ?? [],
      newFilesAllowed: (s.newFilesAllowed as boolean) ?? false,
      skillId: (s.skillId as string) ?? null,
      status: StepStatus.PENDING,
      diff: null,
      testResults: null,
      tokensUsed: 0,
    })),
    createdAt: new Date().toISOString(),
  };
};

const parseInvestigationJSON = (text: string): { diagnosis: string; revisedInstruction: string } => {
  const cleaned = text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    diagnosis: String(parsed.diagnosis ?? 'Unknown cause'),
    revisedInstruction: String(parsed.revisedInstruction ?? 'Retry the step with the same instruction.'),
  };
};
