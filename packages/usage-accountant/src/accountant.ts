// ─────────────────────────────────────────────────────────────
// Usage Accountant
//
// Per-call cost attribution with named sub-meters. Every API call
// that costs money is recorded as a raw row in usage_ledger.
//
// Implements the Metering Principle: raw rows are the unit of
// truth. Aggregation happens at query time. Sub-meter names are
// constants in a single source of truth.
// ─────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import crypto from "node:crypto";

// ── Sub-meter constants ────────────────────────────────────

export const UsageComponent = {
  // Soft logic (new in this PR)
  FACT_RECALL: "soft_logic.fact_recall",
  FACT_EXTRACTION: "soft_logic.fact_extraction",
  FACT_EXTRACTION_CRITIC: "soft_logic.fact_extraction_critic",

  // Classifiers
  INTENT_CLASSIFIER: "classifier.intent",
  ENGAGEMENT_CLASSIFIER: "classifier.engagement",
  RADAR_CLASSIFIER: "classifier.radar",

  // Voice
  FILLER_GENERATION: "voice.filler",
  TTS_CARTESIA: "voice.tts_cartesia",
  STT_DEEPGRAM: "voice.stt_deepgram",
  LIVEKIT_BANDWIDTH: "voice.livekit_bandwidth",

  // Brain
  BRAIN_OPUS: "brain.opus",
  BRAIN_SONNET: "brain.sonnet",
  BRAIN_HAIKU: "brain.haiku",

  // Utility
  ACKNOWLEDGMENT_GEN: "voice.acknowledgment",
  PROJECT_NAME_EXTRACTOR: "utility.project_name",

  // Training
  FINETUNE_TOGETHER: "training.finetune_together",
} as const;

export type UsageComponentType = (typeof UsageComponent)[keyof typeof UsageComponent];

// ── Model pricing ($ per million tokens) ───────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-20250414": { input: 1, output: 5 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

// ── Interfaces ─────────────────────────────────────────────

export interface RecordCallParams {
  userId: string;
  sessionId?: string;
  component: UsageComponentType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export interface UsageBreakdown {
  component: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalCalls: number;
}

export interface GetUsageOptions {
  from?: string;
  to?: string;
  groupBy?: "component" | "model";
}

// ── Service ────────────────────────────────────────────────

export class UsageAccountant {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  /** Record a single API call. NEVER throws — metering must not block callers. */
  recordCall(params: RecordCallParams): void {
    try {
      const costUsd = calculateCost(params.model, params.inputTokens, params.outputTokens);
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO usage_ledger
            (id, user_id, session_id, component, model, input_tokens, output_tokens, cost_usd, latency_ms, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .run(
          id,
          params.userId,
          params.sessionId ?? null,
          params.component,
          params.model,
          params.inputTokens,
          params.outputTokens,
          costUsd,
          params.latencyMs,
          params.metadata ? JSON.stringify(params.metadata) : null,
        );
    } catch (err) {
      this.logger.warn({ err, component: params.component }, "UsageAccountant.recordCall failed");
    }
  }

  /** Get usage breakdown for a user, grouped by component (default) or model. */
  getUserUsage(userId: string, options: GetUsageOptions = {}): UsageBreakdown[] {
    try {
      const groupCol = options.groupBy === "model" ? "model" : "component";
      const conditions = ["user_id = ?"];
      const bindParams: unknown[] = [userId];

      if (options.from) {
        conditions.push("created_at >= ?");
        bindParams.push(options.from);
      }
      if (options.to) {
        conditions.push("created_at <= ?");
        bindParams.push(options.to);
      }

      const sql = `
        SELECT
          ${groupCol} AS component,
          COALESCE(SUM(input_tokens), 0) AS totalInputTokens,
          COALESCE(SUM(output_tokens), 0) AS totalOutputTokens,
          COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
          COUNT(*) AS totalCalls
        FROM usage_ledger
        WHERE ${conditions.join(" AND ")}
        GROUP BY ${groupCol}
        ORDER BY totalCostUsd DESC
      `;

      return this.db.prepare(sql).all(...bindParams) as UsageBreakdown[];
    } catch (err) {
      this.logger.warn({ err, userId }, "UsageAccountant.getUserUsage failed");
      return [];
    }
  }
}

// ── Metered Haiku helper ───────────────────────────────────

export interface CallHaikuMeteredParams {
  apiKey: string;
  model?: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * Thin wrapper: makes a Haiku call AND records usage automatically.
 * Preferred interface for new soft-logic code.
 */
export async function callHaikuMetered(
  params: CallHaikuMeteredParams,
  component: UsageComponentType,
  userId: string,
  sessionId: string | undefined,
  accountant: UsageAccountant,
): Promise<Anthropic.Message> {
  const model = params.model ?? "claude-haiku-4-5-20251001";
  const start = Date.now();
  const client = new Anthropic({ apiKey: params.apiKey });

  const response = await client.messages.create(
    {
      model,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature,
      system: params.system,
      messages: params.messages,
    },
    { timeout: params.timeoutMs ?? 15_000 },
  );

  const latencyMs = Date.now() - start;
  accountant.recordCall({
    userId,
    sessionId,
    component,
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs,
  });

  return response;
}

// ── User context ─────────────────────────────────────────────

export interface UserContext {
  userId: string;
  sessionId: string;
}

export function defaultUserContext(projectId?: string): UserContext {
  return {
    userId: process.env["OX_USER_ID"] ?? "default",
    sessionId: projectId ?? "no-project",
  };
}

// ── Streaming call helper ────────────────────────────────────

export interface RecordStreamingCallParams {
  userCtx: UserContext;
  component: UsageComponentType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * Record usage from a streaming Anthropic response. Call this AFTER
 * stream.finalMessage() gives you the token counts. NEVER throws.
 */
export function recordStreamingCall(
  accountant: UsageAccountant,
  params: RecordStreamingCallParams,
): void {
  accountant.recordCall({
    userId: params.userCtx.userId,
    sessionId: params.userCtx.sessionId,
    component: params.component,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    latencyMs: params.latencyMs,
    metadata: params.metadata,
  });
}
