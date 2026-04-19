import { describe, it, expect, vi, beforeEach } from "vitest";
import { recallWithHaiku } from "../src/index.js";
import type { RecallContext } from "../src/index.js";

// Minimal mock types matching the real interfaces
function makeMockMemoryService(opts: {
  longTermResults?: Array<{ content: string; sourceType: string; projectName: string; createdAt: string }>;
  patterns?: Array<{ patternKey: string; category: string; confidence: number; timesSeen: number; description: string; id: string; lastSeen: string; createdAt: string }>;
  episodicResults?: Array<{ sessionId: string; role: string; content: string; createdAt: string }>;
}) {
  return {
    searchLongTerm: vi.fn().mockResolvedValue(opts.longTermResults ?? []),
    getPatterns: vi.fn().mockResolvedValue(opts.patterns ?? []),
    recallEpisodic: vi.fn().mockResolvedValue(opts.episodicResults ?? []),
    // Stubs for other MemoryService methods
    addWorkingMemory: vi.fn(),
    getWorkingMemory: vi.fn().mockReturnValue([]),
    indexMemory: vi.fn(),
    indexConversation: vi.fn(),
    storePattern: vi.fn(),
    reinforcePattern: vi.fn(),
    contradictPattern: vi.fn(),
    findSimilarPattern: vi.fn().mockReturnValue(null),
    buildPatternContext: vi.fn().mockReturnValue(""),
    buildWorkingMemoryContext: vi.fn().mockReturnValue(""),
    buildLongTermContext: vi.fn().mockReturnValue(""),
    buildFullMemoryContext: vi.fn().mockReturnValue(""),
  };
}

function makeMockKnowledgeService(facts: Array<{ factKey: string; factValue: string; id: string; source: string | null; sourceProjectId: string | null; confidence: number; createdAt: string; updatedAt: string }>) {
  return {
    getAllFacts: vi.fn().mockResolvedValue(facts),
    getFact: vi.fn().mockReturnValue(null),
    getFactsByPrefix: vi.fn().mockReturnValue([]),
    setFact: vi.fn(),
    deleteFact: vi.fn(),
    buildContextString: vi.fn().mockReturnValue(""),
  };
}

function makeCtx(overrides: Partial<RecallContext> = {}): RecallContext {
  return {
    knowledgeService: makeMockKnowledgeService([]) as unknown as RecallContext["knowledgeService"],
    memoryService: makeMockMemoryService({}) as unknown as RecallContext["memoryService"],
    ...overrides,
  };
}

