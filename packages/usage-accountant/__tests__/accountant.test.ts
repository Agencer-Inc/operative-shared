import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import Database from "better-sqlite3";
import {
  UsageAccountant,
  UsageComponent,
  calculateCost,
  callHaikuMetered,
  runMigrations,
  PACKAGE_VERSION,
} from "../src/index.js";

// Mock Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"ids":["fact1"]}' }],
          usage: { input_tokens: 500, output_tokens: 50 },
        }),
      },
    })),
  };
});

const logger = pino({ level: "silent" });

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("PACKAGE_VERSION", () => {
  it("is 0.1.0", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});

describe("runMigrations", () => {
  it("creates usage_ledger table", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_ledger'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db); // should not throw
    db.close();
  });
});

describe("calculateCost", () => {
  it("returns correct cost for Haiku 4.5 ($1/$5 per M)", () => {
    const cost = calculateCost("claude-haiku-4-5-20251001", 1000, 100);
    expect(cost).toBeCloseTo(0.0015, 6);
  });

  it("returns correct cost for Sonnet ($3/$15 per M)", () => {
    const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 100_000);
    expect(cost).toBeCloseTo(4.5, 4);
  });

  it("returns correct cost for Opus ($15/$75 per M)", () => {
    const cost = calculateCost("claude-opus-4-20250514", 10_000, 1_000);
    expect(cost).toBeCloseTo(0.225, 6);
  });

  it("falls back to default pricing for unknown models", () => {
    const cost = calculateCost("unknown-model", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 4);
  });
});

describe("UsageAccountant", () => {
  let db: Database.Database;
  let accountant: UsageAccountant;

  beforeEach(() => {
    db = createTestDb();
    accountant = new UsageAccountant(db, logger);
  });

  describe("recordCall", () => {
    it("writes a row to usage_ledger", () => {
      accountant.recordCall({
        userId: "user-1",
        sessionId: "session-1",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 50,
        latencyMs: 200,
      });

      const rows = db.prepare("SELECT * FROM usage_ledger").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!["user_id"]).toBe("user-1");
      expect(rows[0]!["session_id"]).toBe("session-1");
      expect(rows[0]!["component"]).toBe("soft_logic.fact_recall");
      expect(rows[0]!["model"]).toBe("claude-haiku-4-5-20251001");
      expect(rows[0]!["input_tokens"]).toBe(500);
      expect(rows[0]!["output_tokens"]).toBe(50);
      expect(rows[0]!["latency_ms"]).toBe(200);
      expect(rows[0]!["cost_usd"]).toBeCloseTo(0.00075, 6);
    });

    it("stores metadata as JSON string", () => {
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_EXTRACTION_CRITIC,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 100,
        outputTokens: 20,
        latencyMs: 150,
        metadata: { factsEvaluated: 5 },
      });

      const row = db.prepare("SELECT metadata FROM usage_ledger").get() as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({ factsEvaluated: 5 });
    });

    it("does not throw on DB error", () => {
      db.close();
      expect(() =>
        accountant.recordCall({
          userId: "user-1",
          component: UsageComponent.FACT_RECALL,
          model: "claude-haiku-4-5-20251001",
          inputTokens: 100,
          outputTokens: 10,
          latencyMs: 50,
        }),
      ).not.toThrow();
    });
  });

  describe("getUserUsage", () => {
    it("returns grouped breakdown by component", () => {
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 50,
        latencyMs: 200,
      });
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 600,
        outputTokens: 60,
        latencyMs: 250,
      });
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_EXTRACTION_CRITIC,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 300,
        outputTokens: 30,
        latencyMs: 100,
      });

      const usage = accountant.getUserUsage("user-1");
      expect(usage).toHaveLength(2);

      const recallUsage = usage.find((u) => u.component === UsageComponent.FACT_RECALL);
      expect(recallUsage).toBeDefined();
      expect(recallUsage!.totalInputTokens).toBe(1100);
      expect(recallUsage!.totalOutputTokens).toBe(110);
      expect(recallUsage!.totalCalls).toBe(2);

      const criticUsage = usage.find((u) => u.component === UsageComponent.FACT_EXTRACTION_CRITIC);
      expect(criticUsage).toBeDefined();
      expect(criticUsage!.totalCalls).toBe(1);
    });

    it("filters by user", () => {
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 50,
        latencyMs: 200,
      });
      accountant.recordCall({
        userId: "user-2",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 300,
        outputTokens: 30,
        latencyMs: 100,
      });

      const usage = accountant.getUserUsage("user-1");
      expect(usage).toHaveLength(1);
      expect(usage[0]!.totalInputTokens).toBe(500);
    });

    it("groups by model when requested", () => {
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.BRAIN_SONNET,
        model: "claude-sonnet-4-20250514",
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 800,
      });
      accountant.recordCall({
        userId: "user-1",
        component: UsageComponent.FACT_RECALL,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 50,
        latencyMs: 200,
      });

      const usage = accountant.getUserUsage("user-1", { groupBy: "model" });
      expect(usage).toHaveLength(2);
      const models = usage.map((u) => u.component);
      expect(models).toContain("claude-sonnet-4-20250514");
      expect(models).toContain("claude-haiku-4-5-20251001");
    });

    it("returns empty array on DB error", () => {
      db.close();
      const usage = accountant.getUserUsage("user-1");
      expect(usage).toEqual([]);
    });
  });
});

describe("callHaikuMetered", () => {
  let db: Database.Database;
  let accountant: UsageAccountant;

  beforeEach(() => {
    db = createTestDb();
    accountant = new UsageAccountant(db, logger);
  });

  it("makes an API call and records usage", async () => {
    const response = await callHaikuMetered(
      {
        apiKey: "test-key",
        system: "test system prompt",
        messages: [{ role: "user", content: "test query" }],
      },
      UsageComponent.FACT_RECALL,
      "user-1",
      "session-1",
      accountant,
    );

    expect(response.content[0]).toBeDefined();

    const rows = db.prepare("SELECT * FROM usage_ledger").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["component"]).toBe("soft_logic.fact_recall");
    expect(rows[0]!["input_tokens"]).toBe(500);
    expect(rows[0]!["output_tokens"]).toBe(50);
  });
});
