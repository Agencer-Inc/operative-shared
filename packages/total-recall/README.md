# @agencer/total-recall

5-tier memory engine for Agencer operatives. SQLite + FTS5 for local search, optional pgvector for semantic recall, Haiku-driven extraction and retrieval.

## Tiers

| Tier | What | Storage |
|------|------|---------|
| 1 | Knowledge facts (KV) | `knowledge_facts` table |
| 1.5 | Behavioral patterns | `memory_patterns` table |
| 2 | Working memory | `working_memory` table |
| 3 | Long-term FTS | `memory_fts` virtual table |
| 4 | Episodic (optional) | Postgres with pgvector |

## Usage

```typescript
import Database from "better-sqlite3";
import pino from "pino";
import {
  KnowledgeService,
  MemoryService,
  ExtractionPipeline,
  recallWithHaiku,
  runMigrations,
} from "@agencer/total-recall";
import { UsageAccountant, runMigrations as runUaMigrations } from "@agencer/usage-accountant";

// 1. Set up database
const db = new Database("./memory.db");
db.pragma("journal_mode = WAL");
runMigrations(db);
runUaMigrations(db);

const logger = pino();

// 2. Create services
const knowledgeService = new KnowledgeService(db, logger);
const memoryService = new MemoryService(db, knowledgeService, logger, {
  onEvent: (event) => console.log("memory event:", event.type),
  embed: async (text) => {
    // your embedding function here, or omit for FTS-only
    return null;
  },
});

// 3. Store and retrieve facts
knowledgeService.setFact("user.name", "Faryar", "voice");
const fact = knowledgeService.getFact("user.name");

// 4. Extract facts from conversations (fire-and-forget)
const accountant = new UsageAccountant(db, logger);
const pipeline = new ExtractionPipeline("sk-ant-...", knowledgeService, logger);
pipeline.setMemoryService(memoryService);
pipeline.setUsageAccountant(accountant);

pipeline.extractFromConversation("My name is Faryar", "Nice to meet you!", "proj1");

// 5. Recall across all tiers
const result = await recallWithHaiku("what is the user's name", {
  knowledgeService,
  memoryService,
  usageAccountant: accountant,
});
// => Memory search for "what is the user's name":
//    **Known facts (1):**
//    - user.name = Faryar
```

## API

### KnowledgeService

- `setFact(key, value, source?, projectId?, confidence?)` - Store a fact
- `getFact(key, product?)` - Retrieve a single fact
- `getFactsByPrefix(prefix, product?)` - Get facts by key prefix
- `getAllFacts(product?)` - Get all facts
- `deleteFact(key, product?)` - Delete a fact
- `buildContextString(product?)` - Format facts for LLM context injection

### MemoryService

- `addWorkingMemory(projectId, type, content, metadata?)` - Add working memory entry
- `getWorkingMemory(projectId)` - Get working memory for a project
- `indexMemory(content, sourceType, projectName, projectId?)` - Index for FTS search
- `indexConversation(projectId, projectName, userMsg, assistantMsg)` - Index a conversation
- `searchLongTerm(query, limit?, product?)` - FTS5 full-text search
- `storePattern(key, category, description, product?)` - Store a behavioral pattern
- `reinforcePattern(key, product?)` - Increase pattern confidence
- `contradictPattern(key, product?)` - Decrease pattern confidence (deactivates below 0.1)
- `buildFullMemoryContext(projectId?, query?, product?)` - Build full memory cascade

### ExtractionPipeline

- `extractAndStore(input, source)` - Extract facts/patterns from text via Haiku
- `extractFromConversation(userMsg, assistantMsg, projectId)` - Fire-and-forget extraction
- `extractFromPipeline(projectId, projectName, goal, stageOutputs, shipped, tokenBudget)` - Extract from pipeline output

### Recall

- `recallFactsWithHaiku(query, allFacts, queryLower, ctx)` - Haiku-driven fact selection with substring fallback
- `recallWithHaiku(query, ctx)` - Full multi-tier memory search
