import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import pino from "pino";
import { KnowledgeService, MemoryService, runMigrations } from "../src/index.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const logger = pino({ level: "silent" });

describe("MemoryService", () => {
  let db: Database.Database;
  let knowledgeService: KnowledgeService;
  let service: MemoryService;

  beforeEach(() => {
    db = createTestDb();
    knowledgeService = new KnowledgeService(db, logger);
    service = new MemoryService(db, knowledgeService, logger);
  });

  describe("Working Memory (Tier 2)", () => {
    it("adds and retrieves working memory", async () => {
      await service.addWorkingMemory("proj1", "decision", "Use React for frontend");
      await service.addWorkingMemory("proj1", "milestone", "CEO review passed");
      const entries = await service.getWorkingMemory("proj1");
      expect(entries).toHaveLength(2);
    });

    it("isolates by project", async () => {
      await service.addWorkingMemory("proj1", "decision", "Decision for proj1");
      await service.addWorkingMemory("proj2", "decision", "Decision for proj2");
      const proj1Entries = await service.getWorkingMemory("proj1");
      const proj2Entries = await service.getWorkingMemory("proj2");
      expect(proj1Entries).toHaveLength(1);
      expect(proj2Entries).toHaveLength(1);
    });

    it("stores metadata as JSON", async () => {
      await service.addWorkingMemory("proj1", "decision", "Use React", { rationale: "Fast" });
      const entries = await service.getWorkingMemory("proj1");
      expect(entries[0]!.metadata).toEqual({ rationale: "Fast" });
    });

    it("buildWorkingMemoryContext returns empty for no entries", async () => {
      const context = await service.buildWorkingMemoryContext("nonexistent");
      expect(context).toBe("");
    });

    it("buildWorkingMemoryContext formats entries", async () => {
      await service.addWorkingMemory("proj1", "decision", "Use React");
      await service.addWorkingMemory("proj1", "stage_complete", "build completed");
      const context = await service.buildWorkingMemoryContext("proj1");
      expect(context).toContain("[decision]");
      expect(context).toContain("[stage_complete]");
      expect(context).toContain("Recent Context");
    });
  });

  describe("Long-Term Memory (Tier 3)", () => {
    it("indexes and searches content", async () => {
      await service.indexMemory("React TypeScript Vite project shipped", "pipeline_summary", "Infastic", "proj1");
      const results = await service.searchLongTerm("React TypeScript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.projectName).toBe("Infastic");
    });

    it("handles FTS5 special characters gracefully", async () => {
      await service.indexMemory("Some content here", "test", "TestProject");
      const results = await service.searchLongTerm('test "with quotes" and (parens)');
      expect(Array.isArray(results)).toBe(true);
    });

    it("returns empty for empty query", async () => {
      const results1 = await service.searchLongTerm("");
      const results2 = await service.searchLongTerm("   ");
      expect(results1).toEqual([]);
      expect(results2).toEqual([]);
    });

    it("returns empty for query that sanitizes to nothing", async () => {
      const results = await service.searchLongTerm("!!! ??? ...");
      expect(results).toEqual([]);
    });

    it("strips FTS5 operators from query", async () => {
      await service.indexMemory("foo bar baz content", "test", "TestProject");
      const results = await service.searchLongTerm("foo OR bar AND baz NOT qux NEAR stuff");
      expect(Array.isArray(results)).toBe(true);
    });

    it("indexConversation stores exchange", async () => {
      service.indexConversation("proj1", "TestProject", "Build me an app", "Got it, starting now");
      const results = await service.searchLongTerm("Build me an app");
      expect(results.length).toBeGreaterThan(0);
    });

    it("buildLongTermContext returns empty for no matches", async () => {
      const context = await service.buildLongTermContext("nonexistent query xyz");
      expect(context).toBe("");
    });
  });

  describe("Cascade", () => {
    it("buildFullMemoryContext combines all tiers", async () => {
      knowledgeService.setFact("user.name", "Faryar");
      await service.addWorkingMemory("proj1", "decision", "Use SQLite");
      await service.indexMemory("React project completed", "pipeline_summary", "OldProject");

      const context = await service.buildFullMemoryContext("proj1", "React");
      expect(context).toContain("<memory>");
      expect(context).toContain("Faryar");
      expect(context).toContain("SQLite");
      expect(context).toContain("</memory>");
    });

    it("returns empty string when no memory exists", async () => {
      const context = await service.buildFullMemoryContext();
      expect(context).toBe("");
    });

    it("includes patterns in full memory context", async () => {
      await service.storePattern("prefers-concise", "communication", "User prefers short answers");
      await service.reinforcePattern("prefers-concise");
      const context = await service.buildFullMemoryContext();
      expect(context).toContain("Behavioral Patterns");
      expect(context).toContain("prefers short answers");
    });
  });

  describe("Pattern Memory", () => {
    it("stores a new pattern with initial confidence 0.3", async () => {
      await service.storePattern("likes-typescript", "technical", "User prefers TypeScript over JavaScript");
      const patterns = await service.getPatterns();
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.patternKey).toBe("likes-typescript");
      expect(patterns[0]!.confidence).toBe(0.3);
      expect(patterns[0]!.timesSeen).toBe(1);
    });

    it("reinforces pattern with +0.2 for first 3 sightings", async () => {
      await service.storePattern("tests-first", "workflow", "User runs tests before shipping");
      await service.reinforcePattern("tests-first");
      const after1 = await service.getPatterns();
      expect(after1[0]!.confidence).toBeCloseTo(0.5, 1);
      expect(after1[0]!.timesSeen).toBe(2);

      await service.reinforcePattern("tests-first");
      const after2 = await service.getPatterns();
      expect(after2[0]!.confidence).toBeCloseTo(0.7, 1);
    });

    it("caps confidence at 0.9", async () => {
      await service.storePattern("tests-first", "workflow", "User runs tests before shipping");
      for (let i = 0; i < 20; i++) {
        await service.reinforcePattern("tests-first");
      }
      const patterns = await service.getPatterns();
      expect(patterns[0]!.confidence).toBeLessThanOrEqual(0.9);
    });

    it("contradicts pattern by halving confidence", async () => {
      await service.storePattern("likes-tabs", "preference", "User prefers tabs");
      await service.reinforcePattern("likes-tabs");
      await service.contradictPattern("likes-tabs");
      const patterns = await service.getPatterns();
      expect(patterns[0]!.confidence).toBeCloseTo(0.25, 1);
    });

    it("deactivates pattern below 0.1 threshold", async () => {
      await service.storePattern("wrong-pattern", "preference", "Incorrect assumption");
      await service.contradictPattern("wrong-pattern");
      await service.contradictPattern("wrong-pattern");
      const patterns = await service.getPatterns();
      expect(patterns).toHaveLength(0);
    });

    it("findSimilarPattern finds patterns with >50% word overlap", async () => {
      await service.storePattern("prefers-concise-answers", "communication", "Likes short responses");
      const found = await service.findSimilarPattern("prefers-concise-responses");
      expect(found).not.toBeNull();
      expect(found!.patternKey).toBe("prefers-concise-answers");
    });

    it("storePattern deduplicates via findSimilarPattern", async () => {
      await service.storePattern("prefers-short-answers", "communication", "Likes brevity");
      await service.storePattern("prefers-short-responses", "communication", "Likes brevity v2");
      const patterns = await service.getPatterns();
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.patternKey).toBe("prefers-short-answers");
    });

    it("buildPatternContext returns empty when no patterns", async () => {
      expect(await service.buildPatternContext()).toBe("");
    });
  });
});
