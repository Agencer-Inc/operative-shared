// ─────────────────────────────────────────────────────────────
// Voice Debounce
//
// Provider-agnostic server-side debounce for the voice endpoint.
// Rejects duplicate/overlapping requests from partial transcripts.
//
// Two guards:
//   1. Duplicate text: same userText within DEDUP_WINDOW_MS -> reject
//   2. Overlap: new request while previous is still streaming -> reject
//
// All thresholds are tunable. No provider-specific logic.
// ─────────────────────────────────────────────────────────────

import type { VoiceRequestResult } from "../types.js";

const DEDUP_WINDOW_MS = 2000; // Ignore identical text within 2s
const MIN_INPUT_LENGTH = 2; // Reject inputs shorter than 2 chars (breathing/silence)
const SILENCE_PATTERNS = /^[\s.,!?…\-—–]+$/; // Only punctuation/whitespace

interface PendingRequest {
  text: string;
  timestamp: number;
  streaming: boolean;
  toolsActive: boolean; // True while Brain is executing tools (2-5s)
}

let lastRequest: PendingRequest | null = null;

// Hard gate: when the operative is speaking, DROP all incoming STT transcripts.
// Prevents infinite loop where TTS audio is picked up by VAD/STT
// and fed back as user input.
let _oxSpeaking = false;

// Cooldown: TTS audio continues playing ~15-20s after the Brain stream
// ends. Keep the gate up for a buffer period after markOxSilent() so
// tail-end TTS audio doesn't re-trigger the loop.
const OX_SPEAKING_COOLDOWN_MS = 3000;
let _oxSpeakingCooldownTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Check whether this voice request should be processed or rejected.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function shouldProcessVoiceRequest(
  userText: string,
): VoiceRequestResult {
  const trimmed = userText.trim();

  // Guard 0: Operative is speaking -- hard reject.
  // TTS audio leaks into the mic, VAD fires, STT transcribes the operative's own
  // speech as "user input". Without this gate, the pipeline loops
  // indefinitely: operative speaks -> mic picks up -> STT -> Brain -> operative speaks.
  if (_oxSpeaking) {
    return { allowed: false, reason: "ox_speaking" };
  }

  // Guard 1: Empty/silence input
  if (trimmed.length < MIN_INPUT_LENGTH) {
    return { allowed: false, reason: "input_too_short" };
  }

  if (SILENCE_PATTERNS.test(trimmed)) {
    return { allowed: false, reason: "silence_punctuation" };
  }

  // Guard 2: Duplicate text within dedup window
  const now = Date.now();
  if (
    lastRequest &&
    lastRequest.text === trimmed &&
    now - lastRequest.timestamp < DEDUP_WINDOW_MS
  ) {
    return { allowed: false, reason: "duplicate_within_window" };
  }

  // Guard 3: Previous request still streaming (overlap)
  // If tools are executing, reject -- the user should wait.
  // If just streaming (TTS playing), allow as an interruption --
  // the user is speaking over the operative, which is a natural turn-take.
  if (lastRequest?.streaming) {
    if (lastRequest.toolsActive) {
      return { allowed: false, reason: "tools_in_progress" };
    }
    // Interruption: mark previous request complete to allow this one.
    lastRequest.streaming = false;
  }

  // Allowed -- record this request
  lastRequest = { text: trimmed, timestamp: now, streaming: true, toolsActive: false };
  return { allowed: true };
}

/**
 * Mark the current voice request as complete (stream finished).
 * Call this after the SSE stream ends (success or error).
 */
export function markVoiceRequestComplete(): void {
  if (lastRequest) {
    lastRequest.streaming = false;
    lastRequest.toolsActive = false;
  }
}

/**
 * Mark that tool execution is in progress for the current request.
 * While tools are active, new requests are rejected with "tools_in_progress"
 * instead of generic "previous_still_streaming".
 */
export function markToolsActive(): void {
  if (lastRequest) {
    lastRequest.toolsActive = true;
  }
}

/**
 * Mark tool execution as complete for the current request.
 * The request itself may still be streaming the follow-up response.
 */
export function markToolsComplete(): void {
  if (lastRequest) {
    lastRequest.toolsActive = false;
  }
}

/**
 * Check if tools are currently executing.
 */
export function isToolsActive(): boolean {
  return lastRequest?.toolsActive ?? false;
}

/**
 * Signal that the operative has started speaking (TTS streaming).
 * While this flag is set, ALL incoming STT transcripts are dropped.
 * Cancels any pending cooldown timer from a previous markOxSilent().
 */
export function markOxSpeaking(): void {
  if (_oxSpeakingCooldownTimer) {
    clearTimeout(_oxSpeakingCooldownTimer);
    _oxSpeakingCooldownTimer = null;
  }
  _oxSpeaking = true;
}

/**
 * Signal that the operative Brain stream has ended. The gate stays up for
 * OX_SPEAKING_COOLDOWN_MS to account for TTS audio still playing
 * through speakers after the text stream finishes.
 */
export function markOxSilent(): void {
  if (_oxSpeakingCooldownTimer) {
    clearTimeout(_oxSpeakingCooldownTimer);
  }
  _oxSpeakingCooldownTimer = setTimeout(() => {
    _oxSpeaking = false;
    _oxSpeakingCooldownTimer = null;
  }, OX_SPEAKING_COOLDOWN_MS);
}

/**
 * Check if the operative is currently speaking (for testing/diagnostics).
 */
export function isOxSpeaking(): boolean {
  return _oxSpeaking;
}

/**
 * Reset debounce state (for testing).
 */
export function resetVoiceDebounce(): void {
  lastRequest = null;
  _oxSpeaking = false;
  if (_oxSpeakingCooldownTimer) {
    clearTimeout(_oxSpeakingCooldownTimer);
    _oxSpeakingCooldownTimer = null;
  }
}
