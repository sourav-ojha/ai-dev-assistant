/**
 * SQLite schema migrations — run once on startup.
 * All tables created idempotently (IF NOT EXISTS).
 */

import type Database from 'better-sqlite3';

export const runMigrations = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      state TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      feature_branch TEXT,
      current_step_index INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      call_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      summary TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transition_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      metadata TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transition_logs_task_id ON transition_logs(task_id);

    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      step_index INTEGER,
      call_type TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      model TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_calls_task_id ON llm_calls(task_id);
  `);
};
