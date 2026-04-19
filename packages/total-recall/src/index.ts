// ── Knowledge Service (Tier 1) ──
export { KnowledgeService } from "./knowledge-service.js";
export type { KnowledgeFact, ProductId } from "./knowledge-service.js";

// ── Memory Service (Tier 2, 3, 1.5, 4) ──
export { MemoryService } from "./memory-service.js";
export type {
  WorkingMemoryEntry,
  MemoryPattern,
  LongTermSearchResult,
  MemoryServiceOptions,
  OnEventCallback,
  EmbedFunction,
} from "./memory-service.js";

// ── Extraction Pipeline ──
export { ExtractionPipeline } from "./extraction-pipeline.js";

// ── Recall ──
export { recallFactsWithHaiku, recallWithHaiku } from "./recall.js";
export type { RecallContext } from "./recall.js";

// ── Migrations ──
export { runMigrations } from "./run-migrations.js";

// ── Package metadata ──
export const PACKAGE_VERSION = "0.1.0";
