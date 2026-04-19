// ─────────────────────────────────────────────────────────────
// Streaming UI Command Parser
//
// UI commands like [UI:POINT:terminal] arrive across streaming chunks.
// A single tag may span multiple deltas, e.g. chunk1="[UI:PO" chunk2="INT:terminal]".
// This parser buffers partial tags and strips complete ones from the text
// BEFORE it reaches TTS, so the user never hears "[UI:POINT:terminal]".
// ─────────────────────────────────────────────────────────────

import type { UICommand, UICommandStripper } from "../types.js";
import { stripMarkdownForTTS } from "./strip-markdown.js";
import { stripExpressionTags } from "./strip-expressions.js";

/**
 * Regex matching the colon-separated UI command format.
 * Format: [UI:ACTION] or [UI:ACTION:target] or [UI:ACTION:target:value]
 * Examples: [UI:POINT:terminal], [UI:EXPAND_TERMINAL], [UI:HIGHLIGHT_CARD:3]
 */
const UI_TAG_REGEX = /\[UI:([A-Z_]+)(?::([^\]:]*))?(?::([^\]]*))?\]/g;

/**
 * Regex matching [ACTION:type|description] tags from the Brain's action routing.
 * These are stripped from TTS and chat display but preserved in raw text for parsing.
 */
const ACTION_TAG_REGEX = /\[ACTION:[^\]]*\]/g;

/**
 * Creates a stateful streaming UI command stripper.
 * Call feed() with each text delta. It returns the clean text (tags removed)
 * and any complete UI commands found. Partial tags are buffered internally.
 *
 * Call flush() after the stream ends to get any remaining buffered text.
 */
export function createUICommandStripper(): UICommandStripper {
  let buffer = "";

  function feed(delta: string): { cleanText: string; commands: UICommand[] } {
    buffer += delta;
    const commands: UICommand[] = [];

    // Extract all complete UI tags from the buffer
    let cleanText = buffer.replace(UI_TAG_REGEX, (_match, action: string, target?: string, value?: string) => {
      commands.push({
        action,
        target: target || undefined,
        value: value || undefined,
      });
      return ""; // Strip the tag from text
    });

    // Strip complete [ACTION:...] tags from the text (TTS must never speak them)
    cleanText = cleanText.replace(ACTION_TAG_REGEX, "");

    // Check if there's a partial tag at the end of the buffer.
    // A partial tag can be as short as a lone "[" or as long as "[ACTION:build|desc"
    // (everything up to but not including the closing "]").
    // LLM chunk boundaries can split ANYWHERE inside a tag, so we must catch
    // every possible prefix of [UI:...] and [ACTION:...].
    //
    // Strategy: find the last "[" that could be the start of a tag.
    // If the text from that "[" to the end looks like a partial tag prefix
    // (no closing "]"), buffer it and only emit text before it.
    const lastBracket = cleanText.lastIndexOf("[");

    if (lastBracket !== -1) {
      const tail = cleanText.slice(lastBracket);
      // Match any incomplete prefix of [UI:...], [ACTION:...], or expression tags
      const PARTIAL_UI = /^\[(?:U(?:I(?::[A-Z_]*(?::[^\]]*)?)?)?)?$/;
      const PARTIAL_ACTION = /^\[(?:A(?:C(?:T(?:I(?:O(?:N(?::[^\]]*)?)?)?)?)?)?)?$/;
      const PARTIAL_EXPRESSION = /^\[[a-z]+$/;
      const PARTIAL_EMOTION = /^\[(?:e(?:m(?:o(?:t(?:i(?:o(?:n(?::[^\]]*)?)?)?)?)?)?)?)?$/;
      const isPartialTag = PARTIAL_UI.test(tail) || PARTIAL_ACTION.test(tail) || PARTIAL_EMOTION.test(tail) || PARTIAL_EXPRESSION.test(tail);
      if (isPartialTag && !tail.includes("]")) {
        buffer = tail;
        cleanText = cleanText.slice(0, lastBracket);
      } else {
        buffer = "";
      }
    } else {
      buffer = "";
    }

    // Strip markdown formatting -- TTS should never speak asterisks, hashes, or backticks
    cleanText = stripMarkdownForTTS(cleanText);

    // Strip expression/stage-direction tags: [chuckles], [pause], etc.
    cleanText = stripExpressionTags(cleanText);

    return { cleanText, commands };
  }

  function flush(): { cleanText: string; commands: UICommand[] } {
    if (!buffer) return { cleanText: "", commands: [] };

    // Try to parse any remaining buffer as a complete tag
    const commands: UICommand[] = [];
    let cleanText = buffer.replace(UI_TAG_REGEX, (_match, action: string, target?: string, value?: string) => {
      commands.push({
        action,
        target: target || undefined,
        value: value || undefined,
      });
      return "";
    });

    // Strip any remaining incomplete UI, ACTION, or expression tags so they're never spoken aloud.
    cleanText = cleanText.replace(/\[UI:[^\]]*$/, "");
    cleanText = cleanText.replace(/\[ACTION:[^\]]*$/, "");
    cleanText = cleanText.replace(/\[emotion:[^\]]*$/, "");
    cleanText = cleanText.replace(/\[[a-z]+$/, "");
    // Also strip any complete action tags that survived
    cleanText = cleanText.replace(ACTION_TAG_REGEX, "");

    // Strip markdown and expression tags (same as feed path)
    cleanText = stripMarkdownForTTS(cleanText);
    cleanText = stripExpressionTags(cleanText);

    buffer = "";
    return { cleanText, commands };
  }

  return { feed, flush };
}
