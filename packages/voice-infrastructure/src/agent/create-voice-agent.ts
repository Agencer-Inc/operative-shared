// ─────────────────────────────────────────────────────────────
// createVoiceAgent — High-Level Convenience Factory
//
// One-call happy path: wires LiveKit + Deepgram + Cartesia +
// Silero into a complete voice pipeline. Consumer provides a
// brain endpoint URL. Everything else has sensible defaults.
//
// Runs in-process as an event-driven worker connected to
// LiveKit Cloud via WebSocket.
// ─────────────────────────────────────────────────────────────

import {
  defineAgent,
  type JobContext,
  type JobProcess,
  voice,
  llm,
  cli,
  ServerOptions,
} from "@livekit/agents";
import {
  RoomEvent,
  TrackSource,
  type RemoteParticipant,
} from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";

import type { VoiceInfraConfig, VoiceAgent } from "../types.js";
import { createDeepgramSTT } from "../adapters/deepgram/deepgram-stt.js";
import { createCartesiaTTS } from "../adapters/cartesia/cartesia-tts.js";
import { loadSileroVAD } from "../adapters/silero/silero-vad.js";
import { parseSSEStream } from "../sse/sse-parser.js";

function log(tag: string, ...args: unknown[]): void {
  console.log(`[voice-agent][${tag}]`, ...args);
}

/**
 * Create a fully configured voice agent. Call agent.start() to connect
 * to LiveKit Cloud and begin processing voice sessions.
 *
 * The agent communicates with the brain entirely via HTTP, keeping the
 * voice pipeline decoupled from any specific brain implementation.
 */
