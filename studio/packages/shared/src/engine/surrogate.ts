/**
 * UTF-16 cut helpers. Moved here from the web run view (#605) so the server's
 * `llm_call` capture budget and the monitor's display caps cut text by ONE rule
 * rather than two copies of it.
 */

/** A UTF-16 high surrogate — the FIRST half of an astral character's pair. */
export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Where to cut `text` so that it keeps at most `max` UTF-16 units WITHOUT
 * splitting an astral character's surrogate pair — `max`, or one less when the
 * last kept unit would be a lone high surrogate (rendered as a replacement
 * glyph instead of ending where it was cut). Callers decide what to do with the
 * remainder; this only answers where it starts.
 */
export function surrogateSafeCut(text: string, max: number): number {
  return isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
}
