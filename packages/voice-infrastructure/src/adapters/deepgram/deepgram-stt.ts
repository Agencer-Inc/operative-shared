// ─────────────────────────────────────────────────────────────
// Deepgram STT Adapter
//
// Factory that creates a configured Deepgram STT instance
// for use in a LiveKit voice pipeline.
// ─────────────────────────────────────────────────────────────

import { STT as DeepgramSTT } from "@livekit/agents-plugin-deepgram";
import type { DeepgramConfig } from "../../types.js";

/**
 * Create a configured Deepgram STT instance.
 * Returns a ready-to-use STT plugin for a LiveKit VoicePipelineAgent.
 */
export function createDeepgramSTT(config?: DeepgramConfig): DeepgramSTT {
  return new DeepgramSTT({
    model: (config?.model ?? "nova-3") as "nova-3",
    language: config?.language ?? "en",
    punctuate: true,
    smartFormat: true,
    // Nova-3 uses keyterm prompting (not keywords). Passing keywords
    // to Nova-3 causes a 400 from the Deepgram WebSocket API.
    keyterm: config?.keywords,
  });
}
