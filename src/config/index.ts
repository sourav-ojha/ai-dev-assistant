/**
 * Configuration — loaded from environment variables.
 * Single source of truth for all runtime config.
 */

import { TOKEN_BUDGET } from '../core/entities/token-budget.js';

export interface AppConfig {
  anthropicApiKey: string;
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
export const loadConfig = (): AppConfig => ({
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
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
});

/** Load minimal config — only DB path. Used by read-only commands (list, status). */
export const loadDbPath = (): string =>
  optionalEnv('DB_PATH', './data/tasks.db');
