import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { ProductId } from "./knowledge-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import type { MemoryService, EmbedFunction, OnEventCallback } from "./memory-service.js";
import { callHaikuMetered, UsageComponent } from "@agencer/usage-accountant";
import type { UsageAccountant } from "@agencer/usage-accountant";

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const EXTRACTION_MAX_TOKENS = 1024;

const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts AND behavioral patterns from software development conversations and pipeline outputs.

Return ONLY a JSON array of objects. Each object has a "type" field: "fact", "pattern", or "reinforce". No other text.

## Facts (type: "fact")
Fields: "type": "fact", "key": string, "value": string
Key naming: dot-separated namespaces (user.name, preference.stack, project.{name}.outcome, tech.{topic})
Value: concise, under 100 characters, facts only

## Patterns (type: "pattern")
Fields: "type": "pattern", "key": string, "category": string, "description": string
Categories: "communication", "workflow", "preference", "emotional", "technical"
Key: short kebab-case label (e.g., "prefers-concise-answers", "tests-before-shipping")
Description: one sentence describing the behavioral pattern

## Reinforcements (type: "reinforce")
Fields: "type": "reinforce", "key": string
Use when you see evidence of a pattern that was likely already extracted before.

Rules:
- Return [] if nothing extractable
- No speculation. Only extract what's clearly demonstrated.
- Patterns are behavioral tendencies, not one-time facts.
- A preference stated once is a fact. A preference demonstrated repeatedly is a pattern.

Examples:
[
  {"type": "fact", "key": "user.name", "value": "Faryar"},
  {"type": "fact", "key": "preference.stack", "value": "React + TypeScript + Vite"},
  {"type": "pattern", "key": "prefers-concise-answers", "category": "communication", "description": "User consistently asks for shorter, more direct responses"},
  {"type": "pattern", "key": "tests-before-shipping", "category": "workflow", "description": "User always runs tests before merging any PR"},
  {"type": "reinforce", "key": "prefers-concise-answers"}
]`;

/** Max concurrent extraction calls to prevent API spam. */
const MAX_CONCURRENT_EXTRACTIONS = 3;
const MAX_QUEUE_SIZE = 10;

const FACT_KEY_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_FACT_VALUE_LENGTH = 200;
const PATTERN_CATEGORIES = new Set(["communication", "workflow", "preference", "emotional", "technical"]);

const CRITIC_SYSTEM_PROMPT = `You are a fact quality filter. For each candidate fact, determine if it is substantive content that would matter if OX met this user again, or a meta-observation about the conversation itself.

KEEP: Named entities, decisions, claims, preferences, proposals, technical choices, project details, user information.
DROP: Observations about tone, engagement level, conversation patterns, focus areas, communication style meta-commentary.

Given a JSON array of candidate facts, return a JSON array of verdicts:
[{"key": "fact.key", "keep": true|false, "reason": "short reason"}]

