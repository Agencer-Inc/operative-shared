// ─────────────────────────────────────────────────────────────
// @agencer/voice-infrastructure — Public API
//
// Three access patterns:
//   1. High-level convenience  → createVoiceAgent(config)
//   2. Subsystem namespaces    → import { debounce, sse, text } from "..."
//   3. Individual primitives   → import { parseSSEStream } from "..."
// ─────────────────────────────────────────────────────────────

// ── Package metadata ──────────────────────────────────────────
export const PACKAGE_NAME = "@agencer/voice-infrastructure";
export const VERSION = "0.1.0-alpha.1";

// ── Types (all interfaces + type aliases) ─────────────────────
export type {
  VoiceInfraConfig,
  LiveKitConfig,
  DeepgramConfig,
  CartesiaConfig,
  BrainConfig,
  VoiceAgent,
  BrainAdapter,
  SSEWritable,
  OpenAIMessage,
  OpenAIChatCompletionResponse,
  UICommand,
  UICommandStripper,
  VoiceRequestResult,
  HistoryEntry,
} from "./types.js";

// ── High-level convenience ────────────────────────────────────
export { createVoiceAgent } from "./agent/create-voice-agent.js";

// ── Adapter factories (individual primitives) ─────────────────
export { createDeepgramSTT } from "./adapters/deepgram/deepgram-stt.js";
export { createCartesiaTTS } from "./adapters/cartesia/cartesia-tts.js";
export { loadSileroVAD } from "./adapters/silero/silero-vad.js";
export { createVoicePipeline } from "./adapters/voice-pipeline.js";
export type { VoicePipelineOptions } from "./adapters/voice-pipeline.js";

// ── Session primitives (individual) ───────────────────────────
export {
  shouldProcessVoiceRequest,
  markVoiceRequestComplete,
  markToolsActive,
  markToolsComplete,
  isToolsActive,
  markOxSpeaking,
  markOxSilent,
  isOxSpeaking,
  resetVoiceDebounce,
} from "./session/voice-debounce.js";

export {
  getVoiceHistory,
  hasVoiceHistory,
  addToVoiceHistory,
  getVoiceHistoryWithTimestamps,
  clearVoiceHistory,
} from "./session/voice-history.js";

// ── SSE primitives (individual) ───────────────────────────────
export { parseSSEStream } from "./sse/sse-parser.js";
export {
  initSSE,
  sendSSEChunk,
  sendSSEDone,
  sendSSEResponse,
} from "./sse/sse-helpers.js";

// ── Text processing primitives (individual) ───────────────────
export { stripMarkdownForTTS } from "./text/strip-markdown.js";
export { stripExpressionTags } from "./text/strip-expressions.js";
export { isFragment } from "./text/fragment-detection.js";
export { createUICommandStripper } from "./text/ui-command-stripper.js";

// ── Message format primitives (individual) ────────────────────
export {
  extractUserText,
  buildConversationHistory,
  wrapOpenAIResponse,
} from "./message-format/message-format.js";

// ── Subsystem namespaces ──────────────────────────────────────
// Usage: import { debounce, history, sse, text, messageFormat, adapters } from "@agencer/voice-infrastructure"

import * as _debounce from "./session/voice-debounce.js";
import * as _history from "./session/voice-history.js";
import * as _sse from "./sse/index.js";
import * as _text from "./text/index.js";
import * as _messageFormat from "./message-format/index.js";
import * as _adapters from "./adapters/index.js";

export const debounce = _debounce;
export const history = _history;
export const sse = _sse;
export const text = _text;
export const messageFormat = _messageFormat;
export const adapters = _adapters;
