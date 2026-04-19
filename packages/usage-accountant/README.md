# @agencer/usage-accountant

Per-call cost attribution with named sub-meters. Every API call that costs money is recorded as a raw row in `usage_ledger`. Aggregation happens at query time.

## Install

```bash
npm install @agencer/usage-accountant
# Peer dependencies:
npm install better-sqlite3 pino
```

## Usage

```typescript
import Database from "better-sqlite3";
import pino from "pino";
import {
  UsageAccountant,
  UsageComponent,
  callHaikuMetered,
  runMigrations,
} from "@agencer/usage-accountant";

// 1. Create / open your SQLite database
const db = new Database("./app.db");

// 2. Run migrations (idempotent)
runMigrations(db);

// 3. Create the accountant
const logger = pino();
const accountant = new UsageAccountant(db, logger);

// 4. Record a call manually
accountant.recordCall({
  userId: "user-1",
  sessionId: "session-abc",
  component: UsageComponent.FACT_RECALL,
  model: "claude-haiku-4-5-20251001",
  inputTokens: 500,
  outputTokens: 50,
  latencyMs: 200,
});

// 5. Or use the metered Haiku wrapper (makes the API call AND records usage)
const response = await callHaikuMetered(
  {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello" }],
  },
  UsageComponent.BRAIN_HAIKU,
  "user-1",
  "session-abc",
  accountant,
);

// 6. Query usage
const breakdown = accountant.getUserUsage("user-1");
console.log(breakdown);
// [{ component: "soft_logic.fact_recall", totalInputTokens: 500, ... }]
```

## API

### `runMigrations(db: Database)`
Creates the `usage_ledger` table. Idempotent.

### `new UsageAccountant(db: Database, logger: Logger)`
Main service class. Never throws on record/query failures.

### `callHaikuMetered(params, component, userId, sessionId, accountant)`
Makes an Anthropic API call and automatically records token usage.

### `UsageComponent`
Enum of named sub-meter constants (e.g., `FACT_RECALL`, `BRAIN_SONNET`).

## License

Apache-2.0
