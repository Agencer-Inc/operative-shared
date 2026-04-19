// ─────────────────────────────────────────────────────────────
// createVoiceAgent — High-Level Convenience Factory
//
// One-call happy path: wires LiveKit + Deepgram + Cartesia +
// Silero into a complete voice pipeline. Consumer provides a
// brain endpoint URL. Everything else has sensible defaults.
//
// Runs in-process as an event-driven worker connected to
// LiveKit Cloud via WebSocket.
//
// Architecture note: cli.runApp() spawns a child worker that
// re-imports this module. The worker discovers the agent via
// the module-level _agentConfig which is set by
// createVoiceAgent() before cli.runApp() is called. This is
// safe because prewarm/entry closures capture the config ref.
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

const MAX_CONVERSATION_HISTORY = 20;
const BRAIN_FETCH_TIMEOUT_MS = 30_000;
const FALLBACK_MESSAGE = "Give me a sec, something hiccupped.";

// Module-level config ref. Set by createVoiceAgent() before cli.runApp().
// The worker child re-imports this module and uses this to configure
// the agent definition via defineAgent(). Only one agent config per
// process is supported (LiveKit agents SDK constraint).
let _agentConfig: VoiceInfraConfig | null = null;

/**
 * Build the Brain agent class using the stored config.
 * This is a factory so the class closes over the right config values.
 */
function buildHTTPBrainAgentClass(brainURL: string, transcriptURL?: string) {
  return class HTTPBrainAgent extends voice.Agent {
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

      // Trim to avoid unbounded memory/token growth in long sessions
      if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
        this.conversationHistory = this.conversationHistory.slice(
          -MAX_CONVERSATION_HISTORY,
        );
      }

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
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          BRAIN_FETCH_TIMEOUT_MS,
        );
        response = await fetch(brainURL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch (err) {
        log("llmNode", "fetch failed:", err);
        this.conversationHistory.push({ role: "assistant", content: FALLBACK_MESSAGE });
        return new ReadableStream({
          start(controller) {
            controller.enqueue(FALLBACK_MESSAGE);
            controller.close();
          },
        });
      }

      if (!response.ok || !response.body) {
        log("llmNode", `bad response: ${response.status}`);
        this.conversationHistory.push({ role: "assistant", content: FALLBACK_MESSAGE });
        return new ReadableStream({
          start(controller) {
            controller.enqueue(FALLBACK_MESSAGE);
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
            // Preserve partial response in history so the next turn
            // knows what the user already heard.
            if (fullResponse) {
              history.push({ role: "assistant", content: fullResponse });
            }
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
  };
}

// Module-level agent definition. cli.runApp() discovers this when
// re-importing the module in the worker child process.
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    log("prewarm", "loading Silero VAD model...");
    proc.userData.vad = await loadSileroVAD();
    log("prewarm", "Silero VAD loaded");
  },

  entry: async (ctx: JobContext) => {
    if (!_agentConfig) {
      throw new Error(
        "voice-infrastructure: _agentConfig not set. " +
        "Call createVoiceAgent() before the worker starts.",
      );
    }

    const config = _agentConfig;
    log("entry", "agent entry -- setting up pipeline");

    const vad = ctx.proc.userData.vad! as Awaited<ReturnType<typeof loadSileroVAD>>;
    const stt = createDeepgramSTT(config.deepgram);
    const tts = createCartesiaTTS(config.cartesia);

    log("entry", "STT + TTS configured");

    const BrainAgent = buildHTTPBrainAgentClass(
      config.brain.endpoint,
      config.brain.transcriptEndpoint,
    );
    const agent = new BrainAgent();
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

/**
 * Create a fully configured voice agent. Call agent.start() to connect
 * to LiveKit Cloud and begin processing voice sessions.
 *
 * The agent communicates with the brain entirely via HTTP, keeping the
 * voice pipeline decoupled from any specific brain implementation.
 */
export function createVoiceAgent(config: VoiceInfraConfig): VoiceAgent {
  // Store config at module level so the worker child process can
  // access it when cli.runApp() re-imports this module.
  _agentConfig = config;

  const __agentFile = fileURLToPath(import.meta.url);

  return {
    start() {
      log("worker", `starting LiveKit agent worker`);
      log("worker", `Brain URL: ${config.brain.endpoint}`);
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
