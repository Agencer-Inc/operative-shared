# Changelog

## [0.1.0-alpha.1] - 2026-04-18

Initial extraction of `@agencer/voice-infrastructure` from OperativeX into the
`operative-shared` monorepo.

### Added
- **Voice pipeline factory** (`createVoiceAgent`): one-call setup for LiveKit + Deepgram STT + Cartesia TTS + Silero VAD
- **Custom pipeline support** (`createVoicePipeline`): assemble your own pipeline with swappable STT/TTS/VAD/Brain adapters
- **Voice debounce** (`shouldProcessVoiceRequest`): anti-loop guards including silence filter, dedup window, overlap protection, tool lock, and speaking gate with watchdog timer
- **Voice history** (`getVoiceHistory`, `addToVoiceHistory`): per-session conversation history with TTL-based auto-pruning and stale session sweeping
- **SSE parser** (`parseSSEStream`): OpenAI-compatible SSE stream parser with chunked buffer handling and EOF edge case coverage
- **SSE response helpers** (`sendSSEHeaders`, `sendSSEChunk`, `sendSSEDone`, `sendSSEError`): generic `SSEWritable` interface decoupled from Node/Express
- **Text processing** (`stripMarkdownForTTS`, `stripExpressionTags`, `isFragment`, `stripUICommands`): TTS-safe text transforms
- **Message format utilities** (`extractUserText`, `buildConversationHistory`, `wrapOpenAIResponse`): OpenAI-compatible message helpers
- **Three access patterns**: high-level convenience, subsystem namespaces, and individual named exports
- 115 tests across 5 suites covering debounce, history, SSE, text, and message-format modules

### Fixed
- SSE parser handles EOF without trailing newline (buffer remainder processing)
- Speaking gate includes 60s watchdog timer to prevent permanent session lockout if `markOxSilent()` is never called
- Conversation history capped at 20 entries to prevent unbounded memory growth
- Partial assistant responses preserved in history on stream error for context continuity
- Voice history stale session sweep runs lazily on read to prevent unbounded Map growth
