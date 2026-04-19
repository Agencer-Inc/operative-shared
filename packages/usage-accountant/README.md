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

## Configuration

### Environment variables

| Variable | Required? | Default | Description |
|----------|-----------|---------|-------------|
| `OX_USER_ID` | **Yes** | `"default"` | The user ID attributed to every `usage_ledger` record created via `defaultUserContext()`. Set this to the stable user identifier for the operative's operator **before first run**. If unset, all records are attributed to `"default"`, which splits billing history across users and makes per-user cost queries meaningless. Changing it later means prior records remain attributed to the previous value. |

```bash
# Shell profile, or .env if your app loads dotenv
export OX_USER_ID="faryar"
```

> `ANTHROPIC_API_KEY` is **not** read from the environment by this package. It is passed explicitly as the `apiKey` parameter to `callHaikuMetered()`.

## Gotchas

- **`userId='default'` in your ledger?** `OX_USER_ID` was not set when `defaultUserContext()` was called. There is no automatic rekey. Records written with the old value stay attributed to that value. Set the variable, and only new records will use the corrected ID.

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
