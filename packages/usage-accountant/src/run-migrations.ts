import type Database from "better-sqlite3";
import { up as usageLedgerUp } from "./migrations/001-usage-ledger.js";

const MIGRATIONS = [
  { version: 1, description: "Create usage_ledger table", up: usageLedgerUp },
];

/**
 * Run all @agencer/usage-accountant migrations against the provided
 * database instance. Idempotent — skips already-applied migrations.
 *
 * Each migration runs inside a transaction. If any statement fails,
 * the entire migration is rolled back.
 */
export function runMigrations(db: Database.Database): void {
  // Ensure schema tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _ua_schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM _ua_schema_migrations").all() as Array<{ version: number }>)
      .map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO _ua_schema_migrations (version, description) VALUES (?, ?)",
      ).run(migration.version, migration.description);
    });
    tx();
  }
}
