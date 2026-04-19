// ─────────────────────────────────────────────────────────────
// Shared types for @agencer/voice-infrastructure
// ─────────────────────────────────────────────────────────────

// ── Configuration ────────────────────────────────────────────

export interface VoiceInfraConfig {
  livekit: LiveKitConfig;
  deepgram?: DeepgramConfig;
  cartesia?: CartesiaConfig;
  brain: BrainConfig;
  /** Express/server port for brain URL derivation. Default: 3001 */
  serverPort?: number;
}

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface DeepgramConfig {
  /** Deepgram model. Default: "nova-3" */
  model?: string;
  /** Language code. Default: "en" */
  language?: string;
  /** Keyterm prompting hints (Nova-3 uses keyterm, not keywords). */
  keywords?: string[];
}

export interface CartesiaConfig {
  /** Cartesia voice UUID. Default: built-in OX voice. */
  voiceId?: string;
  /** TTS speed. Default: "normal" */
  speed?: "fastest" | "fast" | "normal" | "slow" | "slowest";
  /** Cartesia model. Default: "sonic-2-2025-03-07" */
  model?: string;
}

export interface BrainConfig {
  /** URL for POST chat/completions (SSE streaming response). */
  endpoint: string;
  /** URL for POST user-transcript forwarding (fire-and-forget). */
  transcriptEndpoint?: string;
}

// ── Agent ────────────────────────────────────────────────────

export interface VoiceAgent {
  /** Start the LiveKit agent worker. Long-running, connects via WebSocket. */
  start(): void;
  /** Graceful shutdown: disconnect rooms, close streams, clean up. */
  stop(): Promise<void>;
}

/** Brain adapter for custom pipeline assembly (bypass HTTP). */
export interface BrainAdapter {
  chat(
    history: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string>;
}

// ── SSE ──────────────────────────────────────────────────────

/**
 * Generic writable interface for SSE responses.
 * Express Response, Node http.ServerResponse, and Fastify Reply all satisfy this.
 */
export interface SSEWritable {
  writeHead?(statusCode: number, headers: Record<string, string>): void;
  setHeader?(name: string, value: string): void;
  flushHeaders?(): void;
  write(data: string): boolean;
  end(): void;
}

// ── Message Format ───────────────────────────────────────────

/** OpenAI-compatible message format (used by ElevenLabs, LiveKit, etc.) */
export interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/** OpenAI-compatible chat completion response. */
export interface OpenAIChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string;
    };
  }>;
}

// ── Text Processing ──────────────────────────────────────────

/** Parsed UI command extracted from streaming text. */
export interface UICommand {
  action: string;
  target?: string;
  value?: string;
}

/** Stateful streaming UI command stripper. */
export interface UICommandStripper {
  feed(delta: string): { cleanText: string; commands: UICommand[] };
  flush(): { cleanText: string; commands: UICommand[] };
}

// ── Debounce ─────────────────────────────────────────────────

export type VoiceRequestResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// ── History ──────────────────────────────────────────────────

export interface HistoryEntry {
  role: string;
  content: string;
  timestamp: number;
}
