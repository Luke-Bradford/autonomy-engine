/**
 * #1594 OR40 S4 — the words a UI name keeps in capitals, and how a key reads as
 * words. `testing/sentenceCase.ts` holds names to the rule with these lists;
 * the app builds names with them, so the two cannot disagree.
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
 * A config key as sentence-case words: `onError` → "On error", `secret name` →
 * "Secret name", `baseUrl` → "Base URL". For a cell the schema gives no title.
 */
export function keyToWords(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter((w) => w !== '')
    .map((w) => {
      const upper = w.toUpperCase();
      return ACRONYMS.includes(upper) ? upper : w.toLowerCase();
    });
  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * A sentence-case name as it reads inside a longer one: "Column mapping" →
 * "column mapping", while "LLM call" and "ForEach" keep their capitals.
 */
export function midSentence(text: string): string {
  const first = text.split(' ', 1)[0] ?? '';
  if (KEPT.has(first)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}
