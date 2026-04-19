// ─────────────────────────────────────────────────────────────
// Message Format Helpers
//
// Pure functions for converting between OpenAI-compatible message
// formats. No provider-specific logic, no side effects.
// ─────────────────────────────────────────────────────────────

import type { OpenAIMessage, OpenAIChatCompletionResponse } from "../types.js";

/**
 * Extract the text content from the latest user message in OpenAI format.
 * Handles both string and array content formats.
 */
export function extractUserText(messages: OpenAIMessage[]): string | null {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return null;

  if (typeof lastUserMsg.content === "string") {
    return lastUserMsg.content;
  }

  // Array content (multimodal format)
  if (Array.isArray(lastUserMsg.content)) {
    return lastUserMsg.content
      .map((c) => c.text ?? "")
      .join(" ")
      .trim() || null;
  }

  return null;
}

/**
 * Convert conversation history to the format expected by a Brain chat endpoint.
 * Takes the last N messages to avoid blowing up the context window.
 */
export function buildConversationHistory(
  messages: OpenAIMessage[],
  maxMessages: number = 10,
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .slice(-maxMessages)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string"
        ? m.content
        : (Array.isArray(m.content)
          ? m.content.map((c) => c.text ?? "").join(" ")
          : String(m.content)),
    }));
}

/**
 * Wrap a response string in OpenAI-compatible chat completion format.
 */
export function wrapOpenAIResponse(content: string): OpenAIChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}
