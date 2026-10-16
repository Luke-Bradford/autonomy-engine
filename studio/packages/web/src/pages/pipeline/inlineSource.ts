import { interpolationMode, restoreEscapes, type InlineDataset } from '@autonomy-studio/shared';

/**
 * #1600 OR41 C1q-b — the pure rules behind the inline source's bind values
 * (`InlineSourceEditor`): the `:name`s an inline query binds, stored in its
 * `config.parameters` record keyed WITHOUT the colon.
 */

/** Why a typed bind-value name cannot be stored, or `null` when it can. */
export function bindNameProblem(name: string, others: readonly string[]): string | null {
  if (name === '') return 'Name it as it is written after : in the statement.';
  // Keys are stored WITHOUT the colon, so `:wm` would silently never bind.
  if (name.startsWith(':')) return 'Leave out the leading :.';
  if (/\s/.test(name)) return 'A name has no spaces.';
  if (others.includes(name)) return `:${name} is already bound.`;
  return null;
}

/**
 * The value a bind-value box's text stores. A bind value may be a string, a
 * number or null (`SqlParameterValueSchema`), and typing must not change which:
 * a stored number stays a number while the text still reads as one, so editing
 * `100` to `150` binds a number as it did. Any other text is stored as typed,
 * a `${}` included (resolved at dispatch, keeping the type it resolves to).
 */
export function coerceBindValue(stored: unknown, text: string): string | number {
  if (typeof stored === 'number' && text.trim() !== '') {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

/** A bind value as its box's text: a stored `null` is an empty box. */
export function bindValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

/**
 * The record with key `from` renamed to `to`, in place in the key order so the
 * row does not jump to the end of the table. Built with `Object.fromEntries`,
 * which defines own keys: assigning `next['__proto__']` would set the
 * prototype instead and the row would vanish with its value.
 */
export function renameKey(
  record: Readonly<Record<string, unknown>>,
  from: string,
  to: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k === from ? to : k, v]));
}

/** `p1`, `p2`, … — the first not already taken; the author renames it to the statement's `:name`. */
export function freshBindName(taken: readonly string[]): string {
  for (let i = 1; ; i += 1) if (!taken.includes(`p${i}`)) return `p${i}`;
}

/**
 * #1600 C1q-c — Preview. A bind value is DYNAMIC when the run would evaluate it,
 * decided by the run's own classifier (`interpolationMode`, which `substitute`
 * uses), so a `$${` escape is literal here exactly as it is there.
 */
function isDynamic(value: unknown): value is string {
  return typeof value === 'string' && interpolationMode(value).mode !== 'literal';
}

/** The bind names whose value is a `${}`: Preview asks for a value in its place. */
export function dynamicBindNames(inline: InlineDataset): string[] {
  const parameters = parametersOf(inline);
  return Object.keys(parameters).filter((name) => isDynamic(parameters[name]));
}

/**
 * A typed preview value as the run would bind it. A `${}` resolves keeping its
 * type, so `5` binds as a number (text would compare unequal to an integer
 * column); anything that does not read back as the same finite number stays
 * text, so `007`, ` 5` and `NaN` are still text.
 */
export function previewBindValue(text: string): string | number {
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && String(n) === text ? n : text;
}

/**
 * The inline source as Preview sends it: every bind value literal. A `${}` takes
 * the operator's preview value (blank binds as empty text), and a literal value
 * resolves its `$${` escapes as the run's substitution does.
 */
export function previewInline(
  inline: InlineDataset,
  values: Readonly<Record<string, string>>,
): InlineDataset {
  if (inline.config['parameters'] === undefined) return inline;
  const parameters = parametersOf(inline);
  const resolved = Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [
      name,
      isDynamic(value)
        ? previewBindValue(values[name] ?? '')
        : typeof value === 'string'
          ? restoreEscapes(interpolationMode(value).scanned)
          : value,
    ]),
  );
  return { kind: inline.kind, config: { ...inline.config, parameters: resolved } };
}

function parametersOf(inline: InlineDataset): Record<string, unknown> {
  const raw = inline.config['parameters'];
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
