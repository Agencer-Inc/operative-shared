import type { KnowledgeFact } from "./knowledge-service.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ProductId } from "./knowledge-service.js";
import { callHaikuMetered, UsageComponent } from "@agencer/usage-accountant";
import type { UsageAccountant } from "@agencer/usage-accountant";

// ── Haiku-driven fact recall ──────────────────────────────

const RECALL_SYSTEM_PROMPT = `You are OX's associative memory. Given a user query and a list of candidate facts (each with an id, key, and short value), return the IDs of up to 5 facts most relevant to the query.

A fact is relevant if it would change what OX would say next. Favor substantive content over meta-observations about the conversation. Consider semantic relevance, not just keyword overlap.

Return JSON only: {"ids": ["fact_id_1", "fact_id_2", ...]}
If no facts are relevant, return: {"ids": []}`;

/** Context for a recall call. Replaces OperativeX's ToolContext. */
export interface RecallContext {
  knowledgeService: KnowledgeService;
  memoryService: MemoryService;
  usageAccountant?: UsageAccountant;
  anthropicApiKey?: string;
  product?: ProductId;
}

/**
 * Use Haiku to select the most relevant facts from the knowledge store.
 * Falls back to String.includes() substring matching on failure.
 */
export async function recallFactsWithHaiku(
  query: string,
  allFacts: KnowledgeFact[],
  queryLower: string,
  ctx: RecallContext,
): Promise<KnowledgeFact[]> {
  const apiKey = ctx.anthropicApiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (allFacts.length === 0 || !apiKey || !ctx.usageAccountant) {
    return substringFallback(allFacts, queryLower);
  }

  try {
    const sortedByRecency = [...allFacts].sort(
      (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
    );
    const recentFacts = sortedByRecency.slice(0, 100);
    const digest = recentFacts
      .map((f) => {
        const truncValue = f.factValue.length > 200 ? f.factValue.substring(0, 200) + "..." : f.factValue;
        return `${f.id}|${f.factKey}|${truncValue}`;
      })
      .join("\n");

    const response = await callHaikuMetered(
      {
        apiKey,
        system: RECALL_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Query: ${query}\n\nFacts (id|key|value):\n${digest}`,
          },
        ],
        maxTokens: 256,
        temperature: 0,
        timeoutMs: 10_000,
      },
      UsageComponent.FACT_RECALL,
      "system",
      undefined,
      ctx.usageAccountant,
    );

    const block = response.content[0];
    if (!block || block.type !== "text") {
      return substringFallback(allFacts, queryLower);
    }

    let parsed: { ids: string[] };
    try {
      parsed = JSON.parse(block.text);
    } catch {
      const match = block.text.match(/\{[\s\S]*?\}/);
      if (!match) return substringFallback(allFacts, queryLower);
      parsed = JSON.parse(match[0]);
    }

    if (!parsed.ids || !Array.isArray(parsed.ids) || parsed.ids.length === 0) {
      return substringFallback(allFacts, queryLower);
    }

    const idSet = new Set(parsed.ids.slice(0, 5));
    const selectedFacts = allFacts.filter((f) => idSet.has(f.id));

    if (selectedFacts.length === 0) {
      return substringFallback(allFacts, queryLower);
    }

    return selectedFacts;
  } catch {
    return substringFallback(allFacts, queryLower);
  }
}

/** Original substring-match recall. Used as fallback when Haiku is unavailable. */
function substringFallback(allFacts: KnowledgeFact[], queryLower: string): KnowledgeFact[] {
  return allFacts.filter(
    (f) =>
      f.factKey.toLowerCase().includes(queryLower) ||
      f.factValue.toLowerCase().includes(queryLower),
  );
}

/**
 * Full recall: searches all memory tiers for a query.
 * Standalone replacement for the recall tool handler in OperativeX's tool-registry.
 */
export async function recallWithHaiku(
  query: string,
  ctx: RecallContext,
): Promise<string> {
  try {
    if (!query.trim()) return "Error: query is required";

    const alphanumChars = query.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumChars.length < 2) return "Error: query must contain at least 2 letters or digits";

    const sections: string[] = [];
    const queryLower = query.toLowerCase();
    const product = ctx.product ?? "ox";

    // Tier 1: Search knowledge_facts
    const allFacts = await ctx.knowledgeService.getAllFacts(product);
    const matchingFacts = await recallFactsWithHaiku(query, allFacts, queryLower, ctx);
    if (matchingFacts.length > 0) {
      const factLines = matchingFacts
        .slice(0, 10)
        .map((f) => `- ${f.factKey} = ${f.factValue}`);
      sections.push(`**Known facts (${matchingFacts.length}):**\n${factLines.join("\n")}`);
    }

    // Tier 1.5: Search memory_patterns
    const patterns = await ctx.memoryService.getPatterns(product);
    const matchingPatterns = patterns.filter(
      (p) =>
        p.patternKey.toLowerCase().includes(queryLower) ||
        p.category.toLowerCase().includes(queryLower),
    );
    if (matchingPatterns.length > 0) {
      const patternLines = matchingPatterns
        .slice(0, 5)
        .map((p) => `- ${p.patternKey} (${p.category}, confidence ${p.confidence.toFixed(1)}, seen ${p.timesSeen}x)`);
      sections.push(`**Behavioral patterns (${matchingPatterns.length}):**\n${patternLines.join("\n")}`);
    }

    // Tier 3: FTS5 search
    const ftsResults = await ctx.memoryService.searchLongTerm(query, 5, product);
    if (ftsResults.length > 0) {
      const ftsLines = ftsResults.map((r) => {
        const shortContent = r.content.length > 300 ? r.content.substring(0, 300) + "..." : r.content;
        return `- [${r.sourceType}] (${r.projectName}, ${r.createdAt}): ${shortContent}`;
      });
      sections.push(`**Conversations & pipelines (${ftsResults.length}):**\n${ftsLines.join("\n\n")}`);
    }

    // Tier 4: Episodic memory
    const episodicResults = await ctx.memoryService.recallEpisodic(query, 5, product);
    if (episodicResults.length > 0) {
      const episodicLines = episodicResults.map((r) => {
        const shortContent = r.content.length > 300 ? r.content.substring(0, 300) + "..." : r.content;
        return `- [${r.role}] (${r.createdAt}): ${shortContent}`;
      });
      sections.push(`**Voice transcripts (${episodicResults.length}):**\n${episodicLines.join("\n\n")}`);
    }

    if (sections.length === 0) {
      return `No memories found for "${query}". I don't have anything stored about that.`;
    }

    return `Memory search for "${query}":\n\n${sections.join("\n\n")}`;
  } catch (error) {
    return `Recall error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
