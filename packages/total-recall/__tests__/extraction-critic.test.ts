import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import Database from "better-sqlite3";
import { KnowledgeService, MemoryService, ExtractionPipeline, runMigrations } from "../src/index.js";
import { UsageAccountant, UsageComponent } from "@agencer/usage-accountant";
import { runMigrations as runUaMigrations } from "@agencer/usage-accountant";

let callCount = 0;
let extractionResponse: unknown;
let criticResponse: unknown;

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(extractionResponse);
          return Promise.resolve(criticResponse);
        }),
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

describe("Extraction critic", () => {
  let db: Database.Database;
  let knowledgeService: KnowledgeService;
  let accountant: UsageAccountant;
  let pipeline: ExtractionPipeline;

  beforeEach(() => {
    callCount = 0;
    db = createTestDb();
    knowledgeService = new KnowledgeService(db, logger);
    accountant = new UsageAccountant(db, logger);
    pipeline = new ExtractionPipeline("test-api-key", knowledgeService, logger);
    pipeline.setUsageAccountant(accountant);
  });

  afterEach(() => {
    db.close();
  });

  it("keeps substantive facts and drops meta-observations", async () => {
    extractionResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { type: "fact", key: "project.overseer.design", value: "Supreme Panel with 5 judicial members" },
          { type: "fact", key: "tone.observation", value: "User is enthusiastic about architecture" },
          { type: "fact", key: "user.name", value: "Faryar" },
        ]),
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    };

    criticResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { key: "project.overseer.design", keep: true, reason: "Substantive architecture detail" },
          { key: "tone.observation", keep: false, reason: "Meta-observation about conversation tone" },
          { key: "user.name", keep: true, reason: "User identity" },
        ]),
      }],
      usage: { input_tokens: 150, output_tokens: 60 },
    };

    await pipeline.extractAndStore("test input about judicial panels", "test");

    const designFact = await knowledgeService.getFact("project.overseer.design");
    expect(designFact).not.toBeNull();
    expect(designFact!.factValue).toBe("Supreme Panel with 5 judicial members");

    const nameFact = await knowledgeService.getFact("user.name");
    expect(nameFact).not.toBeNull();

    const toneFact = await knowledgeService.getFact("tone.observation");
    expect(toneFact).toBeNull();

    const criticUsage = db.prepare("SELECT * FROM usage_ledger WHERE component = ?")
      .all(UsageComponent.FACT_EXTRACTION_CRITIC) as Array<Record<string, unknown>>;
    expect(criticUsage).toHaveLength(1);
  });

  it("keeps all facts when critic fails", async () => {
    extractionResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { type: "fact", key: "user.name", value: "TestUser" },
          { type: "fact", key: "tone.observation", value: "Enthusiastic" },
        ]),
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    };

    criticResponse = Promise.reject(new Error("API timeout"));

    await pipeline.extractAndStore("test input", "test");

    const nameFact = await knowledgeService.getFact("user.name");
    expect(nameFact).not.toBeNull();

    const toneFact = await knowledgeService.getFact("tone.observation");
    expect(toneFact).not.toBeNull();
  });

  it("passes through patterns without critic", async () => {
    extractionResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { type: "fact", key: "user.name", value: "TestUser" },
          { type: "pattern", key: "prefers-typescript", category: "technical", description: "Uses TS always" },
        ]),
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    };

    criticResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { key: "user.name", keep: true, reason: "User identity" },
        ]),
      }],
      usage: { input_tokens: 50, output_tokens: 20 },
    };

    const memoryService = new MemoryService(db, knowledgeService, logger);
    pipeline.setMemoryService(memoryService);

    await pipeline.extractAndStore("test input", "test");

    const nameFact = await knowledgeService.getFact("user.name");
    expect(nameFact).not.toBeNull();

    const patterns = await memoryService.getPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.patternKey).toBe("prefers-typescript");
  });

  it("skips critic when no accountant is wired", async () => {
    const noCriticPipeline = new ExtractionPipeline("test-api-key", knowledgeService, logger);

    extractionResponse = {
      content: [{
        type: "text",
        text: JSON.stringify([
          { type: "fact", key: "tone.observation", value: "Meta fact should survive" },
        ]),
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    };

    await noCriticPipeline.extractAndStore("test input", "test");

    const toneFact = await knowledgeService.getFact("tone.observation");
    expect(toneFact).not.toBeNull();
  });
});
