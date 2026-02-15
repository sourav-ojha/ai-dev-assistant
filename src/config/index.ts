/**
 * Configuration — loaded from environment variables.
 * Single source of truth for all runtime config.
 */

import { TOKEN_BUDGET } from '../core/entities/token-budget.js';

export type LLMProvider = 'anthropic' | 'ollama' | 'mock';

export interface AppConfig {
  llmProvider: LLMProvider;
  anthropicApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  telegramBotToken: string;
  telegramChatId: string;
  workspaceDir: string;
  dbPath: string;
  tokenBudgetPerTask: number;
  dockerSocket: string;
  sandboxImage: string;
  sandboxTimeoutSec: number;
  sandboxMemoryMb: number;
  sandboxCpuCount: number;
  logLevel: string;
}

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const optionalEnv = (key: string, defaultValue: string): string =>
  process.env[key] ?? defaultValue;

/** Load full config — requires all env vars. Used by submit/resume. */
export const loadConfig = (): AppConfig => {
  const raw = optionalEnv('LLM_PROVIDER', 'anthropic').toLowerCase();
  const llmProvider: LLMProvider = raw === 'ollama' ? 'ollama' : raw === 'mock' ? 'mock' : 'anthropic';
  if (raw && !['anthropic', 'ollama', 'mock'].includes(raw)) {
    throw new Error(`Invalid LLM_PROVIDER: ${raw}. Use anthropic, ollama, or mock.`);
  }

  return {
    llmProvider,
    anthropicApiKey: llmProvider === 'anthropic' ? requireEnv('ANTHROPIC_API_KEY') : optionalEnv('ANTHROPIC_API_KEY', ''),
    ollamaBaseUrl: optionalEnv('OLLAMA_BASE_URL', 'http://localhost:11434'),
    ollamaModel: optionalEnv('OLLAMA_MODEL', 'llama3.2'),
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
    workspaceDir: optionalEnv('WORKSPACE_DIR', '/tmp/ai-dev-assistant/workspaces'),
    dbPath: optionalEnv('DB_PATH', './data/tasks.db'),
    tokenBudgetPerTask: parseInt(optionalEnv('TOKEN_BUDGET_PER_TASK', String(TOKEN_BUDGET.PER_TASK_MAX)), 10),
    dockerSocket: optionalEnv('DOCKER_SOCKET', '/var/run/docker.sock'),
    sandboxImage: optionalEnv('SANDBOX_IMAGE', 'ai-dev-sandbox:latest'),
    sandboxTimeoutSec: parseInt(optionalEnv('SANDBOX_TIMEOUT_SEC', '600'), 10),
    sandboxMemoryMb: parseInt(optionalEnv('SANDBOX_MEMORY_MB', '512'), 10),
    sandboxCpuCount: parseInt(optionalEnv('SANDBOX_CPU_COUNT', '1'), 10),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
};

/** Load minimal config — only DB path. Used by read-only commands (list, status). */
export const loadDbPath = (): string =>
  optionalEnv('DB_PATH', './data/tasks.db');
