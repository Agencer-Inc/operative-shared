// ─────────────────────────────────────────────────────────────
// Voice Pipeline Assembly
//
// Wire individual adapters (STT, TTS, VAD) and a brain adapter
// into a LiveKit VoicePipelineAgent session. Lower-level than
// createVoiceAgent() -- for consumers who want to assemble
// their own pipeline with custom components.
// ─────────────────────────────────────────────────────────────

import { voice, llm } from "@livekit/agents";
import type { STT as DeepgramSTT } from "@livekit/agents-plugin-deepgram";
import type { TTS as CartesiaTTS } from "@livekit/agents-plugin-cartesia";
import type { VAD as SileroVAD } from "@livekit/agents-plugin-silero";
import { ReadableStream } from "node:stream/web";
import type { BrainAdapter } from "../types.js";

/**
 * A voice.Agent that delegates LLM inference to a BrainAdapter.
 * The BrainAdapter can be an HTTP endpoint, a local function, or anything
 * that returns an async generator of text chunks.
 */
class BrainAgent extends voice.Agent {
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private brainAdapter: BrainAdapter;

  constructor(brainAdapter: BrainAdapter) {
    super({ instructions: "Voice pipeline agent." });
    this.brainAdapter = brainAdapter;
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    _toolCtx: llm.ToolContext,
    _modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<string> | null> {
    const items = chatCtx.items;
    const lastUserMsg = [...items]
      .reverse()
      .find((item) => item.type === "message" && item.role === "user");

    if (!lastUserMsg || lastUserMsg.type !== "message") return null;

    const userText = lastUserMsg.content
      .filter((c): c is string => typeof c === "string")
      .join(" ")
      .trim();

    if (!userText) return null;

    this.conversationHistory.push({ role: "user", content: userText });

    const generator = this.brainAdapter.chat([...this.conversationHistory]);
    const history = this.conversationHistory;
    let fullResponse = "";

    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const { done, value } = await generator.next();
          if (done) {
            if (fullResponse) {
              history.push({ role: "assistant", content: fullResponse });
            }
            controller.close();
            return;
          }
          fullResponse += value;
          controller.enqueue(value);
        } catch {
          controller.close();
        }
      },
      cancel() {
        generator.return(undefined);
      },
    });
  }

  override async onEnter(): Promise<void> {
    this.conversationHistory = [];
  }
}

export interface VoicePipelineOptions {
  stt: DeepgramSTT;
  tts: CartesiaTTS;
  vad: SileroVAD;
  brainAdapter: BrainAdapter;
}

/**
 * Create a VoicePipelineAgent session from individual adapter components.
 * Returns the agent and session, ready to be started with a LiveKit room.
 */
export function createVoicePipeline(options: VoicePipelineOptions) {
  const agent = new BrainAgent(options.brainAdapter);
  const session = new voice.AgentSession({
    vad: options.vad,
    stt: options.stt,
    tts: options.tts,
  });

  return { agent, session };
}
