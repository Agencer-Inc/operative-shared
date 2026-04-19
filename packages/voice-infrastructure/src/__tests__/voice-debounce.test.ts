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

describe("voice debounce", () => {
  beforeEach(() => {
    resetVoiceDebounce();
    vi.restoreAllMocks();
  });

  // ── Guard 1: Silence / empty input ────────────────────────

  describe("silence filter", () => {
    it("rejects empty string", () => {
      const result = shouldProcessVoiceRequest("");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects whitespace-only input", () => {
      const result = shouldProcessVoiceRequest("   ");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects single character", () => {
      const result = shouldProcessVoiceRequest("a");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("input_too_short");
    });

    it("rejects punctuation-only input", () => {
      const result = shouldProcessVoiceRequest("...");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("silence_punctuation");
    });

    it("rejects comma and ellipsis patterns", () => {
      expect(shouldProcessVoiceRequest(",,,").allowed).toBe(false);
      expect(shouldProcessVoiceRequest("...!").allowed).toBe(false);
      expect(shouldProcessVoiceRequest("  —  ").allowed).toBe(false);
    });

    it("allows real text with 2+ chars", () => {
      const result = shouldProcessVoiceRequest("hi");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 2: Duplicate text within dedup window ───────────

  describe("dedup window", () => {
    it("allows first request", () => {
      const result = shouldProcessVoiceRequest("build me a todo app");
      expect(result.allowed).toBe(true);
    });

    it("rejects identical text within dedup window", () => {
      shouldProcessVoiceRequest("build me a todo app");
      markVoiceRequestComplete();

      const result = shouldProcessVoiceRequest("build me a todo app");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("duplicate_within_window");
    });

    it("allows different text immediately", () => {
      shouldProcessVoiceRequest("build me a todo app");
      markVoiceRequestComplete();

      const result = shouldProcessVoiceRequest("build me a counter app");
      expect(result.allowed).toBe(true);
    });

    it("allows same text after dedup window expires", () => {
      shouldProcessVoiceRequest("hello there");
      markVoiceRequestComplete();

      // Simulate time passing beyond the 2s window
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);

      const result = shouldProcessVoiceRequest("hello there");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 3: Overlap protection ───────────────────────────

  describe("overlap protection", () => {
    it("allows new request as interruption while previous is streaming (no tools)", () => {
      shouldProcessVoiceRequest("first request");
      // Don't call markVoiceRequestComplete -- previous still streaming.
      // Without active tools, this is a natural turn-take (interruption).
      const result = shouldProcessVoiceRequest("second request");
      expect(result.allowed).toBe(true);
    });

    it("allows new request after previous completes", () => {
      shouldProcessVoiceRequest("first request");
      markVoiceRequestComplete();

      const result = shouldProcessVoiceRequest("second request");
      expect(result.allowed).toBe(true);
    });
  });

  // ── Guard 4: Tool lock ──────────────────────────────────

  describe("tool lock", () => {
    it("rejects with tools_in_progress when tools are active", () => {
      shouldProcessVoiceRequest("what does brain.ts do?");
      markToolsActive();

      const result = shouldProcessVoiceRequest("actually tell me about index.ts");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("tools_in_progress");
    });

    it("allows requests after tools complete and stream finishes", () => {
      shouldProcessVoiceRequest("what does brain.ts do?");
      markToolsActive();
      markToolsComplete();
      markVoiceRequestComplete();

      const result = shouldProcessVoiceRequest("now tell me about index.ts");
      expect(result.allowed).toBe(true);
    });

    it("isToolsActive returns correct state", () => {
      expect(isToolsActive()).toBe(false);
      shouldProcessVoiceRequest("some request");
      expect(isToolsActive()).toBe(false);
      markToolsActive();
      expect(isToolsActive()).toBe(true);
      markToolsComplete();
      expect(isToolsActive()).toBe(false);
    });

    it("markVoiceRequestComplete also clears toolsActive", () => {
      shouldProcessVoiceRequest("some request");
      markToolsActive();
      markVoiceRequestComplete();
      expect(isToolsActive()).toBe(false);
    });
  });

  // ── Guard 0: OX speaking gate (self-hear prevention) ─────

  describe("speaking gate", () => {
    it("rejects all input while agent is speaking", () => {
      markOxSpeaking();
      const result = shouldProcessVoiceRequest("build me a todo app");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ox_speaking");
    });

    it("allows input after speaking gate clears (immediate for test)", () => {
      markOxSpeaking();
      expect(shouldProcessVoiceRequest("hello").allowed).toBe(false);

      // Directly clear the flag for testing (markOxSilent uses a timer)
      resetVoiceDebounce();
      expect(shouldProcessVoiceRequest("hello").allowed).toBe(true);
    });

    it("isOxSpeaking tracks state correctly", () => {
      expect(isOxSpeaking()).toBe(false);
      markOxSpeaking();
      expect(isOxSpeaking()).toBe(true);
      resetVoiceDebounce();
      expect(isOxSpeaking()).toBe(false);
    });

    it("markOxSpeaking cancels pending cooldown timer", () => {
      markOxSpeaking();
      markOxSilent(); // Starts cooldown timer
      // Immediately start speaking again before cooldown expires
      markOxSpeaking();
      expect(isOxSpeaking()).toBe(true);
    });

    it("speaking check runs before all other guards", () => {
      // Even valid input is rejected while agent is speaking
      markOxSpeaking();
      const result = shouldProcessVoiceRequest("perfectly valid input text");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ox_speaking");
    });
  });

  // ── Reset ─────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all state", () => {
      shouldProcessVoiceRequest("some request");
      resetVoiceDebounce();

      const result = shouldProcessVoiceRequest("new request");
      expect(result.allowed).toBe(true);
    });

    it("clears speaking state", () => {
      markOxSpeaking();
      expect(isOxSpeaking()).toBe(true);
      resetVoiceDebounce();
      expect(isOxSpeaking()).toBe(false);
    });
  });
});
