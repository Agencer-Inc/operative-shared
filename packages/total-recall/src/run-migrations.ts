import type Database from "better-sqlite3";
import { up as memoryTablesUp } from "./migrations/001-memory-tables.js";

const MIGRATIONS = [
  { version: 1, description: "Create memory tables (knowledge_facts, memory_patterns, working_memory, memory_fts)", up: memoryTablesUp },
];

/**
 * Run all @agencer/total-recall migrations against the provided
 * database instance. Idempotent — skips already-applied migrations.
 *
 * Each migration runs inside a transaction. If any statement fails,
 * the entire migration is rolled back.
 */
export function runMigrations(db: Database.Database): void {
  // Ensure schema tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _tr_schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM _tr_schema_migrations").all() as Array<{ version: number }>)
      .map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO _tr_schema_migrations (version, description) VALUES (?, ?)",
      ).run(migration.version, migration.description);
    });
    tx();
  }
}
