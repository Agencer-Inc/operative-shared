import { describe, it, expect } from "vitest";
import { stripExpressionTags } from "../text/strip-expressions.js";
import { isFragment } from "../text/fragment-detection.js";
import { createUICommandStripper } from "../text/ui-command-stripper.js";

// ─────────────────────────────────────────────────────────────
// createUICommandStripper
// ─────────────────────────────────────────────────────────────

describe("createUICommandStripper", () => {
  it("strips a complete UI command from a single chunk", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("Look at this [UI:POINT:terminal] right here");
    expect(result.cleanText).toBe("Look at this right here");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]!.action).toBe("POINT");
    expect(result.commands[0]!.target).toBe("terminal");
  });

  it("strips multiple UI commands from one chunk", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("Check this [UI:POINT:card-1] [UI:HIGHLIGHT_CARD:1] out");
    expect(result.cleanText).toBe("Check this out");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]!.action).toBe("POINT");
    expect(result.commands[1]!.action).toBe("HIGHLIGHT_CARD");
    expect(result.commands[1]!.target).toBe("1");
  });

  it("buffers a partial UI tag across chunks", () => {
    const stripper = createUICommandStripper();

    // First chunk: starts a tag but doesn't complete it
    const r1 = stripper.feed("Hello [UI:PO");
    expect(r1.cleanText).toBe("Hello ");
    expect(r1.commands).toHaveLength(0);

    // Second chunk: completes the tag
    const r2 = stripper.feed("INT:terminal] world");
    expect(r2.cleanText).toBe(" world");
    expect(r2.commands).toHaveLength(1);
    expect(r2.commands[0]!.action).toBe("POINT");
    expect(r2.commands[0]!.target).toBe("terminal");
  });

  it("handles a tag split across three chunks", () => {
    const stripper = createUICommandStripper();

    const r1 = stripper.feed("See [UI:");
    expect(r1.commands).toHaveLength(0);

    const r2 = stripper.feed("EXPAND_");
    expect(r2.commands).toHaveLength(0);

    const r3 = stripper.feed("TERMINAL] now");
    expect(r3.commands).toHaveLength(1);
    expect(r3.commands[0]!.action).toBe("EXPAND_TERMINAL");
    expect(r3.cleanText).toBe(" now");
  });

  it("passes through text with no UI tags unchanged", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("Just normal text here");
    expect(result.cleanText).toBe("Just normal text here");
    expect(result.commands).toHaveLength(0);
  });

  it("handles command with no target (e.g. EXPAND_TERMINAL)", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("[UI:EXPAND_TERMINAL]");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]!.action).toBe("EXPAND_TERMINAL");
    expect(result.commands[0]!.target).toBeUndefined();
  });

  it("flush() strips incomplete UI tags instead of emitting them", () => {
    const stripper = createUICommandStripper();
    stripper.feed("hello [UI:INCOMPLETE");
    const flushed = stripper.flush();
    // Incomplete UI tags are silently dropped so they're never spoken aloud
    expect(flushed.cleanText).toBe("");
    expect(flushed.commands).toHaveLength(0);
  });

  it("flush() completes a valid buffered tag", () => {
    const stripper = createUICommandStripper();
    stripper.feed("text [UI:POINT:");
    const r1 = stripper.feed("terminal]");
    // The tag completes in feed(), flush() should have nothing
    expect(r1.commands).toHaveLength(1);
    const flushed = stripper.flush();
    expect(flushed.cleanText).toBe("");
    expect(flushed.commands).toHaveLength(0);
  });

  it("handles brackets in normal text without false positives", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("array[0] and object[key]");
    expect(result.cleanText).toBe("array[0] and object[key]");
    expect(result.commands).toHaveLength(0);
  });

  // ── ACTION tag stripping ────────────────────────────────────
  it("strips a complete [ACTION:...] tag from a single chunk", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("Sure thing. [ACTION:build|A todo app] Let me plan that.");
    expect(result.cleanText).toBe("Sure thing. Let me plan that.");
    expect(result.commands).toHaveLength(0); // ACTION tags don't produce commands
  });

  it("strips ACTION tag split at the bracket boundary", () => {
    const stripper = createUICommandStripper();

    const r1 = stripper.feed("Sure thing. [");
    expect(r1.cleanText).toBe("Sure thing. ");

    const r2 = stripper.feed("ACTION:build|A todo app] Let me plan.");
    expect(r2.cleanText).toBe(" Let me plan.");
    expect(r2.commands).toHaveLength(0);
  });

  it("strips ACTION tag split mid-prefix (e.g. [ACT + ION:...])", () => {
    const stripper = createUICommandStripper();

    const r1 = stripper.feed("On it. [ACT");
    expect(r1.cleanText).toBe("On it. ");

    const r2 = stripper.feed("ION:build|Todo] Planning now.");
    expect(r2.cleanText).toBe(" Planning now.");
  });

  it("strips ACTION tag split after colon (e.g. [ACTION: + build|desc])", () => {
    const stripper = createUICommandStripper();

    const r1 = stripper.feed("Got it. [ACTION:");
    expect(r1.cleanText).toBe("Got it. ");

    const r2 = stripper.feed("build|Make a landing page] Starting.");
    expect(r2.cleanText).toBe(" Starting.");
  });

  it("strips UI tag split at the bracket boundary", () => {
    const stripper = createUICommandStripper();

    const r1 = stripper.feed("Look here [");
    expect(r1.cleanText).toBe("Look here ");

    const r2 = stripper.feed("UI:POINT:terminal] right now");
    expect(r2.cleanText).toBe(" right now");
    expect(r2.commands).toHaveLength(1);
    expect(r2.commands[0]!.action).toBe("POINT");
  });

  it("flush() strips incomplete ACTION tags at end of stream", () => {
    const stripper = createUICommandStripper();
    stripper.feed("text [ACTION:build|desc");
    const flushed = stripper.flush();
    // Incomplete ACTION tag dropped — never spoken aloud
    expect(flushed.cleanText).toBe("");
  });

  // ── Expression tag stripping ────────────────────────────────
  it("strips expression tags from a single chunk", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("That sounds great [chuckles] let me think about it");
    expect(result.cleanText).toBe("That sounds great let me think about it");
  });

  it("strips multiple expression tags", () => {
    const stripper = createUICommandStripper();
    const result = stripper.feed("[pause] Okay [thoughtful] let me plan that");
    expect(result.cleanText).toBe(" Okay let me plan that");
  });

  it("strips expression tag split across chunks", () => {
    const stripper = createUICommandStripper();
    const r1 = stripper.feed("Nice [chuckl");
    expect(r1.cleanText).toBe("Nice ");
    const r2 = stripper.feed("es] okay");
    expect(r2.cleanText).toBe(" okay");
  });
});

