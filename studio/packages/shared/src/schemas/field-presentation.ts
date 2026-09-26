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
  readonly singleLine: true;
}

export const fieldPresentation = z.registry<FieldPresentation>();

/**
 * Tag a string schema as single-line and return the SAME instance, so identity
 * checks elsewhere keep working. A later `.min()`/`.refine()` clone still
 * reports the tag (zod's registry reads through a clone's parent), but an
 * `.optional()`/`.default()` wrapper does not, so a reader walks the wrappers.
 */
export function singleLine<T extends z.ZodType>(schema: T): T {
  fieldPresentation.add(schema, { singleLine: true });
  return schema;
}

/** Whether `schema` itself (not a wrapper around it) is tagged single-line. */
export function isSingleLine(schema: unknown): boolean {
  // Structural, not `instanceof`: a schema built by another copy of zod would
  // fail `instanceof` and silently lose its tag.
  if (typeof schema !== 'object' || schema === null || !('_zod' in schema)) return false;
  return fieldPresentation.get(schema as z.ZodType)?.singleLine === true;
}
