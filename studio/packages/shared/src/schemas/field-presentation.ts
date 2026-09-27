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
 * of metadata; this one is typed and holds this one fact.
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
