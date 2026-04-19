import type Database from "better-sqlite3";
import type pg from "pg";
import type { Logger } from "pino";

/** Product identifier. The consumer defines what products exist. */
export type ProductId = string;

export interface KnowledgeFact {
  id: string;
  factKey: string;
  factValue: string;
  source: string | null;
  sourceProjectId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeFactRow {
  id: string;
  fact_key: string;
  fact_value: string;
  source: string | null;
  source_project_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

function rowToFact(row: KnowledgeFactRow): KnowledgeFact {
  return {
    id: row.id,
    factKey: row.fact_key,
    factValue: row.fact_value,
    source: row.source,
    sourceProjectId: row.source_project_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * KnowledgeService — Tier 1 KV fact store.
 * Supports both SQLite (better-sqlite3) and Postgres (pg.Pool) backends.
 * When using Postgres, all methods are async. When using SQLite, Promises resolve immediately.
 */
export class KnowledgeService {
  private sqlite: Database.Database | null;
  private pgPool: pg.Pool | null;
  private logger: Logger;

  constructor(db: Database.Database | pg.Pool, logger: Logger) {
    if ("prepare" in db && typeof (db as Database.Database).prepare === "function") {
      this.sqlite = db as Database.Database;
      this.pgPool = null;
    } else {
      this.sqlite = null;
      this.pgPool = db as pg.Pool;
    }
    this.logger = logger.child({ service: "knowledge" });
  }

  private get usePostgres(): boolean {
    return this.pgPool !== null;
  }

  /** Get a single fact by exact key. Returns null if not found. */
  async getFact(key: string, product: ProductId = "ox"): Promise<KnowledgeFact | null> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM knowledge_facts WHERE fact_key = $1 AND product = $2",
          [key, product],
        );
        const row = result.rows[0] as KnowledgeFactRow | undefined;
        return row ? rowToFact(row) : null;
      } else {
        const row = this.sqlite!
          .prepare("SELECT * FROM knowledge_facts WHERE fact_key = ? AND product = ?")
          .get(key, product) as KnowledgeFactRow | undefined;
        return row ? rowToFact(row) : null;
      }
    } catch (error) {
      this.logger.error({ error, key }, "Failed to get fact");
      return null;
    }
  }

  /** Get all facts matching a key prefix (e.g., "preference." returns all preferences) */
  async getFactsByPrefix(prefix: string, product: ProductId = "ox"): Promise<KnowledgeFact[]> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM knowledge_facts WHERE fact_key LIKE $1 AND product = $2 ORDER BY fact_key",
          [prefix + "%", product],
        );
        return (result.rows as KnowledgeFactRow[]).map(rowToFact);
      } else {
        const rows = this.sqlite!
          .prepare("SELECT * FROM knowledge_facts WHERE fact_key LIKE ? AND product = ? ORDER BY fact_key")
          .all(prefix + "%", product) as KnowledgeFactRow[];
        return rows.map(rowToFact);
      }
    } catch (error) {
      this.logger.error({ error, prefix }, "Failed to get facts by prefix");
      return [];
    }
  }

  /** Get all facts. For building the full Tier 1 context block. */
  async getAllFacts(product: ProductId = "ox"): Promise<KnowledgeFact[]> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM knowledge_facts WHERE product = $1 ORDER BY fact_key",
          [product],
        );
        return (result.rows as KnowledgeFactRow[]).map(rowToFact);
      } else {
        const rows = this.sqlite!
          .prepare("SELECT * FROM knowledge_facts WHERE product = ? ORDER BY fact_key")
          .all(product) as KnowledgeFactRow[];
        return rows.map(rowToFact);
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to get all facts");
      return [];
    }
  }

  /** Upsert a fact. If key exists, update value + updated_at. If not, insert. */
  async setFact(
    key: string,
    value: string,
    source?: string,
    projectId?: string,
    confidence?: number,
    product: ProductId = "ox",
  ): Promise<void> {
    try {
      if (this.usePostgres) {
        await this.pgPool!.query(
          `INSERT INTO knowledge_facts (fact_key, fact_value, source, source_project_id, confidence, product)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT(fact_key, product) DO UPDATE SET
             fact_value = EXCLUDED.fact_value,
             source = EXCLUDED.source,
             source_project_id = EXCLUDED.source_project_id,
             confidence = EXCLUDED.confidence,
             updated_at = NOW()`,
          [key, value, source ?? null, projectId ?? null, confidence ?? 1.0, product],
        );
      } else {
        this.sqlite!
          .prepare(
            `INSERT INTO knowledge_facts (id, fact_key, fact_value, source, source_project_id, confidence, product)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)
             ON CONFLICT(fact_key, product) DO UPDATE SET
               fact_value = excluded.fact_value,
               source = excluded.source,
               source_project_id = excluded.source_project_id,
               confidence = excluded.confidence,
               updated_at = datetime('now')`,
          )
          .run(key, value, source ?? null, projectId ?? null, confidence ?? 1.0, product);
      }
      this.logger.info({ key, value, source }, "Fact upserted");
    } catch (error) {
      this.logger.error({ error, key }, "Failed to upsert fact");
    }
  }

  /** Delete a fact by key. Returns true if deleted, false if not found. */
  async deleteFact(key: string, product: ProductId = "ox"): Promise<boolean> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "DELETE FROM knowledge_facts WHERE fact_key = $1 AND product = $2",
          [key, product],
        );
        return (result.rowCount ?? 0) > 0;
      } else {
        const result = this.sqlite!
          .prepare("DELETE FROM knowledge_facts WHERE fact_key = ? AND product = ?")
          .run(key, product);
        return result.changes > 0;
      }
    } catch (error) {
      this.logger.error({ error, key }, "Failed to delete fact");
      return false;
    }
  }

  /**
   * Build a context string for injection into Brain prompts.
   * Groups facts by namespace prefix for readability.
   * Max 2000 chars.
   */
  async buildContextString(product: ProductId = "ox"): Promise<string> {
    const facts = await this.getAllFacts(product);
    if (facts.length === 0) return "";

    const groups = new Map<string, KnowledgeFact[]>();
    for (const fact of facts) {
      const prefix = fact.factKey.split(".")[0] ?? "other";
      const group = groups.get(prefix) ?? [];
      group.push(fact);
      groups.set(prefix, group);
    }

    const NAMESPACE_LABELS: Record<string, string> = {
      user: "What I Know About You",
      preference: "Your Preferences",
      project: "Past Projects",
      pattern: "Patterns I've Noticed",
      tech: "Technical Preferences",
    };

    const sections: string[] = [];
    for (const [prefix, groupFacts] of groups) {
      const label = NAMESPACE_LABELS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
      const lines = groupFacts.map((f) => {
        const shortKey = f.factKey.includes(".")
          ? f.factKey.split(".").slice(1).join(".")
          : f.factKey;
        return `- ${shortKey}: ${f.factValue}`;
      });
      sections.push(`## ${label}\n${lines.join("\n")}`);
    }

    let result = sections.join("\n\n");

    if (result.length > 2000) {
      result = result.substring(0, 2000);
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > 1500) {
        result = result.substring(0, lastNewline);
      }
    }

    return result;
  }
}
