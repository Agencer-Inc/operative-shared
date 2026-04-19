// ─────────────────────────────────────────────────────────────
// Silero VAD Adapter
//
// Loads the Silero Voice Activity Detection model.
// ─────────────────────────────────────────────────────────────

import * as silero from "@livekit/agents-plugin-silero";

/**
 * Load the Silero VAD model into memory.
 * This is typically called during agent prewarm to avoid cold-start latency.
 */
export async function loadSileroVAD(): Promise<silero.VAD> {
  return silero.VAD.load();
}
