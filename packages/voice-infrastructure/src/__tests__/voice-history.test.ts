import { describe, it, expect, beforeEach } from "vitest";
import {
  getVoiceHistory,
  hasVoiceHistory,
  addToVoiceHistory,
  clearVoiceHistory,
} from "../session/voice-history.js";

// ─────────────────────────────────────────────────────────────
// Voice History
// ─────────────────────────────────────────────────────────────

describe("voice history", () => {
  beforeEach(() => {
    clearVoiceHistory();
  });

  it("stores and retrieves messages", () => {
    addToVoiceHistory("test", "user", "Hello");
    addToVoiceHistory("test", "assistant", "Hi there");
    const history = getVoiceHistory("test");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("returns empty array for unknown session", () => {
    expect(getVoiceHistory("nonexistent")).toEqual([]);
  });

  it("trims to MAX_HISTORY (20)", () => {
    for (let i = 0; i < 25; i++) {
      addToVoiceHistory("test", "user", `Message ${i}`);
    }
    const history = getVoiceHistory("test");
    expect(history).toHaveLength(20);
    expect(history[0]!.content).toBe("Message 5");
    expect(history[19]!.content).toBe("Message 24");
  });

  it("clearVoiceHistory clears specific session", () => {
    addToVoiceHistory("a", "user", "Hello A");
    addToVoiceHistory("b", "user", "Hello B");
    clearVoiceHistory("a");
    expect(getVoiceHistory("a")).toEqual([]);
    expect(getVoiceHistory("b")).toHaveLength(1);
  });

  it("clearVoiceHistory without key clears all", () => {
    addToVoiceHistory("a", "user", "Hello A");
    addToVoiceHistory("b", "user", "Hello B");
    clearVoiceHistory();
    expect(getVoiceHistory("a")).toEqual([]);
    expect(getVoiceHistory("b")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// hasVoiceHistory
// ─────────────────────────────────────────────────────────────

describe("hasVoiceHistory", () => {
  beforeEach(() => {
    clearVoiceHistory();
  });

  it("returns false when no history exists", () => {
    expect(hasVoiceHistory("test")).toBe(false);
  });

  it("returns true when fresh history exists", () => {
    addToVoiceHistory("test", "user", "Hello");
    expect(hasVoiceHistory("test")).toBe(true);
  });

  it("returns false for unknown session", () => {
    addToVoiceHistory("a", "user", "Hello");
    expect(hasVoiceHistory("b")).toBe(false);
  });
});
