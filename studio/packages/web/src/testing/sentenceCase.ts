/**
 * #1594 OR40 S4 — the sentence-case rule for UI names: catalog titles, nav
 * labels, pane titles, kind labels.
 *
 * The first word starts with a capital; every later word is lower case unless it
 * is an acronym (ID, CSV, HTTP…) or a proper name (ForEach, SQLite…). A word in
 * parentheses is held to the later-word rule ("Webhook (external wait)").
 *
 * Shared by the unit test over the label maps and the e2e over rendered text, so
 * the two cannot disagree about what sentence case is.
 */
export const ACRONYMS: readonly string[] = [
  'AI',
  'API',
  'CLI',
  'CSV',
  'HTTP',
  'ID',
  'JSON',
  'LLM',
  'SQL',
  'URL',
];

/** Product, vendor and activity proper names, written as their owners write them. */
export const PROPER_NAMES: readonly string[] = [
  'Anthropic',
  'Autonomy',
  'Excel',
  'ForEach',
  'Ollama',
  'OpenAI',
  'PostgreSQL',
  'SQLite',
];

const KEPT = new Set([...ACRONYMS, ...PROPER_NAMES]);

/**
 * Why `text` is not sentence case, or `null` when it is. The reason names the
 * offending word, so a failing test says which.
 */
export function sentenceCaseProblem(text: string): string | null {
  const words = text
    .split(/[\s()/·—,]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter((w) => w.length > 0);
  for (const [i, word] of words.entries()) {
    if (KEPT.has(word)) continue;
    if (ACRONYMS.includes(word.replace(/s$/, ''))) continue; // "IDs", "URLs"
    if (!/\p{L}/u.test(word)) continue; // "2", "1440"
    const rest = word.slice(1);
    if (rest !== rest.toLowerCase()) return `"${word}" has a capital inside it`;
    const first = word[0];
    if (first === undefined) continue;
    if (i === 0 && first !== first.toUpperCase()) return `"${word}" should start with a capital`;
    if (i > 0 && first !== first.toLowerCase()) return `"${word}" should be lower case`;
  }
  return null;
}

/**
 * #1594 OR40 S4b — why a control's NAME (its label, `aria-label` or button text)
 * breaks the label rules, or `null`. A name is sentence case, ends without a colon
 * or a period, and says "parameter", never the key `param`.
 *
 * A `?`'s name, "About <name>", quotes the name it explains ("About Parameters"),
 * so the quoted name is what is checked.
 *
 * Message text is not held to this: a validation line or a hint is a sentence.
 */
export function labelProblem(text: string): string | null {
  const about = /^About (.+)$/u.exec(text.trim());
  if (about?.[1] !== undefined) return labelProblem(about[1]);
  // An ellipsis is the one character "…", so a trailing "..." is refused too.
  if (/[:.]$/u.test(text.trim())) return 'ends with a colon or a period';
  const banned = text.split(/[^\p{L}]+/u).find((w) => /^params?$/i.test(w));
  if (banned !== undefined) return `"${banned}" should be "parameter"`;
  return sentenceCaseProblem(text);
}
