import type Database from "better-sqlite3";

/**
 * Migration 001: Create usage_ledger table for UsageAccountant.
 *
 * Per-call cost attribution with named sub-meters. Every API call
 * that costs money is recorded as a raw row with component, model,
 * token counts, calculated cost, and latency.
 *
 * Raw rows are the unit of truth. Aggregation happens at query time.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL,
      session_id TEXT,
      component TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      latency_ms INTEGER NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_time
      ON usage_ledger(user_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_usage_component
      ON usage_ledger(component);
  `);
}
