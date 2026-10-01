import { z } from 'zod';

/**
 * How a config field should be PRESENTED by a form derived from its schema
 * (#852 item 4). Presentation only: nothing here is read by validation,
 * dispatch or the engine, and a schema with no entry is authored exactly as
 * before.
 *
 * `singleLine` marks a string that is an identifier, a path, a URL, a model
 * name or a short literal, so the form offers a one-line `<input>` rather than
 * the `<textarea>` a prompt or an expression needs. Nothing in a `z.string()`
 * distinguishes the two, and the alternative, a per-field-name list in the web
 * package, is the magic-string table deriving the form from the schema exists
 * to avoid.
 *
 * A dedicated registry rather than `.meta()`. `.meta()` writes into zod's
 * process-global registry, which is untyped and shared with every other reader
 * of metadata; this one is typed and holds only presentation facts.
 *
 * #1396 added the human half of a label: `title`, `description` and `unit`, so
 * a form says "Base URL" where it used to say `baseUrl`. The KEY is still what
 * the server's messages and advisories cite (`timeoutMs: …`), which is why a
 * form shows it beside a titled field rather than replacing it.
 */
export interface FieldPresentation {
  readonly singleLine?: true;
  /**
   * #864 item 4: the field is AUTHORED as `${}` expression text, and the
   * schema types only the value that text RESOLVES to at dispatch.
   * `llm_call.history` is the case: its save gate refuses anything but a
   * string, while this schema is the turn array the reference produces. So a
   * form offers expression text, and must not check that text against the
   * schema, which would refuse every value the save gate accepts.
   *
   * It says nothing about whole-value versus interpolation. That rule lives
   * in the save gate alone, which the expression flyout already probes.
   */
  readonly authoredAsExpression?: true;
  /**
   * #844 V6: the field's text is used VERBATIM and never substituted, so a form
   * must not offer the `${}` expression flyout on it. `set_variable`'s
   * `variable` is the case: it names the variable the determinism guard matches
   * literally, and the save gate refuses a `${` in it.
   *
   * Why a tag and not the flyout's usual no-false-offer probe (each candidate
   * run through the whole-doc validator, dropped if it adds an issue): the
   * probe only sees a NEW issue. On a freshly dropped writer the field is
   * blank, which the gate already refuses with the same message it gives a
   * `${}` — so every reference would count as adding nothing, and all of them
   * would be offered.
   */
  readonly literal?: true;
  /** #1396: the field's human name ("Base URL"), shown instead of its key. */
  readonly title?: string;
  /** #1396: one sentence saying what the field does, shown under the control. */
  readonly description?: string;
  /**
   * #1396: the unit the STORED value is in ("ms", "bytes"), shown after the
   * title. Presentation only: it never converts, so it must name what the key
   * actually holds.
   */
  readonly unit?: string;
  /**
   * #1396: an enum field's display name for each value ("Metadata only" for
   * `metadata`). The option's VALUE is still what is stored and what messages
   * cite; only the text of the choice changes. Build it with `optionTitles`, so
   * a value added to the enum without a name fails the typecheck.
   */
  readonly options?: Readonly<Record<string, string>>;
}

/** The human-facing half of a field's presentation (#1396). */
export interface FieldLabel {
  readonly title: string;
  readonly description?: string;
  readonly unit?: string;
  readonly options?: Readonly<Record<string, string>>;
}

export const fieldPresentation = z.registry<FieldPresentation>();

/** Add `fact` to `schema`'s entry, keeping any fact it already carries. */
function tag<T extends z.ZodType>(schema: T, fact: FieldPresentation): T {
  // `get` reads through a clone's parent, so this merges with an inherited
  // entry too, and the clone gets its own entry holding both facts.
  fieldPresentation.add(schema, { ...fieldPresentation.get(schema), ...fact });
  return schema;
}

/**
 * Tag a string schema as single-line and return the SAME instance, so identity
 * checks elsewhere keep working. A later `.min()`/`.refine()` clone still
 * reports the tag (zod's registry reads through a clone's parent), but an
 * `.optional()`/`.default()` wrapper does not, so a reader walks the wrappers.
 */
export function singleLine<T extends z.ZodType>(schema: T): T {
  return tag(schema, { singleLine: true });
}

/** Tag a schema as authored as `${}` expression text, returning the SAME instance. */
export function authoredAsExpression<T extends z.ZodType>(schema: T): T {
  return tag(schema, { authoredAsExpression: true });
}

/** Tag a string schema as literal (never substituted), returning the SAME instance. */
export function literalText<T extends z.ZodType>(schema: T): T {
  return tag(schema, { literal: true });
}

