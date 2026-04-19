// ─────────────────────────────────────────────────────────────
// Strip Markdown for TTS
//
// TTS engines speak markdown syntax literally ("asterisk asterisk
// PIPELINE START asterisk asterisk"). Strip all markdown syntax,
// keeping only the plain text content.
// ─────────────────────────────────────────────────────────────

/** Strip markdown syntax from text destined for TTS. */
export function stripMarkdownForTTS(text: string): string {
  return text
    // Bold/italic: **text** -> text, *text* -> text, __text__ -> text, _text_ -> text
    .replace(/\*{1,3}([^*]*)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]*)_{1,3}/g, "$1")
    // Inline code: `code` -> code
    .replace(/`([^`]*)`/g, "$1")
    // Headers: ## Heading -> Heading
    .replace(/^#{1,6}\s+/gm, "")
    // Bullet points: - item or * item -> item
    .replace(/^[\s]*[-*]\s+/gm, "")
    // Numbered lists: 1. item -> item
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // Stray asterisks not caught above (e.g. lone ** at chunk boundaries)
    .replace(/\*{2,}/g, "")
    // Horizontal rules: --- or *** or ___
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Links: [text](url) -> text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Collapse multiple spaces
    .replace(/ {2,}/g, " ");
}
