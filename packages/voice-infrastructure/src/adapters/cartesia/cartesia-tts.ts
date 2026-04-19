// ─────────────────────────────────────────────────────────────
// Cartesia TTS Adapter
//
// Factory that creates a configured Cartesia TTS instance
// for use in a LiveKit voice pipeline.
// ─────────────────────────────────────────────────────────────

import { TTS as CartesiaTTS } from "@livekit/agents-plugin-cartesia";
import type { CartesiaConfig } from "../../types.js";

const DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";

/**
 * Create a configured Cartesia TTS instance.
 * Returns a ready-to-use TTS plugin for a LiveKit VoicePipelineAgent.
 */
export function createCartesiaTTS(config?: CartesiaConfig): CartesiaTTS {
  return new CartesiaTTS({
    model: config?.model ?? "sonic-2-2025-03-07",
    voice: config?.voiceId ?? DEFAULT_VOICE_ID,
    language: "en",
    speed: config?.speed ?? "normal",
  });
}
