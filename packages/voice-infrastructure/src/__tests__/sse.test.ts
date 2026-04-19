import { describe, it, expect } from "vitest";
import {
  initSSE,
  sendSSEChunk,
  sendSSEDone,
  sendSSEResponse,
} from "../sse/sse-helpers.js";
import type { SSEWritable } from "../types.js";

// ── Mock SSEWritable ─────────────────────────────────────────

function mockRes() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  return {
    chunks,
    headers,
    setHeader(key: string, value: string) { headers[key] = value; },
    flushHeaders() { /* noop */ },
    write(data: string) { chunks.push(data); return true; },
    end() { chunks.push("__END__"); },
  } satisfies SSEWritable & { chunks: string[]; headers: Record<string, string> };
}

// ─────────────────────────────────────────────────────────────
// initSSE
// ─────────────────────────────────────────────────────────────

describe("initSSE", () => {
  it("sets Content-Type to text/event-stream", () => {
    const res = mockRes();
    initSSE(res);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
  });

  it("sets Cache-Control to no-cache", () => {
    const res = mockRes();
    initSSE(res);
    expect(res.headers["Cache-Control"]).toBe("no-cache");
  });

  it("sets Connection to keep-alive", () => {
    const res = mockRes();
    initSSE(res);
    expect(res.headers["Connection"]).toBe("keep-alive");
  });
});

// ─────────────────────────────────────────────────────────────
// sendSSEChunk
// ─────────────────────────────────────────────────────────────

describe("sendSSEChunk", () => {
  it("writes delta format with double newline", () => {
    const res = mockRes();
    sendSSEChunk(res, "Hello");
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toBe('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
  });

  it("handles special characters in content", () => {
    const res = mockRes();
    sendSSEChunk(res, 'Say "hello"');
    const parsed = JSON.parse(res.chunks[0]!.replace("data: ", "").trim());
    expect(parsed.choices[0].delta.content).toBe('Say "hello"');
  });
});

// ─────────────────────────────────────────────────────────────
// sendSSEDone
// ─────────────────────────────────────────────────────────────

describe("sendSSEDone", () => {
  it("writes [DONE] sentinel and ends response", () => {
    const res = mockRes();
    sendSSEDone(res);
    expect(res.chunks).toEqual(["data: [DONE]\n\n", "__END__"]);
  });
});

// ─────────────────────────────────────────────────────────────
// sendSSEResponse
// ─────────────────────────────────────────────────────────────

describe("sendSSEResponse", () => {
  it("sets headers, sends content chunk, then [DONE]", () => {
    const res = mockRes();
    sendSSEResponse(res, "Full response here");

    // Headers set
    expect(res.headers["Content-Type"]).toBe("text/event-stream");

    // Chunk + DONE + end
    expect(res.chunks).toHaveLength(3);
    expect(res.chunks[0]).toContain('"content":"Full response here"');
    expect(res.chunks[1]).toBe("data: [DONE]\n\n");
    expect(res.chunks[2]).toBe("__END__");
  });

  it("sends valid JSON in the data line", () => {
    const res = mockRes();
    sendSSEResponse(res, "test");

    const dataLine = res.chunks[0]!;
    const jsonStr = dataLine.replace("data: ", "").trim();
    const parsed = JSON.parse(jsonStr);
    expect(parsed.choices[0].delta.content).toBe("test");
  });

  it("handles empty content", () => {
    const res = mockRes();
    sendSSEResponse(res, "");
    expect(res.chunks[0]).toContain('"content":""');
  });
});

// ─────────────────────────────────────────────────────────────
// SSE Parser (parseSSEStream)
// ─────────────────────────────────────────────────────────────
// The real parseSSEStream accepts a Response object. For unit testing,
// we test the same algorithm with a mock Response.

import { parseSSEStream } from "../sse/sse-parser.js";

function makeResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream);
}

async function collectSSE(chunks: string[]): Promise<string[]> {
  const response = makeResponse(chunks);
  const results: string[] = [];
  for await (const chunk of parseSSEStream(response)) {
    results.push(chunk);
  }
  return results;
}

describe("parseSSEStream", () => {
  it("extracts text content from valid SSE chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["Hello", " world"]);
  });

  it("handles [DONE] terminator", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
      'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["Hi"]);
  });

  it("skips malformed JSON chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"before"}}]}\n\n',
      "data: {bad json}\n\n",
      'data: {"choices":[{"delta":{"content":"after"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["before", "after"]);
  });

  it("skips chunks without content", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"real"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["real"]);
  });

  it("handles chunked lines (partial delivery)", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"conten',
      't":"partial"}}]}\n\ndata: [DONE]\n\n',
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["partial"]);
  });

  it("ignores empty lines and non-data lines", async () => {
    const chunks = [
      "\n",
      ": this is a comment\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const result = await collectSSE(chunks);
    expect(result).toEqual(["ok"]);
  });

  it("returns empty array for empty input", async () => {
    const result = await collectSSE([]);
    expect(result).toEqual([]);
  });
});