/**
 * Give a field a human title (and optionally a description and unit),
 * returning the SAME instance. Tag either the field or its `.optional()`
 * wrapper: a form reads every layer.
 */
export function presented<T extends z.ZodType>(schema: T, label: FieldLabel): T {
  return tag(schema, label);
}

/** `schema`'s own human label (not a wrapper's), if it has one. */
export function fieldLabelOf(schema: unknown): FieldLabel | undefined {
  const entry = presentationOf(schema);
  if (entry?.title === undefined) return undefined;
  return {
    title: entry.title,
    ...(entry.description !== undefined && { description: entry.description }),
    ...(entry.unit !== undefined && { unit: entry.unit }),
    ...(entry.options !== undefined && { options: entry.options }),
  };
}

/**
 * #1396 — a display name for every value of `schema`, checked at compile time:
 * leaving a value out, or naming one the enum does not have, is a type error.
 * The schema argument only carries the type.
 */
export function optionTitles<const V extends string>(
  _schema: z.ZodEnum<{ [K in V]: K }>,
  titles: { readonly [K in V]: string },
): Readonly<Record<V, string>> {
  return titles;
}

/**
 * The values of an enum field, seen through every `.optional()`/`.default()`
 * wrapper, or `undefined` when the field is not a string enum. What the
 * "every enum value is named" gates walk.
 */
export function enumValuesOf(schema: unknown): readonly string[] | undefined {
  let current: unknown = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || !('_zod' in current)) return undefined;
    const def = (current as { _zod: { def: { type?: string; innerType?: unknown } } })._zod.def;
    if (def.type === 'enum') {
      const options = (current as { options?: unknown }).options;
      return Array.isArray(options) && options.every((o) => typeof o === 'string')
        ? (options as string[])
        : undefined;
    }
    current = def.innerType;
  }
  return undefined;
}

/**
 * #1396 — a top-level field's human label, from the field or the ONE wrapper
 * (`.optional()`, `.default()`) around it. The "every field is titled" gates on
 * each catalog share this read. The form itself (`configForm.ts`'s `unwrap`)
 * reads through every layer, so a title tagged two wrappers deep renders but
 * fails these gates: tag the field or its outermost wrapper.
 */
export function fieldLabelThrough(schema: unknown): FieldLabel | undefined {
  const inner =
    typeof schema === 'object' && schema !== null && '_zod' in schema
      ? (schema as { _zod: { def: { innerType?: unknown } } })._zod.def.innerType
      : undefined;
  return fieldLabelOf(schema) ?? fieldLabelOf(inner);
}

/** The first label on `schema` or a wrapper inside it, outermost first. */
function outermostLabel(schema: unknown): FieldLabel | undefined {
  let current: unknown = schema;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    const label = fieldLabelOf(current);
    if (label !== undefined) return label;
    current =
      typeof current === 'object' && current !== null && '_zod' in current
        ? (current as { _zod: { def: { innerType?: unknown } } })._zod.def.innerType
        : undefined;
  }
  return undefined;
}

/**
 * `field.value` for every enum value in `shape` that has no display name — the
 * "every enum value is named" gates on each catalog share this read. Names are
 * read the way the form reads them (`configForm.ts`'s `unwrap`): from the
 * outermost layer that carries a label. A name shared by two values counts as
 * missing on both.
 */
export function unnamedEnumValues(shape: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(shape).flatMap(([name, field]) => {
    const values = enumValuesOf(field) ?? [];
    const names = outermostLabel(field)?.options ?? {};
    return values
      .filter((v) => {
        const title = names[v];
        return (
          title === undefined ||
          !/\S/.test(title) ||
          values.some((other) => other !== v && names[other] === title)
        );
      })
      .map((v) => `${name}.${v}`);
  });
}

/** `schema`'s own presentation entry (not a wrapper's), if it has one. */
function presentationOf(schema: unknown): FieldPresentation | undefined {
  // Structural, not `instanceof`: a schema built by another copy of zod would
  // fail `instanceof` and silently lose its tag.
  if (typeof schema !== 'object' || schema === null || !('_zod' in schema)) return undefined;
  return fieldPresentation.get(schema as z.ZodType);
}

/** Whether `schema` itself (not a wrapper around it) is tagged single-line. */
export function isSingleLine(schema: unknown): boolean {
  return presentationOf(schema)?.singleLine === true;
}

/** Whether `schema` itself (not a wrapper around it) is authored as expression text. */
export function isAuthoredAsExpression(schema: unknown): boolean {
  return presentationOf(schema)?.authoredAsExpression === true;
}

/** Whether `schema` itself (not a wrapper around it) is tagged literal. */
export function isLiteralText(schema: unknown): boolean {
  return presentationOf(schema)?.literal === true;
}
