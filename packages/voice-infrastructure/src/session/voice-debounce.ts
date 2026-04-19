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
// State is scoped per session key to avoid cross-session interference.
// ─────────────────────────────────────────────────────────────

import type { VoiceRequestResult } from "../types.js";

const DEDUP_WINDOW_MS = 2000; // Ignore identical text within 2s
const MIN_INPUT_LENGTH = 2; // Reject inputs shorter than 2 chars (breathing/silence)
const SILENCE_PATTERNS = /^[\s.,!?…\-—–]+$/; // Only punctuation/whitespace

// Hard gate cooldown: TTS audio continues playing ~15-20s after the Brain stream
// ends. Keep the gate up for a buffer period after markOxSilent() so
// tail-end TTS audio doesn't re-trigger the loop.
const OX_SPEAKING_COOLDOWN_MS = 3000;

// Safety watchdog: if markOxSilent() is never called (caller crash, error path),
// auto-clear the speaking gate after this timeout to prevent permanent session lockout.
const OX_SPEAKING_MAX_AGE_MS = 60_000;

interface PendingRequest {
  text: string;
  timestamp: number;
  streaming: boolean;
  toolsActive: boolean; // True while Brain is executing tools (2-5s)
}

interface SessionDebounceState {
  lastRequest: PendingRequest | null;
  oxSpeaking: boolean;
  oxSpeakingCooldownTimer: ReturnType<typeof setTimeout> | null;
  oxSpeakingWatchdogTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionDebounceState>();

function getSession(sessionKey: string): SessionDebounceState {
  let state = sessions.get(sessionKey);
  if (!state) {
    state = {
      lastRequest: null,
      oxSpeaking: false,
      oxSpeakingCooldownTimer: null,
      oxSpeakingWatchdogTimer: null,
    };
    sessions.set(sessionKey, state);
  }
  return state;
}

/**
 * Check whether this voice request should be processed or rejected.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function shouldProcessVoiceRequest(
  sessionKey: string,
  userText: string,
): VoiceRequestResult {
  const state = getSession(sessionKey);
  const trimmed = userText.trim();

  // Guard 0: Operative is speaking -- hard reject.
  // TTS audio leaks into the mic, VAD fires, STT transcribes the operative's own
  // speech as "user input". Without this gate, the pipeline loops
  // indefinitely: operative speaks -> mic picks up -> STT -> Brain -> operative speaks.
  if (state.oxSpeaking) {
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
    state.lastRequest &&
    state.lastRequest.text === trimmed &&
    now - state.lastRequest.timestamp < DEDUP_WINDOW_MS
  ) {
    return { allowed: false, reason: "duplicate_within_window" };
  }

  // Guard 3: Previous request still streaming (overlap)
  // If tools are executing, reject -- the user should wait.
  // If just streaming (TTS playing), allow as an interruption --
  // the user is speaking over the operative, which is a natural turn-take.
  if (state.lastRequest?.streaming) {
    if (state.lastRequest.toolsActive) {
      return { allowed: false, reason: "tools_in_progress" };
    }
    // Interruption: mark previous request complete to allow this one.
    state.lastRequest.streaming = false;
  }

  // Allowed -- record this request
  state.lastRequest = { text: trimmed, timestamp: now, streaming: true, toolsActive: false };
  return { allowed: true };
}

/**
 * Mark the current voice request as complete (stream finished).
 * Call this after the SSE stream ends (success or error).
 */
export function markVoiceRequestComplete(sessionKey: string): void {
  const state = getSession(sessionKey);
  if (state.lastRequest) {
    state.lastRequest.streaming = false;
    state.lastRequest.toolsActive = false;
  }
}

/**
 * Mark that tool execution is in progress for the current request.
 * While tools are active, new requests are rejected with "tools_in_progress"
 * instead of generic "previous_still_streaming".
 */
export function markToolsActive(sessionKey: string): void {
  const state = getSession(sessionKey);
  if (state.lastRequest) {
    state.lastRequest.toolsActive = true;
  }
}

/**
 * Mark tool execution as complete for the current request.
 * The request itself may still be streaming the follow-up response.
 */
export function markToolsComplete(sessionKey: string): void {
  const state = getSession(sessionKey);
  if (state.lastRequest) {
    state.lastRequest.toolsActive = false;
  }
}

/**
 * Check if tools are currently executing.
 */
export function isToolsActive(sessionKey: string): boolean {
  const state = sessions.get(sessionKey);
  return state?.lastRequest?.toolsActive ?? false;
}

/**
 * Signal that the operative has started speaking (TTS streaming).
 * While this flag is set, ALL incoming STT transcripts are dropped.
 * Cancels any pending cooldown timer from a previous markOxSilent().
 */
export function markOxSpeaking(sessionKey: string): void {
  const state = getSession(sessionKey);
  if (state.oxSpeakingCooldownTimer) {
    clearTimeout(state.oxSpeakingCooldownTimer);
    state.oxSpeakingCooldownTimer = null;
  }
  if (state.oxSpeakingWatchdogTimer) {
    clearTimeout(state.oxSpeakingWatchdogTimer);
  }
  state.oxSpeaking = true;
  state.oxSpeakingWatchdogTimer = setTimeout(() => {
    state.oxSpeaking = false;
    state.oxSpeakingWatchdogTimer = null;
  }, OX_SPEAKING_MAX_AGE_MS);
}

/**
 * Signal that the operative Brain stream has ended. The gate stays up for
 * OX_SPEAKING_COOLDOWN_MS to account for TTS audio still playing
 * through speakers after the text stream finishes.
 */
export function markOxSilent(sessionKey: string): void {
  const state = getSession(sessionKey);
  if (state.oxSpeakingCooldownTimer) {
    clearTimeout(state.oxSpeakingCooldownTimer);
  }
  if (state.oxSpeakingWatchdogTimer) {
    clearTimeout(state.oxSpeakingWatchdogTimer);
    state.oxSpeakingWatchdogTimer = null;
  }
  state.oxSpeakingCooldownTimer = setTimeout(() => {
    state.oxSpeaking = false;
    state.oxSpeakingCooldownTimer = null;
  }, OX_SPEAKING_COOLDOWN_MS);
}

/**
 * Check if the operative is currently speaking (for testing/diagnostics).
 */
export function isOxSpeaking(sessionKey: string): boolean {
  const state = sessions.get(sessionKey);
  return state?.oxSpeaking ?? false;
}

/**
 * Reset debounce state for a specific session, or all sessions if no key given.
 */
export function resetVoiceDebounce(sessionKey?: string): void {
  if (sessionKey) {
    const state = sessions.get(sessionKey);
    if (state) {
      if (state.oxSpeakingCooldownTimer) {
        clearTimeout(state.oxSpeakingCooldownTimer);
      }
      if (state.oxSpeakingWatchdogTimer) {
        clearTimeout(state.oxSpeakingWatchdogTimer);
      }
      sessions.delete(sessionKey);
    }
  } else {
    for (const [, state] of sessions) {
      if (state.oxSpeakingCooldownTimer) {
        clearTimeout(state.oxSpeakingCooldownTimer);
      }
      if (state.oxSpeakingWatchdogTimer) {
        clearTimeout(state.oxSpeakingWatchdogTimer);
      }
    }
    sessions.clear();
  }
}
