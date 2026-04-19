import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import pino from "pino";
import { KnowledgeService, runMigrations, PACKAGE_VERSION } from "../src/index.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const logger = pino({ level: "silent" });

describe("PACKAGE_VERSION", () => {
  it("is 0.1.0", () => {
    expect(PACKAGE_VERSION).toBe("0.1.0");
  });
});

describe("runMigrations", () => {
  it("creates all memory tables", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('knowledge_facts', 'working_memory', 'memory_patterns')")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(3);
    db.close();
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db);
    db.close();
  });
});

describe("KnowledgeService", () => {
  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = createTestDb();
    service = new KnowledgeService(db, logger);
  });

  it("setFact and getFact round-trip", async () => {
    await service.setFact("user.name", "Faryar", "test");
    const fact = await service.getFact("user.name");
    expect(fact).not.toBeNull();
    expect(fact!.factValue).toBe("Faryar");
  });

  it("upserts on duplicate key", async () => {
    await service.setFact("user.name", "Alice", "test");
    await service.setFact("user.name", "Bob", "test2");
    const fact = await service.getFact("user.name");
    expect(fact!.factValue).toBe("Bob");
    expect(fact!.source).toBe("test2");
  });

  it("getFactsByPrefix filters correctly", async () => {
    await service.setFact("preference.stack", "React");
    await service.setFact("preference.db", "SQLite");
    await service.setFact("user.name", "Faryar");
    const prefs = await service.getFactsByPrefix("preference.");
    expect(prefs).toHaveLength(2);
  });

  it("deleteFact removes the fact", async () => {
    await service.setFact("temp.fact", "value");
    expect(await service.deleteFact("temp.fact")).toBe(true);
    expect(await service.getFact("temp.fact")).toBeNull();
    expect(await service.deleteFact("nonexistent")).toBe(false);
  });

  it("getAllFacts returns all stored facts", async () => {
    await service.setFact("user.name", "Faryar");
    await service.setFact("preference.stack", "React");
    const all = await service.getAllFacts();
    expect(all).toHaveLength(2);
  });

  it("getFact returns null for missing key", async () => {
    expect(await service.getFact("nonexistent")).toBeNull();
  });

  it("buildContextString returns empty for no facts", async () => {
    expect(await service.buildContextString()).toBe("");
  });

  it("buildContextString formats facts", async () => {
    await service.setFact("user.name", "Faryar");
    await service.setFact("preference.stack", "React + TypeScript");
    const context = await service.buildContextString();
    expect(context).toContain("Faryar");
    expect(context).toContain("React + TypeScript");
  });

  it("buildContextString respects 2000 char limit", async () => {
    for (let i = 0; i < 100; i++) {
      await service.setFact(`test.fact${i}`, "A".repeat(50));
    }
    const context = await service.buildContextString();
    expect(context.length).toBeLessThanOrEqual(2000);
  });

  it("setFact stores confidence and source", async () => {
    await service.setFact("user.name", "Faryar", "pipeline:test", "proj1", 0.8);
    const fact = await service.getFact("user.name");
    expect(fact!.confidence).toBe(0.8);
    expect(fact!.source).toBe("pipeline:test");
    expect(fact!.sourceProjectId).toBe("proj1");
  });
});
