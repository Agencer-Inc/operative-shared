// ─────────────────────────────────────────────────────────────
// Voice History
//
// In-memory conversation history for voice sessions.
// Survives session disconnect/reconnect within the same server
// lifetime. Keyed by a stable identifier.
// ─────────────────────────────────────────────────────────────

import type { HistoryEntry } from "../types.js";

const voiceHistories = new Map<string, HistoryEntry[]>();
const MAX_HISTORY = 20;
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get recent voice conversation history, pruning stale entries.
 */
export function getVoiceHistory(
  sessionKey: string = "default",
): Array<{ role: string; content: string }> {
  const history = voiceHistories.get(sessionKey);
  if (!history) return [];

  // Prune stale entries
  const now = Date.now();
  const fresh = history.filter((h) => now - h.timestamp < HISTORY_TTL_MS);
  voiceHistories.set(sessionKey, fresh);

  return fresh.map((h) => ({ role: h.role, content: h.content }));
}

/**
 * Check whether this session has existing voice history (i.e. this is a reconnect).
 */
export function hasVoiceHistory(sessionKey: string = "default"): boolean {
  const history = voiceHistories.get(sessionKey);
  if (!history || history.length === 0) return false;
  // Check if any entries are still fresh
  const now = Date.now();
  return history.some((h) => now - h.timestamp < HISTORY_TTL_MS);
}

/**
 * Append a message to voice conversation history.
 */
export function addToVoiceHistory(
  sessionKey: string = "default",
  role: string,
  content: string,
): void {
  if (!voiceHistories.has(sessionKey)) {
    voiceHistories.set(sessionKey, []);
  }
  const history = voiceHistories.get(sessionKey)!;
  history.push({ role, content, timestamp: Date.now() });

  // Trim to max
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

/**
 * Get recent voice conversation history WITH timestamps.
 * Needed for collision detection (did the user speak recently?).
 */
export function getVoiceHistoryWithTimestamps(
  sessionKey: string = "default",
): Array<{ role: string; content: string; timestamp: number }> {
  const history = voiceHistories.get(sessionKey);
  if (!history) return [];

  const now = Date.now();
  const fresh = history.filter((h) => now - h.timestamp < HISTORY_TTL_MS);
  voiceHistories.set(sessionKey, fresh);

  return fresh.map((h) => ({ role: h.role, content: h.content, timestamp: h.timestamp }));
}

/**
 * Clear all voice history (for testing).
 */
export function clearVoiceHistory(sessionKey?: string): void {
  if (sessionKey) {
    voiceHistories.delete(sessionKey);
  } else {
    voiceHistories.clear();
  }
}
