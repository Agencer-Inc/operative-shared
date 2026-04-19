# @agencer/voice-infrastructure

Black-box voice pipeline: LiveKit rooms, Deepgram STT, Cartesia TTS, Silero VAD.
One install, full voice stack.

## Install

```bash
npm install @agencer/voice-infrastructure
```

## Quick Start

```ts
import { createVoiceAgent } from "@agencer/voice-infrastructure";

const agent = createVoiceAgent({
  livekit: {
    url: process.env.LIVEKIT_URL!,
    apiKey: process.env.LIVEKIT_API_KEY!,
    apiSecret: process.env.LIVEKIT_API_SECRET!,
  },
  brain: {
    endpoint: "http://localhost:3000/api/voice/chat/completions",
  },
});

agent.start();
```

The agent connects to LiveKit Cloud via WebSocket, processes voice sessions
in-process, and delegates LLM inference to the brain endpoint over HTTP.

## Three Access Patterns

### 1. High-level convenience

```ts
import { createVoiceAgent } from "@agencer/voice-infrastructure";
```

One call, full pipeline. Wire LiveKit + Deepgram + Cartesia + Silero into a
complete voice agent. You provide a brain endpoint URL. Everything else has
sensible defaults.

### 2. Subsystem namespaces

```ts
import { debounce, history, sse, text, messageFormat, adapters } from "@agencer/voice-infrastructure";

debounce.shouldProcessVoiceRequest("build me a todo app");
text.stripMarkdownForTTS("**Hello** world");
sse.parseSSEStream(response);
```

### 3. Individual primitives

```ts
import {
  shouldProcessVoiceRequest,
  stripMarkdownForTTS,
  parseSSEStream,
  createDeepgramSTT,
  createCartesiaTTS,
  loadSileroVAD,
  createVoicePipeline,
} from "@agencer/voice-infrastructure";
```

Every function and type is also available as a direct named export.

## Config

```ts
interface VoiceInfraConfig {
  livekit: LiveKitConfig;
  brain: BrainConfig;
  deepgram?: DeepgramConfig;
  cartesia?: CartesiaConfig;
  serverPort?: number;
}
```

| Config | Required | Default |
|--------|----------|---------|
| `livekit.url` | Yes | - |
| `livekit.apiKey` | Yes | - |
| `livekit.apiSecret` | Yes | - |
| `brain.endpoint` | Yes | - |
| `brain.transcriptEndpoint` | No | - |
| `deepgram.model` | No | `"nova-3"` |
| `deepgram.language` | No | `"en"` |
| `deepgram.keywords` | No | - |
| `cartesia.model` | No | `"sonic-2-2025-03-07"` |
| `cartesia.voiceId` | No | Default Cartesia voice |
| `cartesia.language` | No | `"en"` |
| `serverPort` | No | `3001` |

## Custom Pipelines

For consumers who want to assemble their own pipeline with custom components:

```ts
import {
  createDeepgramSTT,
  createCartesiaTTS,
  loadSileroVAD,
  createVoicePipeline,
} from "@agencer/voice-infrastructure";
import type { BrainAdapter } from "@agencer/voice-infrastructure";

const myBrain: BrainAdapter = {
  async *chat(messages) {
    // Your LLM logic here — yield text chunks
    yield "Hello ";
    yield "world!";
  },
};

const vad = await loadSileroVAD();
const stt = createDeepgramSTT({ model: "nova-3" });
const tts = createCartesiaTTS();

const { agent, session } = createVoicePipeline({
  vad, stt, tts,
  brainAdapter: myBrain,
});

// Start with a LiveKit room
await session.start({ agent, room });
```

## Modules

| Module | Exports | Purpose |
|--------|---------|---------|
| `session/voice-debounce` | 9 functions | Anti-loop guards: silence filter, dedup window, overlap protection, tool lock, speaking gate |
| `session/voice-history` | 5 functions | Per-session conversation history with auto-trim |
| `sse/` | 5 functions | SSE stream parser + response helpers (generic `SSEWritable` interface) |
| `text/` | 4 functions | TTS text processing: strip markdown, strip expression tags, fragment detection, UI command stripper |
| `message-format/` | 3 functions | OpenAI-compatible message utilities |
| `adapters/` | 4 factories + 1 type | Deepgram STT, Cartesia TTS, Silero VAD, voice pipeline assembly |
| `agent/` | 1 factory | High-level `createVoiceAgent()` |

## Brain Protocol

The voice agent communicates with the brain entirely via HTTP POST:

```
POST /api/voice/chat/completions
Content-Type: application/json

{ "messages": [{ "role": "user", "content": "Build me a todo app" }] }
```

Response: SSE stream (OpenAI-compatible `text/event-stream` format).

This keeps the voice pipeline fully decoupled from any specific brain
implementation. The brain can be an LLM, a RAG system, or anything that
returns an SSE stream of text chunks.

## Development

```bash
npm run build      # TypeScript compilation
npm run typecheck   # Type checking without emit
npm test           # Run all 111 tests
```

## License

MIT
