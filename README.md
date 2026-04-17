# operative-shared

Agencer shared packages consumed by OperativeX, Operative2, and future operatives. TypeScript pnpm monorepo.

## Packages

- [`@agencer/voice-infrastructure`](./packages/voice-infrastructure) — Voice pipeline primitives: LiveKit, Deepgram, Cartesia, SSML transforms.
- [`@agencer/total-recall`](./packages/total-recall) — Memory engine: SQLite+FTS5, pgvector, episodic and semantic recall.
- [`@agencer/ui-primitives`](./packages/ui-primitives) — Shared React UI: Eagle Eye, chat panel, hand gesture controls.
- [`@agencer/deferred-tools-registry`](./packages/deferred-tools-registry) — Tool-search and deferred loading registry for operatives.

## Install

These packages publish to GitHub Packages under the `@agencer` scope.

```bash
# .npmrc in your project
@agencer:registry=https://npm.pkg.github.com

# Install
npm install @agencer/voice-infrastructure @agencer/total-recall @agencer/ui-primitives @agencer/deferred-tools-registry
```

A valid `NODE_AUTH_TOKEN` (GitHub PAT with `read:packages`) is required.

## Protocol

The Agencer Network Protocol spec lives in [Agencer-Inc/operative-protocol](https://github.com/Agencer-Inc/operative-protocol).

## Publishing

All four packages publish together on tag push (`v*`) via `.github/workflows/publish.yml`.

## License

Apache-2.0
