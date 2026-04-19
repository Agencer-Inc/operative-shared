// ─────────────────────────────────────────────────────────────
// SSE Helpers
//
// Write OpenAI-compatible SSE frames to any writable response.
// Works with Express, Node http.ServerResponse, Fastify, etc.
// ─────────────────────────────────────────────────────────────

import type { SSEWritable } from "../types.js";

/**
 * Set SSE headers on a response for streaming.
 * Must be called before any writes.
 */
export function initSSE(res: SSEWritable): void {
  if (res.setHeader) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
  if (res.flushHeaders) {
    res.flushHeaders();
  }
}

/**
 * Send a single SSE chunk in OpenAI streaming delta format.
 * Format: data: {"choices":[{"delta":{"content":"text"}}]}\n\n
 */
export function sendSSEChunk(res: SSEWritable, content: string): void {
  const payload = JSON.stringify({
    choices: [{ delta: { content } }],
  });
  res.write(`data: ${payload}\n\n`);
}

/**
 * Send the SSE [DONE] sentinel and end the response.
 */
export function sendSSEDone(res: SSEWritable): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Stream a complete response as SSE: set headers, send the full
 * content as one delta chunk, then send [DONE].
 */
export function sendSSEResponse(res: SSEWritable, content: string): void {
  initSSE(res);
  sendSSEChunk(res, content);
  sendSSEDone(res);
}
