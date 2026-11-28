import {
  catalog as activityCatalog,
  isLiteralText,
  type ActivityCatalog,
} from '@autonomy-studio/shared';

/**
 * #1574 OR39 — which activity fields are DYNAMIC (may be set to a `${}`
 * expression), derived from each execution activity's config schema.
 *
 * Today's rule, until the dynamic-field ticket declares the set on the catalog:
 * a top-level field is dynamic when its value is text (a string or a choice)
 * and it is not tagged `literalText` (used verbatim, never substituted: a SQL
 * script, a column name). Typed fields (numbers, booleans, lists, objects) are
 * literal-only in the editor today, so they are not in the set; when they
 * become dynamic, this derivation widens and the matrix demands their cells.
 */

interface Def {
  readonly type?: string;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly shape?: Record<string, unknown>;
}

const defOf = (schema: unknown): Def | undefined =>
  (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

/** Wrappers that change neither the value's type nor whether it is text. */
const WRAPPERS = new Set(['optional', 'default', 'prefault', 'nullable', 'readonly', 'catch']);

/** The schema under its wrappers, and whether any layer is tagged literal. */
function unwrap(schema: unknown): { core: unknown; literal: boolean } {
  let current = schema;
  let literal = isLiteralText(current);
  for (let depth = 0; depth < 16; depth += 1) {
    const def = defOf(current);
    if (def === undefined) break;
    const next =
      def.type === 'pipe' ? def.in : WRAPPERS.has(def.type ?? '') ? def.innerType : undefined;
    if (next === undefined) break;
    current = next;
    literal ||= isLiteralText(current);
  }
  return { core: current, literal };
}

/** The top-level fields of an activity's config schema. */
function fieldsOf(schema: unknown): Record<string, unknown> {
  const { core } = unwrap(schema);
  const def = defOf(core);
  return def?.type === 'object' && def.shape !== undefined ? def.shape : {};
}

/** `<activity>.<field>` for every dynamic field, sorted. */
export function dynamicFields(catalog: ActivityCatalog = activityCatalog): string[] {
  const out: string[] = [];
  for (const entry of catalog.values()) {
    if (entry.kind !== 'execution') continue;
    for (const [field, schema] of Object.entries(fieldsOf(entry.configSchema))) {
      if (field === 'outputs') continue;
      const { core, literal } = unwrap(schema);
      const type = defOf(core)?.type;
      if (!literal && (type === 'string' || type === 'enum')) out.push(`${entry.type}.${field}`);
    }
  }
  return out.sort();
}

/** A text field's choices, when it is a choice; the first is a value that runs. */
export function choicesOf(activity: string, field: string): readonly string[] | undefined {
  const entry = activityCatalog.get(activity);
  if (entry === undefined) return undefined;
  const { core } = unwrap(fieldsOf(entry.configSchema)[field]);
  const def = defOf(core) as (Def & { entries?: Record<string, string> }) | undefined;
  return def?.type === 'enum' && def.entries !== undefined ? Object.values(def.entries) : undefined;
}
