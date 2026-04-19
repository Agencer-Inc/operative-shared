// ─────────────────────────────────────────────────────────────
// SSE Parser
//
// Parses Server-Sent Events from an OpenAI-compatible streaming
// chat/completions endpoint. Extracts text content from deltas.
// ─────────────────────────────────────────────────────────────

import { ReadableStream } from "node:stream/web";

/**
 * Async generator that parses an SSE byte stream and yields text chunks.
 * Handles buffering across partial line delivery, malformed JSON, and [DONE].
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<string> {
  if (!response.body) return;

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = parsed?.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Malformed JSON chunk -- skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