describe("recallWithHaiku - multi-tier memory search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when query is empty", async () => {
    const result = await recallWithHaiku("", makeCtx());
    expect(result).toContain("Error: query is required");
  });

  it("returns error when query is too short (prevents '.' dumping all facts)", async () => {
    const result = await recallWithHaiku(".", makeCtx());
    expect(result).toContain("at least 2 letters or digits");
  });

  it("returns error when query is whitespace-only", async () => {
    const result = await recallWithHaiku("   ", makeCtx());
    expect(result).toContain("Error: query is required");
  });

  it("searches knowledge_facts (Tier 1) when knowledgeService is available", async () => {
    const ks = makeMockKnowledgeService([
      { factKey: "user.name", factValue: "Faryar", id: "1", source: "voice", sourceProjectId: null, confidence: 0.9, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
      { factKey: "preference.stack", factValue: "React + TypeScript", id: "2", source: "voice", sourceProjectId: null, confidence: 0.8, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
    ]);
    const ms = makeMockMemoryService({});
    const ctx = makeCtx({
      memoryService: ms as unknown as RecallContext["memoryService"],
      knowledgeService: ks as unknown as RecallContext["knowledgeService"],
    });

    const result = await recallWithHaiku("name", ctx);
    expect(result).toContain("user.name = Faryar");
    expect(result).toContain("Known facts");
    // Should NOT include the stack preference (doesn't match "name")
    expect(result).not.toContain("React + TypeScript");
  });

  it("searches memory_patterns (Tier 1.5)", async () => {
    const ms = makeMockMemoryService({
      patterns: [
        { patternKey: "direct-no-nonsense", category: "communication", confidence: 0.7, timesSeen: 3, description: "User prefers direct communication", id: "1", lastSeen: "2025-01-01", createdAt: "2025-01-01" },
        { patternKey: "monitors-pipeline-progress", category: "workflow", confidence: 0.5, timesSeen: 2, description: "User checks pipeline", id: "2", lastSeen: "2025-01-01", createdAt: "2025-01-01" },
      ],
    });
    const ctx = makeCtx({ memoryService: ms as unknown as RecallContext["memoryService"] });

    const result = await recallWithHaiku("communication", ctx);
    expect(result).toContain("direct-no-nonsense");
    expect(result).toContain("Behavioral patterns");
    expect(result).toContain("communication");
  });

  it("searches FTS5 long-term memory (Tier 3)", async () => {
    const ms = makeMockMemoryService({
      longTermResults: [
        { content: "User said: What projects have we built together?", sourceType: "conversation", projectName: "default", createdAt: "2025-03-15" },
      ],
    });
    const ctx = makeCtx({ memoryService: ms as unknown as RecallContext["memoryService"] });

    const result = await recallWithHaiku("projects", ctx);
    expect(result).toContain("Conversations & pipelines");
    expect(result).toContain("What projects have we built together");
  });

  it("combines results from multiple tiers", async () => {
    const ks = makeMockKnowledgeService([
      { factKey: "project.tracker.outcome", factValue: "Shipped fasting tracker", id: "1", source: "voice", sourceProjectId: "p1", confidence: 0.9, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
    ]);
    const ms = makeMockMemoryService({
      patterns: [
        { patternKey: "monitors-pipeline-progress", category: "workflow", confidence: 0.5, timesSeen: 2, description: "User checks pipeline", id: "1", lastSeen: "2025-01-01", createdAt: "2025-01-01" },
      ],
      longTermResults: [
        { content: "Pipeline completed for tracker project", sourceType: "pipeline", projectName: "tracker", createdAt: "2025-03-01" },
      ],
    });
    const ctx = makeCtx({
      memoryService: ms as unknown as RecallContext["memoryService"],
      knowledgeService: ks as unknown as RecallContext["knowledgeService"],
    });

    const result = await recallWithHaiku("tracker", ctx);
    expect(result).toContain("Known facts");
    expect(result).toContain("Shipped fasting tracker");
    expect(result).toContain("Conversations & pipelines");
    expect(result).toContain("Pipeline completed for tracker project");
  });

  it("returns 'no memories' when all tiers return nothing", async () => {
    const ks = makeMockKnowledgeService([]);
    const ms = makeMockMemoryService({});
    const ctx = makeCtx({
      memoryService: ms as unknown as RecallContext["memoryService"],
      knowledgeService: ks as unknown as RecallContext["knowledgeService"],
    });

    const result = await recallWithHaiku("xyznonexistent", ctx);
    expect(result).toContain("No memories found");
  });

  it("searches episodic transcripts (Tier 4)", async () => {
    const ms = makeMockMemoryService({
      episodicResults: [
        { sessionId: "proj1", role: "user", content: "Tell me about the fasting tracker architecture", createdAt: "2025-03-20 10:30:00" },
        { sessionId: "proj1", role: "assistant", content: "The fasting tracker uses React with a SQLite backend", createdAt: "2025-03-20 10:30:05" },
      ],
    });
    const ctx = makeCtx({ memoryService: ms as unknown as RecallContext["memoryService"] });

    const result = await recallWithHaiku("fasting tracker", ctx);
    expect(result).toContain("Voice transcripts");
    expect(result).toContain("fasting tracker architecture");
    expect(result).toContain("[user]");
    expect(result).toContain("[assistant]");
  });

  it("combines Tier 4 episodic with other tiers", async () => {
    const ks = makeMockKnowledgeService([
      { factKey: "project.dashboard.stack", factValue: "React + SQLite", id: "1", source: "voice", sourceProjectId: "p1", confidence: 0.9, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
    ]);
    const ms = makeMockMemoryService({
      episodicResults: [
        { sessionId: "proj1", role: "user", content: "What stack should we use for the dashboard?", createdAt: "2025-03-20 10:00:00" },
      ],
      longTermResults: [
        { content: "Pipeline completed for dashboard project", sourceType: "pipeline", projectName: "dashboard", createdAt: "2025-03-01" },
      ],
    });
    const ctx = makeCtx({
      memoryService: ms as unknown as RecallContext["memoryService"],
      knowledgeService: ks as unknown as RecallContext["knowledgeService"],
    });

    const result = await recallWithHaiku("dashboard", ctx);
    expect(result).toContain("Known facts");
    expect(result).toContain("Conversations & pipelines");
    expect(result).toContain("Voice transcripts");
  });

  it("handles empty episodic results gracefully", async () => {
    const ms = makeMockMemoryService({ episodicResults: [] });
    const ctx = makeCtx({ memoryService: ms as unknown as RecallContext["memoryService"] });

    const result = await recallWithHaiku("nonexistent", ctx);
    expect(result).toContain("No memories found");
    expect(result).not.toContain("Voice transcripts");
  });
});
