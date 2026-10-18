/**
 * Deep clone a JSON value via a JSON round-trip: lossless for the documents,
 * configs and variable defaults studio stores, which are all JSON, and it needs
 * no `structuredClone` global (absent from the shared `ES2023` lib set). An own
 * `__proto__` key survives: `JSON.parse` defines it as a property.
 */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
