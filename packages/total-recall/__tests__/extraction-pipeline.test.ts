import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import Database from "better-sqlite3";
import { KnowledgeService, MemoryService, ExtractionPipeline, runMigrations } from "../src/index.js";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: JSON.stringify([
              { type: "fact", key: "user.name", value: "TestUser" },
              { type: "fact", key: "preference.stack", value: "React" },
            ]),
          }],
        }),
      },
    })),
  };
});

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const logger = pino({ level: "silent" });

describe("ExtractionPipeline", () => {
  let db: Database.Database;
  let knowledgeService: KnowledgeService;
  let memoryService: MemoryService;
  let pipeline: ExtractionPipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    knowledgeService = new KnowledgeService(db, logger);
    memoryService = new MemoryService(db, knowledgeService, logger);
    pipeline = new ExtractionPipeline("test-api-key", knowledgeService, logger);
    pipeline.setMemoryService(memoryService);
  });

  it("extractAndStore stores extracted facts", async () => {
    await pipeline.extractAndStore("My name is TestUser and I prefer React", "test");
    const fact = await knowledgeService.getFact("user.name");
    expect(fact).not.toBeNull();
    expect(fact!.factValue).toBe("TestUser");
  });

  it("extractAndStore stores multiple facts", async () => {
    await pipeline.extractAndStore("test input", "test");
    const nameFact = await knowledgeService.getFact("user.name");
    const stackFact = await knowledgeService.getFact("preference.stack");
    expect(nameFact).not.toBeNull();
    expect(stackFact).not.toBeNull();
    expect(stackFact!.factValue).toBe("React");
  });

  it("extractFromPipeline does not throw", () => {
    expect(() => {
      pipeline.extractFromPipeline("proj1", "TestProject", "Build a test app", [], true, 300);
    }).not.toThrow();
  });

  it("extractFromConversation does not throw", () => {
    expect(() => {
      pipeline.extractFromConversation("hello", "hi there", "proj1");
    }).not.toThrow();
  });

  it("handles API errors gracefully (never throws)", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API down")),
      },
    }));

    const failingPipeline = new ExtractionPipeline("key", knowledgeService, logger);
    await expect(failingPipeline.extractAndStore("test", "test")).resolves.not.toThrow();
  });

  it("handles malformed JSON response gracefully", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not valid json" }],
        }),
      },
    }));

    const badPipeline = new ExtractionPipeline("key", knowledgeService, logger);
    await expect(badPipeline.extractAndStore("test", "test")).resolves.not.toThrow();
  });

  it("extracts facts from JSON wrapped in markdown fences", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: 'Based on the conversation:\n```json\n[{"type":"fact","key":"user.name","value":"FenceUser"}]\n```',
          }],
        }),
      },
    }));

    const p = new ExtractionPipeline("key", knowledgeService, logger);
    await p.extractAndStore("test input", "test");
    const fact = await knowledgeService.getFact("user.name");
    expect(fact).not.toBeNull();
    expect(fact!.factValue).toBe("FenceUser");
  });

  it("extracts patterns from response", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: JSON.stringify([
              { type: "fact", key: "user.name", value: "TestUser" },
              { type: "pattern", key: "prefers-typescript", category: "technical", description: "User always chooses TypeScript" },
            ]),
          }],
        }),
      },
    }));

    const p = new ExtractionPipeline("key", knowledgeService, logger);
    p.setMemoryService(memoryService);
    await p.extractAndStore("test input", "test");

    const fact = await knowledgeService.getFact("user.name");
    expect(fact).not.toBeNull();

    const patterns = await memoryService.getPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.patternKey).toBe("prefers-typescript");
  });

  it("handles backward-compatible fact format (no type field)", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: JSON.stringify([
              { key: "user.name", value: "OldFormat" },
            ]),
          }],
        }),
      },
    }));

    const p = new ExtractionPipeline("key", knowledgeService, logger);
    await p.extractAndStore("test input", "test");

    const fact = await knowledgeService.getFact("user.name");
    expect(fact).not.toBeNull();
    expect(fact!.factValue).toBe("OldFormat");
  });

  it("works without memoryService (patterns ignored, facts still work)", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    (Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: JSON.stringify([
              { type: "fact", key: "user.name", value: "StillWorks" },
              { type: "pattern", key: "ignored", category: "technical", description: "No memory service" },
            ]),
          }],
        }),
      },
    }));

    const noMemPipeline = new ExtractionPipeline("test-api-key", knowledgeService, logger);
    await noMemPipeline.extractAndStore("test input", "test");
    const fact = await knowledgeService.getFact("user.name");
    expect(fact).not.toBeNull();
    expect(fact!.factValue).toBe("StillWorks");
  });
});
