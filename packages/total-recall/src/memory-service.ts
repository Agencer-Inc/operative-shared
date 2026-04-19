import type Database from "better-sqlite3";
import type pg from "pg";
import type { Logger } from "pino";
import type { ProductId } from "./knowledge-service.js";
import { KnowledgeService } from "./knowledge-service.js";

/** Optional event callback for observability. Replaces monorepo's analysisEmitter. */
export type OnEventCallback = (event: { type: string; data: unknown }) => void;

/** Optional embedding function. Consumer provides their own embedding provider. */
export type EmbedFunction = (text: string) => Promise<number[] | null>;

export interface WorkingMemoryEntry {
  id: string;
  projectId: string;
  memoryType: "decision" | "error" | "milestone" | "user_input" | "ox_response" | "stage_complete";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface WorkingMemoryRow {
  id: string;
  project_id: string;
  memory_type: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface MemoryPattern {
  id: string;
  patternKey: string;
  category: "communication" | "workflow" | "preference" | "emotional" | "technical";
  description: string;
  confidence: number;
  timesSeen: number;
  lastSeen: string;
  createdAt: string;
}

interface MemoryPatternRow {
  id: string;
  pattern_key: string;
  category: string;
  description: string;
  confidence: number;
  times_seen: number;
  last_seen: string;
  created_at: string;
}

function rowToPattern(row: MemoryPatternRow): MemoryPattern {
  return {
    id: row.id,
    patternKey: row.pattern_key,
    category: row.category as MemoryPattern["category"],
    description: row.description,
    confidence: row.confidence,
    timesSeen: row.times_seen,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

export interface LongTermSearchResult {
  id: string;
  content: string;
  sourceType: string;
  projectName: string;
  createdAt: string;
  rank: number;
}

interface LongTermSearchRow {
  id: string;
  content: string;
  source_type: string;
  project_name: string;
  created_at: string;
  rank: number;
}

interface VectorSearchRow {
  id: string;
  content: string;
  source_type: string;
  project_name: string;
  created_at: string;
  similarity: number;
}

function rowToEntry(row: WorkingMemoryRow): WorkingMemoryEntry {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    memoryType: row.memory_type as WorkingMemoryEntry["memoryType"],
    content: row.content,
    metadata,
    createdAt: row.created_at,
  };
}

export interface MemoryServiceOptions {
  /** Optional event callback for observability. */
  onEvent?: OnEventCallback;
  /** Optional embedding function. Enables vector search when provided. */
  embed?: EmbedFunction;
}

/**
 * MemoryService — Tier 2 (working memory), Tier 3 (long-term + vector), Tier 1.5 (patterns).
 * Supports both SQLite (better-sqlite3) and Postgres (pg.Pool) backends.
 */
export class MemoryService {
  private sqlite: Database.Database | null;
  private pgPool: pg.Pool | null;
  private knowledgeService: KnowledgeService;
  private logger: Logger;
  private onEvent: OnEventCallback | undefined;
  private embed: EmbedFunction | undefined;

  constructor(
    db: Database.Database | pg.Pool,
    knowledgeService: KnowledgeService,
    logger: Logger,
    options?: MemoryServiceOptions,
  ) {
    if ("prepare" in db && typeof (db as Database.Database).prepare === "function") {
      this.sqlite = db as Database.Database;
      this.pgPool = null;
    } else {
      this.sqlite = null;
      this.pgPool = db as pg.Pool;
    }
    this.knowledgeService = knowledgeService;
    this.logger = logger.child({ service: "memory" });
    this.onEvent = options?.onEvent;
    this.embed = options?.embed;
  }

  private get usePostgres(): boolean {
    return this.pgPool !== null;
  }

  // ── Tier 2: Working Memory ──────────────────────

  async addWorkingMemory(
    projectId: string,
    type: WorkingMemoryEntry["memoryType"],
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (this.usePostgres) {
        await this.pgPool!.query(
          `INSERT INTO working_memory (project_id, memory_type, content, metadata)
           VALUES ($1, $2, $3, $4)`,
          [projectId, type, content, metadata ? JSON.stringify(metadata) : null],
        );

        const countResult = await this.pgPool!.query(
          "SELECT COUNT(*) as cnt FROM working_memory WHERE project_id = $1",
          [projectId],
        );
        const cnt = parseInt(String((countResult.rows[0] as { cnt: string }).cnt), 10);
        if (cnt > 100) {
          const excess = cnt - 100;
          await this.pgPool!.query(
            `DELETE FROM working_memory WHERE id IN (
              SELECT id FROM working_memory WHERE project_id = $1 ORDER BY created_at ASC LIMIT $2
            )`,
            [projectId, excess],
          );
        }
      } else {
        this.sqlite!
          .prepare(
            `INSERT INTO working_memory (id, project_id, memory_type, content, metadata)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            type,
            content,
            metadata ? JSON.stringify(metadata) : null,
          );

        const countRow = this.sqlite!
          .prepare("SELECT COUNT(*) as cnt FROM working_memory WHERE project_id = ?")
          .get(projectId) as { cnt: number };

        if (countRow.cnt > 100) {
          const excess = countRow.cnt - 100;
          this.sqlite!
            .prepare(
              `DELETE FROM working_memory WHERE id IN (
                SELECT id FROM working_memory WHERE project_id = ? ORDER BY created_at ASC LIMIT ?
              )`,
            )
            .run(projectId, excess);
        }
      }
    } catch (error) {
      this.logger.error({ error, projectId, type }, "Failed to add working memory");
    }
  }

  async getWorkingMemory(projectId: string, limit: number = 20): Promise<WorkingMemoryEntry[]> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM working_memory WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2",
          [projectId, limit],
        );
        return (result.rows as WorkingMemoryRow[]).map(rowToEntry);
      } else {
        const rows = this.sqlite!
          .prepare(
            "SELECT * FROM working_memory WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(projectId, limit) as WorkingMemoryRow[];
        return rows.map(rowToEntry);
      }
    } catch (error) {
      this.logger.error({ error, projectId }, "Failed to get working memory");
      return [];
    }
  }

  async buildWorkingMemoryContext(projectId: string): Promise<string> {
    const entries = await this.getWorkingMemory(projectId, 15);
    if (entries.length === 0) return "";

    const lines = entries
      .reverse()
      .map((e) => `- [${e.memoryType}] ${e.content}`);

    let result = `## Recent Context for This Project\n${lines.join("\n")}`;

    if (result.length > 1500) {
      result = result.substring(0, 1500);
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > 1000) {
        result = result.substring(0, lastNewline);
      }
    }

    return result;
  }

  // ── Tier 3: Long-Term Memory ────────────────────

  async indexMemory(
    content: string,
    sourceType: string,
    projectName: string,
    projectId?: string,
    sourceId?: string,
    product: ProductId = "ox",
  ): Promise<void> {
    try {
      if (this.usePostgres) {
        await this.pgPool!.query(
          `INSERT INTO memory_corpus (content, source_type, project_name, project_id, source_id, product)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [content, sourceType, projectName, projectId ?? null, sourceId ?? null, product],
        );
      } else {
        this.sqlite!
          .prepare(
            `INSERT INTO memory_fts (content, source_type, project_name, project_id, source_id, product, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(content, sourceType, projectName, projectId ?? null, sourceId ?? null, product);
      }
    } catch (error) {
      this.logger.error({ error, sourceType, projectName }, "Failed to index memory");
    }
  }

  async indexWithEmbedding(
    content: string,
    sourceType: string,
    projectName: string,
    projectId: string | undefined,
    embedding: number[],
    product: ProductId = "ox",
  ): Promise<void> {
    try {
      if (this.usePostgres) {
        const vecStr = `[${embedding.join(",")}]`;
        await this.pgPool!.query(
          `INSERT INTO memory_corpus (content, source_type, project_name, project_id, embedding, product)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          [content, sourceType, projectName, projectId ?? null, vecStr, product],
        );
      } else {
        await this.indexMemory(content, sourceType, projectName, projectId, undefined, product);
      }
    } catch (error) {
      this.logger.error({ error, sourceType }, "Failed to index memory with embedding");
      await this.indexMemory(content, sourceType, projectName, projectId, undefined, product);
    }
  }

  async indexPipelineCompletion(
    projectId: string,
    projectName: string,
    spec: string,
    decisions: Array<{ decision: string; rationale?: string }>,
    summary: string,
    success: boolean,
    durationSeconds: number,
  ): Promise<void> {
    await this.indexMemory(
      `Project: ${projectName}. Spec: ${spec}. Outcome: ${success ? "shipped successfully" : "failed"}. Duration: ${Math.round(durationSeconds / 60)} minutes. Summary: ${summary}`,
      "pipeline_summary",
      projectName,
      projectId,
    );

    for (const d of decisions) {
      await this.indexMemory(
        `Decision in ${projectName}: ${d.decision}${d.rationale ? ". Rationale: " + d.rationale : ""}`,
        "decision",
        projectName,
        projectId,
      );
    }
  }

  async indexConversation(
    projectId: string,
    projectName: string,
    userMessage: string,
    oxResponse: string,
    product: ProductId = "ox",
  ): Promise<void> {
    await this.indexMemory(
      `User said: ${userMessage}\nOX responded: ${oxResponse}`,
      "conversation",
      projectName,
      projectId,
      undefined,
      product,
    );
  }

  private sanitizeQuery(raw: string): string {
    const truncated = raw.slice(0, 200);
    const alphanumOnly = truncated.replace(/[^a-zA-Z0-9\s]/g, " ");
    const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
    const terms = alphanumOnly
      .split(/\s+/)
      .filter((t) => t.length > 1 && !OPERATORS.has(t.toUpperCase()));
    return terms.slice(0, 10).join(" ");
  }

  private async pgFtsSearch(query: string, limit: number, product: ProductId = "ox"): Promise<LongTermSearchResult[]> {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];

    const tsQueryTerms = sanitized.split(/\s+/).join(" & ");

    try {
      const result = await this.pgPool!.query(
        `SELECT id, content, source_type, project_name, created_at,
                ts_rank(tsv, to_tsquery('english', $1)) as rank
         FROM memory_corpus
         WHERE tsv @@ to_tsquery('english', $1) AND product = $3
         ORDER BY rank DESC
         LIMIT $2`,
        [tsQueryTerms, limit, product],
      );
      return (result.rows as LongTermSearchRow[]).map((r) => ({
        id: r.id,
        content: r.content,
        sourceType: r.source_type,
        projectName: r.project_name,
        createdAt: r.created_at,
        rank: r.rank,
      }));
    } catch (error) {
      this.logger.warn({ error, query: sanitized }, "Postgres FTS search failed");
      return [];
    }
  }

  private async pgVectorSearch(queryEmbedding: number[], limit: number, product: ProductId = "ox"): Promise<LongTermSearchResult[]> {
    const vecStr = `[${queryEmbedding.join(",")}]`;

    try {
      const result = await this.pgPool!.query(
        `SELECT id, content, source_type, project_name, created_at,
                1 - (embedding <=> $1::vector) as similarity
         FROM memory_corpus
         WHERE embedding IS NOT NULL AND product = $3
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vecStr, limit, product],
      );
      return (result.rows as VectorSearchRow[]).map((r) => ({
        id: r.id,
        content: r.content,
        sourceType: r.source_type,
        projectName: r.project_name,
        createdAt: r.created_at,
        rank: r.similarity,
      }));
    } catch (error) {
      this.logger.warn({ error }, "Postgres vector search failed");
      return [];
    }
  }

  private sqliteFtsSearch(query: string, limit: number, product: ProductId = "ox"): LongTermSearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];

    try {
      const rows = this.sqlite!
        .prepare(
          `SELECT rowid as id, content, source_type, project_name, created_at, rank, product
           FROM memory_fts
           WHERE memory_fts MATCH ? AND product = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(sanitized, product, limit) as (LongTermSearchRow & { id: number })[];

      return rows.map((r) => ({
        id: String(r.id),
        content: r.content,
        sourceType: r.source_type,
        projectName: r.project_name,
        createdAt: r.created_at,
        rank: r.rank,
      }));
    } catch (error) {
      this.logger.warn({ error, query: sanitized }, "FTS5 search failed");
      return [];
    }
  }

  private reciprocalRankFusion(
    ftsResults: LongTermSearchResult[],
    vecResults: LongTermSearchResult[],
    limit: number,
    k: number = 60,
  ): LongTermSearchResult[] {
    const scores = new Map<string, number>();
    const resultMap = new Map<string, LongTermSearchResult>();

    ftsResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
      resultMap.set(r.id, r);
    });

    vecResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
      if (!resultMap.has(r.id)) {
        resultMap.set(r.id, r);
      }
    });

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const r = resultMap.get(id)!;
        return { ...r, rank: score };
      });
  }

  async hybridSearch(query: string, limit: number = 10, product: ProductId = "ox"): Promise<LongTermSearchResult[]> {
    if (!this.usePostgres) {
      return this.sqliteFtsSearch(query, limit, product);
    }

    const ftsResults = await this.pgFtsSearch(query, limit * 2, product);

    let vecResults: LongTermSearchResult[] = [];
    if (this.embed) {
      try {
        const queryEmbedding = await this.embed(query);
        if (queryEmbedding) {
          vecResults = await this.pgVectorSearch(queryEmbedding, limit * 2, product);
          vecResults = vecResults.filter((r) => r.rank >= 0.3);
        }
      } catch (err) {
        this.logger.warn({ err }, "Vector search failed, using FTS only");
      }
    }

    if (vecResults.length > 0 && ftsResults.length > 0) {
      return this.reciprocalRankFusion(ftsResults, vecResults, limit);
    }

    return ftsResults.length > 0 ? ftsResults.slice(0, limit) : vecResults.slice(0, limit);
  }

  async searchLongTerm(query: string, limit: number = 10, product: ProductId = "ox"): Promise<LongTermSearchResult[]> {
    if (!query || query.trim().length === 0) return [];
    return this.hybridSearch(query, limit, product);
  }

  async buildLongTermContext(query: string, product: ProductId = "ox"): Promise<string> {
    const results = await this.searchLongTerm(query.slice(0, 200), 5, product);
    if (results.length === 0) return "";

    const lines = results.map((r) => {
      const shortContent =
        r.content.length > 200 ? r.content.substring(0, 200) + "..." : r.content;
      return `- [${r.sourceType}] In project "${r.projectName}": ${shortContent}`;
    });

    let result = `## Relevant Past Experience\n${lines.join("\n")}`;

    if (result.length > 2000) {
      result = result.substring(0, 2000);
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > 1500) {
        result = result.substring(0, lastNewline);
      }
    }

    return result;
  }

  // ── Tier 4: Episodic Memory ─────────────────────

  async storeEpisodic(
    sessionId: string,
    role: string,
    content: string,
    sourceType: string = "voice",
    product: ProductId = "ox",
  ): Promise<void> {
    if (!this.usePostgres) return;

    try {
      let vecStr: string | null = null;
      if (this.embed) {
        const embedding = await this.embed(content);
        if (embedding) {
          vecStr = `[${embedding.join(",")}]`;
        }
      }

      await this.pgPool!.query(
        `INSERT INTO episodic_transcripts (session_id, source_type, role, content, embedding, product)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        [sessionId, sourceType, role, content, vecStr, product],
      );
    } catch (error) {
      this.logger.error({ error, sessionId }, "Failed to store episodic memory");
    }
  }

  async recallEpisodic(query: string, limit: number = 5, product: ProductId = "ox"): Promise<Array<{ sessionId: string; role: string; content: string; createdAt: string }>> {
    if (!this.usePostgres) return [];

    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];

    try {
      const tsQueryTerms = sanitized.split(/\s+/).join(" & ");

      const ftsResult = await this.pgPool!.query(
        `SELECT session_id, role, content, created_at,
                ts_rank(tsv, to_tsquery('english', $1)) as rank
         FROM episodic_transcripts
         WHERE tsv @@ to_tsquery('english', $1) AND product = $3
         ORDER BY rank DESC
         LIMIT $2`,
        [tsQueryTerms, limit, product],
      );

      let rows = ftsResult.rows as Array<{ session_id: string; role: string; content: string; created_at: string }>;

      if (rows.length === 0 && this.embed) {
        const queryEmbedding = await this.embed(query);
        if (queryEmbedding) {
          const vecStr = `[${queryEmbedding.join(",")}]`;
          const vecResult = await this.pgPool!.query(
            `SELECT session_id, role, content, created_at,
                    1 - (embedding <=> $1::vector) as similarity
             FROM episodic_transcripts
             WHERE embedding IS NOT NULL AND product = $3
             ORDER BY embedding <=> $1::vector
             LIMIT $2`,
            [vecStr, limit, product],
          );
          rows = (vecResult.rows as Array<{ session_id: string; role: string; content: string; created_at: string; similarity: number }>)
            .filter((r) => r.similarity >= 0.3);
        }
      }

      return rows.map((r) => ({
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      }));
    } catch (error) {
      this.logger.warn({ error, query: sanitized }, "Episodic recall failed");
      return [];
    }
  }

  // ── Pattern Memory ────────────────────────────────

  async storePattern(
    patternKey: string,
    category: MemoryPattern["category"],
    description: string,
    product: ProductId = "ox",
  ): Promise<void> {
    try {
      const existing = await this.findSimilarPattern(patternKey, product);
      if (existing) {
        await this.reinforcePattern(existing.patternKey, product);
        return;
      }

      if (this.usePostgres) {
        await this.pgPool!.query(
          `INSERT INTO memory_patterns (pattern_key, category, description, confidence, times_seen, product)
           VALUES ($1, $2, $3, 0.3, 1, $4)
           ON CONFLICT(pattern_key, product) DO UPDATE SET
             description = EXCLUDED.description,
             times_seen = memory_patterns.times_seen + 1,
             confidence = LEAST(0.9, memory_patterns.confidence + 0.2),
             last_seen = NOW()`,
          [patternKey, category, description, product],
        );
      } else {
        this.sqlite!
          .prepare(
            `INSERT INTO memory_patterns (id, pattern_key, category, description, confidence, times_seen, product)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, 0.3, 1, ?)
             ON CONFLICT(pattern_key, product) DO UPDATE SET
               description = excluded.description,
               times_seen = times_seen + 1,
               confidence = MIN(0.9, confidence + 0.2),
               last_seen = datetime('now')`,
          )
          .run(patternKey, category, description, product);
      }
    } catch (error) {
      this.logger.error({ error, patternKey }, "Failed to store pattern");
    }
  }

  async reinforcePattern(patternKey: string, product: ProductId = "ox"): Promise<void> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT times_seen, confidence FROM memory_patterns WHERE pattern_key = $1 AND product = $2",
          [patternKey, product],
        );
        const row = result.rows[0] as { times_seen: number; confidence: number } | undefined;
        if (!row) return;

        const boost = row.times_seen < 3 ? 0.2 : 0.05;
        const newConfidence = Math.min(0.9, row.confidence + boost);

        await this.pgPool!.query(
          `UPDATE memory_patterns
           SET confidence = $1, times_seen = times_seen + 1, last_seen = NOW()
           WHERE pattern_key = $2 AND product = $3`,
          [newConfidence, patternKey, product],
        );

        this.onEvent?.({ type: "pattern_confidence_updated", data: { patternKey, action: "reinforce", oldConfidence: row.confidence, newConfidence, timesSeen: row.times_seen + 1 } });
      } else {
        const row = this.sqlite!
          .prepare("SELECT times_seen, confidence FROM memory_patterns WHERE pattern_key = ? AND product = ?")
          .get(patternKey, product) as { times_seen: number; confidence: number } | undefined;

        if (!row) return;

        const boost = row.times_seen < 3 ? 0.2 : 0.05;
        const newConfidence = Math.min(0.9, row.confidence + boost);

        this.sqlite!
          .prepare(
            `UPDATE memory_patterns
             SET confidence = ?, times_seen = times_seen + 1, last_seen = datetime('now')
             WHERE pattern_key = ? AND product = ?`,
          )
          .run(newConfidence, patternKey, product);

        this.onEvent?.({ type: "pattern_confidence_updated", data: { patternKey, action: "reinforce", oldConfidence: row.confidence, newConfidence, timesSeen: row.times_seen + 1 } });
      }
    } catch (error) {
      this.logger.error({ error, patternKey }, "Failed to reinforce pattern");
    }
  }

  async contradictPattern(patternKey: string, product: ProductId = "ox"): Promise<void> {
    try {
      if (this.usePostgres) {
        const currentResult = await this.pgPool!.query(
          "SELECT confidence FROM memory_patterns WHERE pattern_key = $1 AND product = $2",
          [patternKey, product],
        );
        const currentRow = currentResult.rows[0] as { confidence: number } | undefined;

        await this.pgPool!.query(
          `UPDATE memory_patterns
           SET confidence = confidence * 0.5, last_seen = NOW()
           WHERE pattern_key = $1 AND product = $2`,
          [patternKey, product],
        );

        if (currentRow) {
          this.onEvent?.({ type: "pattern_confidence_updated", data: { patternKey, action: "contradict", oldConfidence: currentRow.confidence, newConfidence: currentRow.confidence * 0.5 } });
        }
      } else {
        const currentRow = this.sqlite!
          .prepare("SELECT confidence FROM memory_patterns WHERE pattern_key = ? AND product = ?")
          .get(patternKey, product) as { confidence: number } | undefined;

        this.sqlite!
          .prepare(
            `UPDATE memory_patterns
             SET confidence = confidence * 0.5, last_seen = datetime('now')
             WHERE pattern_key = ? AND product = ?`,
          )
          .run(patternKey, product);

        if (currentRow) {
          this.onEvent?.({ type: "pattern_confidence_updated", data: { patternKey, action: "contradict", oldConfidence: currentRow.confidence, newConfidence: currentRow.confidence * 0.5 } });
        }
      }
    } catch (error) {
      this.logger.error({ error, patternKey }, "Failed to contradict pattern");
    }
  }

  async getPatterns(product: ProductId = "ox"): Promise<MemoryPattern[]> {
    try {
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM memory_patterns WHERE confidence >= 0.1 AND product = $1 ORDER BY confidence DESC",
          [product],
        );
        return (result.rows as MemoryPatternRow[]).map(rowToPattern);
      } else {
        const rows = this.sqlite!
          .prepare(
            "SELECT * FROM memory_patterns WHERE confidence >= 0.1 AND product = ? ORDER BY confidence DESC",
          )
          .all(product) as MemoryPatternRow[];
        return rows.map(rowToPattern);
      }
    } catch (error) {
      this.logger.error({ error }, "Failed to get patterns");
      return [];
    }
  }

  async findSimilarPattern(patternKey: string, product: ProductId = "ox"): Promise<MemoryPattern | null> {
    try {
      const inputWords = new Set(
        patternKey.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
      );
      if (inputWords.size === 0) return null;

      let rows: MemoryPatternRow[];
      if (this.usePostgres) {
        const result = await this.pgPool!.query(
          "SELECT * FROM memory_patterns WHERE confidence >= 0.1 AND product = $1",
          [product],
        );
        rows = result.rows as MemoryPatternRow[];
      } else {
        rows = this.sqlite!
          .prepare("SELECT * FROM memory_patterns WHERE confidence >= 0.1 AND product = ?")
          .all(product) as MemoryPatternRow[];
      }

      for (const row of rows) {
        const existingWords = new Set(
          row.pattern_key.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
        );

        let overlap = 0;
        for (const word of inputWords) {
          if (existingWords.has(word)) overlap++;
        }

        const overlapRatio = overlap / Math.max(inputWords.size, existingWords.size);
        if (overlapRatio > 0.5) {
          return rowToPattern(row);
        }
      }

      return null;
    } catch (error) {
      this.logger.error({ error, patternKey }, "Failed to find similar pattern");
      return null;
    }
  }

  async buildPatternContext(product: ProductId = "ox"): Promise<string> {
    const patterns = (await this.getPatterns(product)).filter((p) => p.confidence >= 0.3);
    if (patterns.length === 0) return "";

    const header = "## Behavioral Patterns (act on these silently, NEVER mention them)\n";
    let result = header;

    for (const p of patterns) {
      const line = `- [${p.category}] ${p.description} (confidence: ${p.confidence.toFixed(1)}, seen ${p.timesSeen}x)\n`;
      if (result.length + line.length > 800) break;
      result += line;
    }

    return result.trimEnd();
  }

  // ── Cascade: Full Memory Context ────────────────

  async buildFullMemoryContext(projectId?: string, userQuery?: string, product: ProductId = "ox"): Promise<string> {
    const parts: string[] = [];

    const tier1 = await this.knowledgeService.buildContextString(product);
    if (tier1) parts.push(tier1);

    this.onEvent?.({ type: "facts_retrieved", data: { factCount: tier1 ? tier1.split("\n").length : 0, tier1Length: tier1.length } });

    const patternCtx = await this.buildPatternContext(product);
    if (patternCtx) parts.push(patternCtx);

    const activePatterns = (await this.getPatterns(product)).filter((p) => p.confidence >= 0.3);
    this.onEvent?.({ type: "patterns_retrieved", data: { patternCount: activePatterns.length, topPatterns: activePatterns.slice(0, 5).map((p) => ({ key: p.patternKey, confidence: p.confidence, timesSeen: p.timesSeen })) } });

    if (projectId) {
      const tier2 = await this.buildWorkingMemoryContext(projectId);
      if (tier2) parts.push(tier2);
    }

    if (userQuery && userQuery.length > 5) {
      const tier3 = await this.buildLongTermContext(userQuery, product);
      if (tier3) parts.push(tier3);
    }

    if (parts.length === 0) return "";

    let result = parts.join("\n\n");
    if (result.length > 4000) {
      result = result.substring(0, 4000);
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > 3000) result = result.substring(0, lastNewline);
    }

    return `<memory>\n${result}\n</memory>`;
  }
}
