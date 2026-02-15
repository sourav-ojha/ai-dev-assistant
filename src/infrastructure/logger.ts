/**
 * Structured logger — pino.
 * Every adapter and orchestrator logs through this.
 */

import pino from 'pino';

const rootLogger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export const createLogger = (name: string): pino.Logger =>
  rootLogger.child({ component: name });
