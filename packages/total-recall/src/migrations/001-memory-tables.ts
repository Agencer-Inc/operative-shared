import type Database from "better-sqlite3";

/**
 * Migration 001: Create all Total Recall memory tables.
 *
 * Collapsed from OperativeX migrations 005, 008, and 010 into a single
 * migration that creates the final-state schema directly (with product column).
 *
 * Three tiers:
 *   - Tier 1: knowledge_facts — structured key-value facts (instant lookup)
 *   - Tier 1.5: memory_patterns — behavioral pattern tracking
 *   - Tier 2: working_memory — per-project recent context
 *   - Tier 3: memory_fts — FTS5 full-text search across all past content
 */
export function up(db: Database.Database): void {
  // Tier 1: Knowledge Profile (instant key-value facts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_facts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      source TEXT,
      source_project_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      product TEXT NOT NULL DEFAULT 'ox',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fact_key, product)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_facts_key ON knowledge_facts(fact_key);
    CREATE INDEX IF NOT EXISTS idx_knowledge_facts_prefix ON knowledge_facts(fact_key COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_knowledge_facts_product ON knowledge_facts(product);
  `);

  // Tier 1.5: Behavioral patterns
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_patterns (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      pattern_key TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('communication', 'workflow', 'preference', 'emotional', 'technical')),
      description TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.3,
      times_seen INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      product TEXT NOT NULL DEFAULT 'ox',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(pattern_key, product)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_patterns_category ON memory_patterns(category);
    CREATE INDEX IF NOT EXISTS idx_memory_patterns_confidence ON memory_patterns(confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_patterns_product ON memory_patterns(product);
  `);

  // Tier 2: Working Memory (per-project recent context)
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      project_id TEXT NOT NULL,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('decision', 'error', 'milestone', 'user_input', 'ox_response', 'stage_complete')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_project ON working_memory(project_id, created_at DESC);
  `);

  // Tier 3: Long-Term Memory (FTS5 full-text search)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      source_type,
      project_name,
      project_id UNINDEXED,
      source_id UNINDEXED,
      product UNINDEXED,
      created_at UNINDEXED,
      tokenize='porter unicode61'
    );
  `);
}
