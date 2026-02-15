/**
 * Structured logger — pino.
 * Every adapter and orchestrator logs through this.
 * Set LOG_FILE to also write JSON lines to a file for later analysis.
 */

import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

const level = (process.env['LOG_LEVEL'] ?? 'info') as pino.Level;
const logFile = process.env['LOG_FILE'];

function buildDestination(): pino.DestinationStream {
  const streams: pino.StreamEntry[] = [];

  // Console: pretty in dev, plain stdout in production
  if (process.env['NODE_ENV'] !== 'production') {
    streams.push({
      stream: pino.transport({ target: 'pino-pretty', options: { colorize: true } }),
      level,
    });
  } else {
    streams.push({ stream: process.stdout, level });
  }

  // Optional file for later analysis (JSON lines)
  if (logFile?.trim()) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      streams.push({
        stream: createWriteStream(logFile, { flags: 'a' }),
        level,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to open LOG_FILE ${logFile}:`, err);
    }
  }

  if (streams.length > 1) {
    return pino.multistream(streams) as pino.DestinationStream;
  }
  return streams[0]!.stream as pino.DestinationStream;
}

const rootLogger = pino(
  { level },
  buildDestination(),
);

export const createLogger = (name: string): pino.Logger =>
  rootLogger.child({ component: name });
