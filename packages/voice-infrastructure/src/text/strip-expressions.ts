// ─────────────────────────────────────────────────────────────
// Strip Expression Tags
//
// LLMs output [chuckles], [pause], [thoughtful], etc. as emotional
// stage directions. TTS should NOT speak these literally.
// Also strips leading ellipsis that LLMs sometimes produce.
// ─────────────────────────────────────────────────────────────

/**
 * Strip expression/stage-direction tags from text destined for TTS.
 */
export function stripExpressionTags(text: string): string {
  return text
    // Expression/stage-direction tags: [chuckles], [pause], [thoughtful], etc.
    .replace(/\[(?:chuckles?|laughs?|pauses?d?|thoughtful|excited|quiet|serious|soft|gentle|curious|sighs?|nodding?|leaning[^\]]*|waiting|attentive|slight[^\]]*|warmly|smiling|grinning|brief[^\]]*|beat|more[^\]]*)\]/gi, "")
    // Collapse multiple spaces left after stripping (but preserve single trailing spaces)
    .replace(/ {2,}/g, " ");
}