// ─────────────────────────────────────────────────────────────
// stripExpressionTags (standalone)
// ─────────────────────────────────────────────────────────────

describe("stripExpressionTags", () => {
  it("strips [chuckles]", () => {
    expect(stripExpressionTags("Ha [chuckles] that's funny")).toBe("Ha that's funny");
  });

  it("strips [pause]", () => {
    expect(stripExpressionTags("[pause] Okay, so...")).toBe(" Okay, so...");
  });

  it("strips [thoughtful]", () => {
    expect(stripExpressionTags("[thoughtful] That's an interesting idea")).toBe(" That's an interesting idea");
  });

  it("strips [laughs]", () => {
    expect(stripExpressionTags("Right [laughs] exactly")).toBe("Right exactly");
  });

  it("strips [sighs]", () => {
    expect(stripExpressionTags("[sighs] That's tough")).toBe(" That's tough");
  });

  it("strips [warmly]", () => {
    expect(stripExpressionTags("[warmly] Welcome back")).toBe(" Welcome back");
  });

  it("strips [beat]", () => {
    expect(stripExpressionTags("Let me think [beat] okay")).toBe("Let me think okay");
  });

  it("does NOT strip non-expression brackets", () => {
    expect(stripExpressionTags("array[0] and key")).toBe("array[0] and key");
  });

  it("is case-insensitive", () => {
    expect(stripExpressionTags("[Chuckles] nice")).toBe(" nice");
  });
});

// ─────────────────────────────────────────────────────────────
// isFragment
// ─────────────────────────────────────────────────────────────

describe("isFragment", () => {
  // Filler-only utterances
  it("detects 'um' as fragment", () => expect(isFragment("um")).toBe(true));
  it("detects 'uh' as fragment", () => expect(isFragment("uh")).toBe(true));
  it("detects 'hmm' as fragment", () => expect(isFragment("hmm")).toBe(true));
  it("detects 'mhm' as fragment", () => expect(isFragment("mhm")).toBe(true));
  it("detects 'like' as filler fragment", () => expect(isFragment("like")).toBe(true));
  it("detects 'yeah' as filler fragment", () => expect(isFragment("yeah")).toBe(true));
  it("detects 'okay' as filler fragment", () => expect(isFragment("okay")).toBe(true));

  // Trailing connectors
  it("detects trailing 'and'", () => expect(isFragment("I was thinking and")).toBe(true));
  it("detects trailing 'but'", () => expect(isFragment("that's cool but")).toBe(true));
  it("detects trailing 'because'", () => expect(isFragment("I need it because")).toBe(true));
  it("detects trailing 'so'", () => expect(isFragment("we went to the store so")).toBe(true));

  // Trailing comma
  it("detects trailing comma", () => expect(isFragment("first of all,")).toBe(true));
  it("detects trailing comma with spaces", () => expect(isFragment("you know, like,")).toBe(true));

  // Short text without terminal punctuation
  it("detects short text without punctuation", () => expect(isFragment("I was")).toBe(true));
  it("detects 3-word fragment", () => expect(isFragment("the big")).toBe(true));
  it("detects 4-word fragment", () => expect(isFragment("I think that we")).toBe(true));

  // Complete sentences (should NOT be fragments)
  it("does not flag complete sentence with period", () => expect(isFragment("I went to the store.")).toBe(false));
  it("does not flag complete question", () => expect(isFragment("What time is the meeting?")).toBe(false));
  it("does not flag exclamation", () => expect(isFragment("That was really amazing!")).toBe(false));
  it("does not flag long text without punctuation", () => expect(isFragment("I went to the store and bought some groceries")).toBe(false));

  // Edge cases
  it("returns false for empty string", () => expect(isFragment("")).toBe(false));
  it("returns false for whitespace only", () => expect(isFragment("   ")).toBe(false));
  it("handles mixed case fillers", () => expect(isFragment("Um")).toBe(true));
  it("handles trailing connector with comma", () => expect(isFragment("well, and,")).toBe(true));
});
