import { describe, it, expect } from "vitest";
import {
  extractUserText,
  buildConversationHistory,
  wrapOpenAIResponse,
} from "../message-format/message-format.js";
import type { OpenAIMessage } from "../types.js";

// ─────────────────────────────────────────────────────────────
// extractUserText
// ─────────────────────────────────────────────────────────────

describe("extractUserText", () => {
  it("extracts text from the last user message (string content)", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hey there" },
      { role: "user", content: "Build me a todo app" },
    ];
    expect(extractUserText(messages)).toBe("Build me a todo app");
  });

  it("extracts text from array content format", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Build me" },
          { type: "text", text: "a todo app" },
        ],
      },
    ];
    expect(extractUserText(messages)).toBe("Build me a todo app");
  });

  it("returns null when no user message exists", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "assistant", content: "Hey" },
    ];
    expect(extractUserText(messages)).toBeNull();
  });

  it("returns null for empty messages array", () => {
    expect(extractUserText([])).toBeNull();
  });

  it("handles mixed message types and picks last user message", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Second message" },
    ];
    expect(extractUserText(messages)).toBe("Second message");
  });

  it("returns null for array content with no text", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [{ type: "image" }],
      },
    ];
    expect(extractUserText(messages)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// buildConversationHistory
// ─────────────────────────────────────────────────────────────

describe("buildConversationHistory", () => {
  it("converts messages to the expected format", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = buildConversationHistory(messages);
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  it("filters out system messages", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hello" },
    ];
    const result = buildConversationHistory(messages);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("limits to maxMessages", () => {
    const messages: OpenAIMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));
    const result = buildConversationHistory(messages, 5);
    expect(result.length).toBeLessThanOrEqual(5);
    // Should include the last 5 (indices 15-19)
    expect(result[result.length - 1]!.content).toBe("Message 19");
  });

  it("handles array content format", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "array content" }],
      },
    ];
    const result = buildConversationHistory(messages);
    expect(result[0]!.content).toBe("array content");
  });
});

// ─────────────────────────────────────────────────────────────
// wrapOpenAIResponse
// ─────────────────────────────────────────────────────────────

describe("wrapOpenAIResponse", () => {
  it("wraps content in OpenAI-compatible format", () => {
    const result = wrapOpenAIResponse("Hello world");
    expect(result).toEqual({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello world",
          },
        },
      ],
    });
  });

  it("handles empty string", () => {
    const result = wrapOpenAIResponse("");
    expect(result.choices[0]!.message.content).toBe("");
  });

  it("preserves special characters", () => {
    const result = wrapOpenAIResponse("What's up? Let's build!");
    expect(result.choices[0]!.message.content).toBe("What's up? Let's build!");
  });
});