Return ONLY the JSON array.`;

export class ExtractionPipeline {
  private client: Anthropic;
  private apiKey: string;
  private knowledgeService: KnowledgeService;
  private memoryService: MemoryService | null = null;
  private usageAccountant: UsageAccountant | null = null;
  private logger: Logger;
  private activeExtractions = 0;
  private queue: Array<() => Promise<void>> = [];
  private onEvent: OnEventCallback | undefined;
  private embed: EmbedFunction | undefined;

  constructor(
    apiKey: string,
    knowledgeService: KnowledgeService,
    logger: Logger,
    options?: { onEvent?: OnEventCallback; embed?: EmbedFunction },
  ) {
    this.apiKey = apiKey;
    this.client = new Anthropic({ apiKey });
    this.knowledgeService = knowledgeService;
    this.logger = logger.child({ service: "extraction" });
    this.onEvent = options?.onEvent;
    this.embed = options?.embed;
  }

  /** Wire up MemoryService for pattern storage. Called after both services are initialized. */
  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService;
  }

  /** Wire up UsageAccountant for metered critic calls. */
  setUsageAccountant(accountant: UsageAccountant): void {
    this.usageAccountant = accountant;
  }

  /** Run an extraction task through the concurrency-limited queue. */
  private enqueue(task: () => Promise<void>): void {
    if (this.activeExtractions < MAX_CONCURRENT_EXTRACTIONS) {
      this.activeExtractions++;
      task().finally(() => {
        this.activeExtractions--;
        this.drainQueue();
      });
    } else if (this.queue.length < MAX_QUEUE_SIZE) {
      this.queue.push(task);
    } else {
      this.queue.shift();
      this.queue.push(task);
      this.logger.warn("Extraction queue full, dropped oldest task");
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeExtractions < MAX_CONCURRENT_EXTRACTIONS) {
      const next = this.queue.shift();
      if (next) {
        this.activeExtractions++;
        next().finally(() => {
          this.activeExtractions--;
          this.drainQueue();
        });
      }
    }
  }

  /**
   * Extract facts from arbitrary text and store in Tier 1.
   * Fire-and-forget. Never throws.
   */
  async extractAndStore(text: string, source: string, projectId?: string, product: ProductId = "ox"): Promise<void> {
    try {
      const truncated = text.length > 4000 ? text.substring(0, 4000) : text;

      const response = await this.client.messages.create(
        {
          model: EXTRACTION_MODEL,
          max_tokens: EXTRACTION_MAX_TOKENS,
          system: EXTRACTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: truncated }],
        },
        { timeout: 15_000 },
      );

      const content = response.content[0];
      if (!content || content.type !== "text") return;

      let jsonText = content.text.trim();
      const fenceMatch = jsonText.match(/```json?\s*\n?([\s\S]*?)```/);
      if (fenceMatch) {
        jsonText = fenceMatch[1]!.trim();
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/```json?\n?/g, "").replace(/```$/g, "").trim();
      }

      let items: Array<Record<string, string>>;
      try {
        items = JSON.parse(jsonText);
      } catch {
        const arrayMatch = jsonText.match(/\[[\s\S]*?\]/);
        if (arrayMatch) {
          try {
            items = JSON.parse(arrayMatch[0]);
          } catch {
            this.logger.warn(
              { source, responsePreview: content.text.substring(0, 200) },
              "Extraction JSON parse failed after regex fallback",
            );
            return;
          }
        } else {
          this.logger.warn(
            { source, responsePreview: content.text.substring(0, 200) },
            "Extraction JSON parse failed, no JSON array found",
          );
          return;
        }
      }
      if (!Array.isArray(items)) return;

      // ── Critic pass: filter out meta-observations ──
      items = await this.runCritic(items, source);

      let factsStored = 0;
      let patternsStored = 0;
      let reinforcements = 0;

      for (const item of items) {
        try {
          const itemType = item["type"] ?? "fact";

          if (itemType === "fact" || !item["type"]) {
            const key = item["key"];
            const value = item["value"];
            if (
              key && value &&
              typeof key === "string" && typeof value === "string" &&
              FACT_KEY_REGEX.test(key) &&
              value.length <= MAX_FACT_VALUE_LENGTH
            ) {
              await this.knowledgeService.setFact(key, value, source, projectId, 0.8, product);
              factsStored++;
            }
          } else if (itemType === "pattern") {
            if (!this.memoryService) continue;
            const key = item["key"];
            const category = item["category"];
            const description = item["description"];
            if (
              key && category && description &&
              typeof key === "string" && typeof category === "string" && typeof description === "string" &&
              PATTERN_CATEGORIES.has(category)
            ) {
              await this.memoryService.storePattern(
                key,
                category as "communication" | "workflow" | "preference" | "emotional" | "technical",
                description,
                product,
              );
              patternsStored++;
            }
          } else if (itemType === "reinforce") {
            if (!this.memoryService) continue;
            const key = item["key"];
            if (key && typeof key === "string") {
              await this.memoryService.reinforcePattern(key, product);
              reinforcements++;
            }
          }
        } catch {
          // Skip malformed items, continue processing
        }
      }

      // Embed the conversation chunk into Tier 3 long-term memory
      if (this.memoryService) {
        try {
          const embedding = this.embed ? await this.embed(truncated) : null;
          if (embedding) {
            await this.memoryService.indexWithEmbedding(
              truncated,
              source.startsWith("pipeline:") ? "pipeline_extraction" : "conversation_extraction",
              source,
              projectId,
              embedding,
              product,
            );
          } else {
            await this.memoryService.indexMemory(
              truncated,
              source.startsWith("pipeline:") ? "pipeline_extraction" : "conversation_extraction",
              source,
              projectId,
              undefined,
              product,
            );
          }
        } catch (embErr) {
          this.logger.warn({ err: embErr }, "Embedding failed, indexed without vector");
          await this.memoryService.indexMemory(
            truncated,
            source.startsWith("pipeline:") ? "pipeline_extraction" : "conversation_extraction",
            source,
            projectId,
            undefined,
            product,
          );
        }
      }

      this.logger.info(
        { source, factsExtracted: factsStored, patternsExtracted: patternsStored, reinforcements },
        "Extraction complete",
      );

      this.onEvent?.({ type: "memory_extracted", data: { source, factsExtracted: factsStored, patternsExtracted: patternsStored, reinforcements } });
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error), source },
        "Extraction failed",
      );
    }
  }

  /**
   * Extract facts from a completed pipeline.
   */
  extractFromPipeline(
    projectId: string,
    projectName: string,
    spec: string,
    decisions: Array<{ decision: string; rationale?: string }>,
    success: boolean,
    durationSeconds: number,
    product: ProductId = "ox",
  ): void {
    const decisionsText = decisions
      .map((d) => `- ${d.decision}${d.rationale ? " (" + d.rationale + ")" : ""}`)
      .join("\n");

    const text = [
      `Project "${projectName}" ${success ? "completed successfully" : "failed"}.`,
      `Duration: ${Math.round(durationSeconds / 60)} minutes.`,
      `User spec: ${spec}`,
      decisions.length > 0 ? `Decisions made:\n${decisionsText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    this.enqueue(() => this.extractAndStore(text, `pipeline:${projectName}`, projectId, product));
  }

  /**
   * Extract facts from a user conversation exchange.
   */
  extractFromConversation(
    userMessage: string,
    oxResponse: string,
    projectId?: string,
    product: ProductId = "ox",
  ): void {
    const text = `User: ${userMessage}\nOX: ${oxResponse}`;
    this.enqueue(() => this.extractAndStore(text, "conversation", projectId, product));
  }

  /**
   * Critic pass: evaluate candidate facts for substantive content.
   * On any failure, returns items unfiltered (no critic = keep all).
   */
  private async runCritic(
    items: Array<Record<string, string>>,
    source: string,
  ): Promise<Array<Record<string, string>>> {
    const factItems = items.filter((i) => (i["type"] ?? "fact") === "fact" || !i["type"]);
    const nonFactItems = items.filter((i) => i["type"] && i["type"] !== "fact");

    if (factItems.length === 0 || !this.usageAccountant) {
      return items;
    }

    try {
      const factsForCritic = factItems
        .filter((i) => i["key"] && i["value"])
        .map((i) => ({ key: i["key"], value: i["value"] }));

      if (factsForCritic.length === 0) return items;

      const response = await callHaikuMetered(
        {
          apiKey: this.apiKey,
          system: CRITIC_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: JSON.stringify(factsForCritic),
            },
          ],
          maxTokens: 512,
          temperature: 0,
          timeoutMs: 10_000,
        },
        UsageComponent.FACT_EXTRACTION_CRITIC,
        "system",
        undefined,
        this.usageAccountant,
      );

      const block = response.content[0];
      if (!block || block.type !== "text") return items;

      let verdicts: Array<{ key: string; keep: boolean; reason?: string }>;
      try {
        verdicts = JSON.parse(block.text);
      } catch {
        const match = block.text.match(/\[[\s\S]*\]/);
        if (!match) return items;
        verdicts = JSON.parse(match[0]);
      }

      if (!Array.isArray(verdicts)) return items;

      const dropKeys = new Set<string>();
      for (const v of verdicts) {
        if (v.key && v.keep === false) {
          dropKeys.add(v.key);
          this.logger.info(
            { key: v.key, reason: v.reason, source },
            "Critic rejected fact",
          );
        }
      }

      if (dropKeys.size === 0) return items;

      const keptFacts = factItems.filter((i) => !dropKeys.has(i["key"] ?? ""));
      return [...keptFacts, ...nonFactItems];
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), source },
        "Critic pass failed, keeping all facts",
      );
      return items;
    }
  }
}