export function createVoiceAgent(config: VoiceInfraConfig): VoiceAgent {
  const serverPort = config.serverPort ?? 3001;
  const brainURL = config.brain.endpoint;
  const transcriptURL = config.brain.transcriptEndpoint;

  // Build the Brain agent that calls the HTTP endpoint
  class HTTPBrainAgent extends voice.Agent {
    private conversationHistory: Array<{ role: string; content: string }> = [];

    constructor() {
      super({ instructions: "Voice pipeline agent." });
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

      if (!lastUserMsg || lastUserMsg.type !== "message") {
        log("llmNode", "no user message found in chatCtx");
        return null;
      }

      const userText = lastUserMsg.content
        .filter((c): c is string => typeof c === "string")
        .join(" ")
        .trim();

      if (!userText) {
        log("llmNode", "empty user text after extraction");
        return null;
      }

      log("llmNode", `user said: "${userText.slice(0, 80)}"`);
      this.conversationHistory.push({ role: "user", content: userText });

      // Broadcast user transcript to frontend via relay (fire-and-forget)
      if (transcriptURL) {
        fetch(transcriptURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: userText }),
        }).catch(() => { /* best effort */ });
      }

      const messages = this.conversationHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      log("llmNode", `calling Brain with ${messages.length} messages`);

      let response: Response;
      try {
        response = await fetch(brainURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
        });
      } catch (err) {
        log("llmNode", "fetch failed:", err);
        const fallback = "Give me a sec, something hiccupped.";
        this.conversationHistory.push({ role: "assistant", content: fallback });
        return new ReadableStream({
          start(controller) {
            controller.enqueue(fallback);
            controller.close();
          },
        });
      }

      if (!response.ok || !response.body) {
        log("llmNode", `bad response: ${response.status}`);
        const fallback = "Give me a sec, something hiccupped.";
        this.conversationHistory.push({ role: "assistant", content: fallback });
        return new ReadableStream({
          start(controller) {
            controller.enqueue(fallback);
            controller.close();
          },
        });
      }

      log("llmNode", "streaming response from Brain");

      const sseGenerator = parseSSEStream(response);
      const history = this.conversationHistory;
      let fullResponse = "";

      return new ReadableStream<string>({
        async pull(controller) {
          try {
            const { done, value } = await sseGenerator.next();
            if (done) {
              if (fullResponse) {
                history.push({ role: "assistant", content: fullResponse });
                log("llmNode", `response complete (${fullResponse.length} chars)`);
              }
              controller.close();
              return;
            }
            fullResponse += value;
            controller.enqueue(value);
          } catch (err) {
            log("llmNode", "stream error:", err);
            controller.close();
          }
        },
        cancel() {
          sseGenerator.return(undefined);
        },
      });
    }

    override async onEnter(): Promise<void> {
      log("onEnter", "new session -- resetting conversation history");
      this.conversationHistory = [];
    }
  }

  // Define the agent with prewarm and entry
  const agentDef = defineAgent({
    prewarm: async (proc: JobProcess) => {
      log("prewarm", "loading Silero VAD model...");
      proc.userData.vad = await loadSileroVAD();
      log("prewarm", "Silero VAD loaded");
    },

    entry: async (ctx: JobContext) => {
      log("entry", "agent entry -- setting up pipeline");

      const vad = ctx.proc.userData.vad! as Awaited<ReturnType<typeof loadSileroVAD>>;
      const stt = createDeepgramSTT(config.deepgram);
      const tts = createCartesiaTTS(config.cartesia);

      log("entry", "STT + TTS configured");

      const agent = new HTTPBrainAgent();
      const session = new voice.AgentSession({ vad, stt, tts });

      log("entry", "AgentSession created with VAD + STT + TTS");

      const room = ctx.room;

      // Debug logging for room events
      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        log("room", `ParticipantConnected: ${participant.identity} (kind=${participant.kind})`);
      });

      room.on(RoomEvent.TrackSubscribed, (track: unknown, publication: unknown, participant: RemoteParticipant) => {
        const pub = publication as { source?: number; sid?: string };
        log("room", `TrackSubscribed: participant=${participant.identity} source=${pub.source} sid=${pub.sid}`);
      });

      await session.start({ agent, room });
      log("entry", "session started -- room connected, audio pipeline active");

      // Audio subscription safety net (race condition workaround)
      const ensureAudioSubscription = async (): Promise<void> => {
        const MAX_WAIT_MS = 10_000;
        const POLL_MS = 200;
        const start = Date.now();

        log("ensure-audio", "waiting for participant mic track...");

        while (Date.now() - start < MAX_WAIT_MS) {
          for (const [, participant] of room.remoteParticipants) {
            for (const [, publication] of participant.trackPublications) {
              if (
                publication.source === TrackSource.SOURCE_MICROPHONE &&
                publication.track
              ) {
                log("ensure-audio", `found mic track: participant=${participant.identity}`);
                room.emit(RoomEvent.TrackSubscribed, publication.track, publication, participant);
                log("ensure-audio", "re-emitted TrackSubscribed");
                return;
              }
            }
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }

        log("ensure-audio", "WARNING: no mic track found after 10s");
      };

      ensureAudioSubscription().catch((err) => {
        log("ensure-audio", "error:", err);
      });

      session.say("Hey. What's on your mind?");
      log("entry", "greeting sent via TTS");
    },
  });

  const __agentFile = fileURLToPath(import.meta.url);

  return {
    start() {
      log("worker", `starting LiveKit agent worker`);
      log("worker", `Brain URL: ${brainURL}`);
      log("worker", `LiveKit URL: ${config.livekit.url}`);

      cli.runApp(
        new ServerOptions({
          agent: __agentFile,
          wsURL: config.livekit.url,
          apiKey: config.livekit.apiKey,
          apiSecret: config.livekit.apiSecret,
        }),
      );
    },

    async stop() {
      log("worker", "stop requested -- cleanup not yet implemented in @livekit/agents");
      // LiveKit agents SDK doesn't expose a clean shutdown hook yet.
      // When it does, we'll call it here. For now, the process can be killed.
    },
  };
}
