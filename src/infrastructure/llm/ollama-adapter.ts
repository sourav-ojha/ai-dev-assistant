/**
 * Ollama adapter — local LLM via OpenAI-compatible API.
 * Use for testing the full flow without API costs.
 *
 * Requires: Ollama running locally (ollama serve, ollama pull <model>)
 * API: http://localhost:11434/v1/chat/completions
 */

import type { ILLMAdapter, FileContext, PlanGenerationResult, CodeGenerationResult, SummarizationResult, InvestigationResult } from '../../core/ports/llm-adapter.js';
import type { Plan, PlanStep } from '../../core/entities/plan.js';
import { StepStatus } from '../../core/entities/plan.js';
import { maxOutputTokensFor } from '../../core/entities/token-budget.js';
import { createLogger } from '../logger.js';

const log = createLogger('ollama-adapter');

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  max_tokens?: number;
  stream?: boolean;
}

interface OllamaChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OllamaAdapter implements ILLMAdapter {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  private async chat(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
    const start = Date.now();
    const url = `${this.baseUrl}/v1/chat/completions`;

    const body: OllamaChatRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      stream: false,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const durationMs = Date.now() - start;

    const text = data.choices?.[0]?.message?.content ?? '';
    const tokensIn = data.usage?.prompt_tokens ?? Math.ceil(systemPrompt.length / 4);
    const tokensOut = data.usage?.completion_tokens ?? Math.ceil(text.length / 4);

    log.info({ tokensIn, tokensOut, durationMs }, 'Ollama response');

    return { text, tokensIn, tokensOut };
  }

  async generatePlan(goal: string, repoStructure: string, skillContext?: string): Promise<PlanGenerationResult> {
    const systemPrompt = buildPlannerSystemPrompt();
    const userPrompt = buildPlannerUserPrompt(goal, repoStructure, skillContext);

    const { text, tokensIn, tokensOut } = await this.chat(
      systemPrompt,
      userPrompt,
      maxOutputTokensFor('planning'),
    );

    const plan = parsePlanFromJSON(text, '');

    log.info({ tokensIn, tokensOut }, 'Plan generated');

    return {
      plan,
      tokensIn,
      tokensOut,
      durationMs: 0, // chat() doesn't return it; could add if needed
    };
  }

  async generateCode(step: PlanStep, fileContents: FileContext[], planSummary: string): Promise<CodeGenerationResult> {
    const systemPrompt = buildCodeGenSystemPrompt();
    const userPrompt = buildCodeGenUserPrompt(step, fileContents, planSummary);

    const { text, tokensIn, tokensOut } = await this.chat(
      systemPrompt,
      userPrompt,
      maxOutputTokensFor('code_generation'),
    );

    log.info({ step: step.index, tokensIn, tokensOut }, 'Code generated');

    return {
      code: text,
      tokensIn,
      tokensOut,
      durationMs: 0,
    };
  }

  async summarize(diff: string, testResults: string, stepTitle: string): Promise<SummarizationResult> {
    const userPrompt = `Step: ${stepTitle}\n\nDiff:\n${diff.slice(0, 3000)}\n\nTest Results:\n${testResults.slice(0, 2000)}\n\nSummarize in 3-5 lines for Telegram notification.`;
    const systemPrompt = 'You summarize code diffs and test results into concise Telegram messages. Use plain text, no markdown. Be brief — max 5 lines.';

    const { text, tokensIn, tokensOut } = await this.chat(
      systemPrompt,
      userPrompt,
      maxOutputTokensFor('summarization'),
    );

    return {
      summary: text,
      tokensIn,
      tokensOut,
      durationMs: 0,
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

    const { text, tokensIn, tokensOut } = await this.chat(systemPrompt, userPrompt, 2000);
    const parsed = parseInvestigationJSON(text);

    log.info({ step: step.index }, 'Investigation completed');

    return {
      diagnosis: parsed.diagnosis,
      revisedInstruction: parsed.revisedInstruction,
      tokensIn,
      tokensOut,
      durationMs: 0,
    };
  }
}

// === Prompt builders (same as Claude adapter) ===

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

const parsePlanFromJSON = (text: string, taskId: string): Plan => {
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
