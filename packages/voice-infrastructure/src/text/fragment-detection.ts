// ─────────────────────────────────────────────────────────────
// Fragment Detection
//
// Detect whether user text is an incomplete fragment (mid-sentence
// pause) rather than a finished thought. Used to decide whether
// to generate a short contextual acknowledgment vs a full response.
// ─────────────────────────────────────────────────────────────

const TRAILING_CONNECTORS = /\b(and|but|so|or|because|like|um|uh|you know|i mean|well|actually|basically|right|then|also)\s*[,.]?\s*$/i;
const FILLER_ONLY = /^(um+|uh+|hmm+|hm+|mhm+|ah+|oh+|like|so|well|yeah|yep|okay|ok)\s*[,.]?\s*$/i;

/**
 * Detect whether user text is an incomplete fragment (mid-sentence pause)
 * rather than a finished thought. Used to decide whether to generate a
 * short contextual acknowledgment vs a full Brain response.
 *
 * Criteria (any one is sufficient):
 * - Filler-only utterance ("um", "hmm", "like")
 * - Ends with a trailing connector ("and", "but", "so", "because")
 * - Short text (< 5 words) with no terminal punctuation
 * - Ends with a comma
 */
export function isFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Filler-only utterances are always fragments
  if (FILLER_ONLY.test(trimmed)) return true;

  // Trailing connector ("I was thinking about, like,")
  if (TRAILING_CONNECTORS.test(trimmed)) return true;

  // Ends with comma (speaker paused mid-list or mid-clause)
  if (trimmed.endsWith(",")) return true;

  // Short text with no terminal punctuation
  const words = trimmed.split(/\s+/).filter(Boolean);
  const hasTerminalPunct = /[.?!]$/.test(trimmed);
  if (words.length < 5 && !hasTerminalPunct) return true;

  return false;
}
