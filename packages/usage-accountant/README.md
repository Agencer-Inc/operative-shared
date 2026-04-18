# @agencer/usage-accountant

Metering, per-user attribution, and named sub-meters for Agencer products. Every paid-model call in any Agencer product routes through this Lego. Tracks per-user attribution with sub-meter discipline, using raw rows as the unit of truth.

## Status

Stub. This package currently exports sub-meter constants only. The real implementation lands in migration Phase 2, when the usage-accountant code shipped in OperativeX PR #255 is extracted into this package.

## Usage

```ts
import { PACKAGE_VERSION, SUB_METERS } from "@agencer/usage-accountant";

console.log(PACKAGE_VERSION);
// "@agencer/usage-accountant/0.1.0-alpha.0"

console.log(SUB_METERS);
// ["FACT_RECALL", "FACT_EXTRACTION", ..., "LIVEKIT_BANDWIDTH"]
```
