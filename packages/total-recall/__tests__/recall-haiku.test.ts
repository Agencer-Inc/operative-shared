import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import Database from "better-sqlite3";
import { KnowledgeService, MemoryService, recallFactsWithHaiku, runMigrations } from "../src/index.js";
import { UsageAccountant, UsageComponent } from "@agencer/usage-accountant";
import { runMigrations as runUaMigrations } from "@agencer/usage-accountant";
import type { RecallContext } from "../src/index.js";

// Track mock calls so we can control behavior per-test
let mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    })),
  };
});

const logger = pino({ level: "silent" });

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  runUaMigrations(db);
  return db;
}

describe("Haiku-driven fact recall", () => {
  let db: Database.Database;
  let knowledgeService: KnowledgeService;
  let memoryService: MemoryService;
  let accountant: UsageAccountant;
  let originalKey: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    knowledgeService = new KnowledgeService(db, logger);
    memoryService = new MemoryService(db, knowledgeService, logger);
    accountant = new UsageAccountant(db, logger);

    // Insert test facts
    db.prepare("INSERT INTO knowledge_facts (id, fact_key, fact_value) VALUES (?, ?, ?)").run(
      "fact-1", "project.overseer.architecture", "Judicial panels with civilian oversight",
    );
    db.prepare("INSERT INTO knowledge_facts (id, fact_key, fact_value) VALUES (?, ?, ?)").run(
      "fact-2", "project.overseer.safety", "Kill-switch mechanism for emergency shutdown",
    );
    db.prepare("INSERT INTO knowledge_facts (id, fact_key, fact_value) VALUES (?, ?, ?)").run(
      "fact-3", "user.name", "Faryar",
    );
    db.prepare("INSERT INTO knowledge_facts (id, fact_key, fact_value) VALUES (?, ?, ?)").run(
      "fact-4", "preference.stack", "React + TypeScript + Vite",
    );

    // Default mock: Haiku returns fact-1 and fact-2
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ids: ["fact-1", "fact-2"] }) }],
      usage: { input_tokens: 300, output_tokens: 40 },
    });

    originalKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    db.close();
    if (originalKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalKey;
    } else {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  function makeCtx(overrides?: Partial<RecallContext>): RecallContext {
    return {
      knowledgeService,
      memoryService,
      usageAccountant: accountant,
      ...overrides,
    };
  }

  it("returns Haiku-selected facts", async () => {
    const allFacts = await knowledgeService.getAllFacts();
    const result = await recallFactsWithHaiku("safety issues in the system", allFacts, "safety issues in the system", makeCtx());

    // Should contain the Haiku-selected facts (fact-1 and fact-2)
    const keys = result.map((f) => f.factKey);
    expect(keys).toContain("project.overseer.architecture");
    expect(keys).toContain("project.overseer.safety");
    // Should NOT contain unrelated facts (Haiku didn't select them)
    expect(keys).not.toContain("preference.stack");

    // Verify usage was recorded
    const usageRows = db.prepare("SELECT * FROM usage_ledger WHERE component = ?")
      .all(UsageComponent.FACT_RECALL) as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(1);
  });

  it("falls back to substring match when Haiku fails", async () => {
    mockCreate = vi.fn().mockRejectedValue(new Error("API timeout"));

    const allFacts = await knowledgeService.getAllFacts();
    const result = await recallFactsWithHaiku("safety", allFacts, "safety", makeCtx());

    const keys = result.map((f) => f.factKey);
    expect(keys).toContain("project.overseer.safety");
  });

  it("falls back to substring match when no accountant is provided", async () => {
    const allFacts = await knowledgeService.getAllFacts();
    const result = await recallFactsWithHaiku("Faryar", allFacts, "faryar", makeCtx({ usageAccountant: undefined }));

    const keys = result.map((f) => f.factKey);
    expect(keys).toContain("user.name");
  });

  it("falls back when Haiku returns invalid JSON", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not valid json at all" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const allFacts = await knowledgeService.getAllFacts();
    const result = await recallFactsWithHaiku("Vite", allFacts, "vite", makeCtx());

    const keys = result.map((f) => f.factKey);
    expect(keys).toContain("preference.stack");
  });
});
