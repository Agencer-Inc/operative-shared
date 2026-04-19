import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  shouldProcessVoiceRequest,
  markVoiceRequestComplete,
  markToolsActive,
  markToolsComplete,
  isToolsActive,
  markOxSpeaking,
  markOxSilent,
  isOxSpeaking,
  resetVoiceDebounce,
} from "../session/voice-debounce.js";

// ─────────────────────────────────────────────────────────────
// Voice Debounce — Server-side dedup + silence filter
// ─────────────────────────────────────────────────────────────

const S = "s1"; // test session key

describe("voice debounce", () => {
  beforeEach(() => {
    resetVoiceDebounce();
    vi.restoreAllMocks();
  });

  // ── Guard 1: Silence / empty input ────────────────────────

  describe("silence filter", () => {
    it("rejects empty string", () => {
      const result = shouldProcessVoiceRequest(S, "");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects whitespace-only input", () => {
      const result = shouldProcessVoiceRequest(S, "   ");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects single character", () => {
      const result = shouldProcessVoiceRequest(S, "a");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects punctuation-only input", () => {
      const result = shouldProcessVoiceRequest(S, "...");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("silence_punctuation");
    });

    it("rejects comma and ellipsis patterns", () => {
      expect(shouldProcessVoiceRequest(S, ",,,").allowed).toBe(false);
      expect(shouldProcessVoiceRequest(S, "...!").allowed).toBe(false);
      expect(shouldProcessVoiceRequest(S, "  —  ").allowed).toBe(false);
    });

    it("allows real text with 2+ chars", () => {
      const result = shouldProcessVoiceRequest(S, "hi");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 2: Duplicate text within dedup window ───────────

  describe("dedup window", () => {
    it("allows first request", () => {
      const result = shouldProcessVoiceRequest(S, "build me a todo app");
      expect(result.allowed).toBe(true);
    });

    it("rejects identical text within dedup window", () => {
      shouldProcessVoiceRequest(S, "build me a todo app");
      markVoiceRequestComplete(S);

      const result = shouldProcessVoiceRequest(S, "build me a todo app");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("duplicate_within_window");
    });

    it("allows different text immediately", () => {
      shouldProcessVoiceRequest(S, "build me a todo app");
      markVoiceRequestComplete(S);

      const result = shouldProcessVoiceRequest(S, "build me a counter app");
      expect(result.allowed).toBe(true);
    });

    it("allows same text after dedup window expires", () => {
      shouldProcessVoiceRequest(S, "hello there");
      markVoiceRequestComplete(S);

      // Simulate time passing beyond the 2s window
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);

      const result = shouldProcessVoiceRequest(S, "hello there");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 3: Overlap protection ───────────────────────────

  describe("overlap protection", () => {
    it("allows new request as interruption while previous is streaming (no tools)", () => {
      shouldProcessVoiceRequest(S, "first request");
      // Don't call markVoiceRequestComplete -- previous still streaming.
      // Without active tools, this is a natural turn-take (interruption).
      const result = shouldProcessVoiceRequest(S, "second request");
      expect(result.allowed).toBe(true);
    });

    it("allows new request after previous completes", () => {
      shouldProcessVoiceRequest(S, "first request");
      markVoiceRequestComplete(S);

      const result = shouldProcessVoiceRequest(S, "second request");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 4: Tool lock ──────────────────────────────────

  describe("tool lock", () => {
    it("rejects with tools_in_progress when tools are active", () => {
      shouldProcessVoiceRequest(S, "what does brain.ts do?");
      markToolsActive(S);

      const result = shouldProcessVoiceRequest(S, "actually tell me about index.ts");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("tools_in_progress");
    });

    it("allows requests after tools complete and stream finishes", () => {
      shouldProcessVoiceRequest(S, "what does brain.ts do?");
      markToolsActive(S);
      markToolsComplete(S);
      markVoiceRequestComplete(S);

      const result = shouldProcessVoiceRequest(S, "now tell me about index.ts");
      expect(result.allowed).toBe(true);
    });

    it("isToolsActive returns correct state", () => {
      expect(isToolsActive(S)).toBe(false);
      shouldProcessVoiceRequest(S, "some request");
      expect(isToolsActive(S)).toBe(false);
      markToolsActive(S);
      expect(isToolsActive(S)).toBe(true);
      markToolsComplete(S);
      expect(isToolsActive(S)).toBe(false);
    });

    it("markVoiceRequestComplete also clears toolsActive", () => {
      shouldProcessVoiceRequest(S, "some request");
      markToolsActive(S);
      markVoiceRequestComplete(S);
      expect(isToolsActive(S)).toBe(false);
    });
  });

  // ── Guard 0: OX speaking gate (self-hear prevention) ─────

  describe("speaking gate", () => {
    it("rejects all input while agent is speaking", () => {
      markOxSpeaking(S);
      const result = shouldProcessVoiceRequest(S, "build me a todo app");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ox_speaking");
    });

    it("allows input after speaking gate clears (immediate for test)", () => {
      markOxSpeaking(S);
      expect(shouldProcessVoiceRequest(S, "hello").allowed).toBe(false);

      // Directly clear the flag for testing (markOxSilent uses a timer)
      resetVoiceDebounce(S);
      expect(shouldProcessVoiceRequest(S, "hello").allowed).toBe(true);
    });

    it("isOxSpeaking tracks state correctly", () => {
      expect(isOxSpeaking(S)).toBe(false);
      markOxSpeaking(S);
      expect(isOxSpeaking(S)).toBe(true);
      resetVoiceDebounce(S);
      expect(isOxSpeaking(S)).toBe(false);
    });

    it("markOxSpeaking cancels pending cooldown timer", () => {
      markOxSpeaking(S);
      markOxSilent(S); // Starts cooldown timer
      // Immediately start speaking again before cooldown expires
      markOxSpeaking(S);
      expect(isOxSpeaking(S)).toBe(true);
    });

    it("speaking check runs before all other guards", () => {
      // Even valid input is rejected while agent is speaking
      markOxSpeaking(S);
      const result = shouldProcessVoiceRequest(S, "perfectly valid input text");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ox_speaking");
    });
  });

  // ── Session isolation ─────────────────────────────────────

  describe("session isolation", () => {
    it("different sessions have independent state", () => {
      shouldProcessVoiceRequest("a", "hello world");
      // Session "a" now has a pending request; session "b" does not
      const result = shouldProcessVoiceRequest("b", "hello world");
      expect(result.allowed).toBe(true);
    });

    it("speaking gate on one session doesn't affect another", () => {
      markOxSpeaking("a");
      expect(isOxSpeaking("a")).toBe(true);
      expect(isOxSpeaking("b")).toBe(false);
      expect(shouldProcessVoiceRequest("b", "hello").allowed).toBe(true);
    });

    it("resetVoiceDebounce without key clears all sessions", () => {
      shouldProcessVoiceRequest("a", "hello");
      markOxSpeaking("b");
      resetVoiceDebounce();
      expect(isOxSpeaking("b")).toBe(false);
    });

    it("resetVoiceDebounce with key clears only that session", () => {
      markOxSpeaking("a");
      markOxSpeaking("b");
      resetVoiceDebounce("a");
      expect(isOxSpeaking("a")).toBe(false);
      expect(isOxSpeaking("b")).toBe(true);
    });
  });

  // ── Reset ─────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all state", () => {
      shouldProcessVoiceRequest(S, "some request");
      resetVoiceDebounce();

      const result = shouldProcessVoiceRequest(S, "new request");
      expect(result.allowed).toBe(true);
    });

    it("clears speaking state", () => {
      markOxSpeaking(S);
      expect(isOxSpeaking(S)).toBe(true);
      resetVoiceDebounce();
      expect(isOxSpeaking(S)).toBe(false);
    });
  });
});
