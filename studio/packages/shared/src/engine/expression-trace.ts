/**
 * #1567 OR36 A2 — the run log's record of how each `${}` became a value, so a
 * past run can be audited: `${concat(nodes.list.output.path,'/',item.name)}`
 * became `/landing/orders_2026-09.csv`, and `nodes.list.output.path` was
 * `/landing` when it did.
 *
 * Recorded by the SAME evaluation that produced the value (`substitute`'s
 * `trace` argument), never by evaluating again, so the record cannot disagree
 * with what ran. Stored as bounded JSON text (`DispatchInput`), cut and marked
 * exactly as `node.dispatched.input` is, and the marker on a secure node.
 *
 * What it holds is what `${}` output already holds: secret params are stripped
 * from substitution and `{$secret}` markers are never resolved by it, so no
 * secret value reaches a record (`dispatch-input.ts` says why).
 */
import type { DispatchInput } from './types.js';
import { boundedJson } from './dispatch-input.js';

/** One `${}` field: the text the author wrote, what it became, and each reference's value. */
export interface ExpressionRecord {
  template: string;
  value: unknown;
  /** Each reference the evaluation resolved, by its source text, at its first use. */
  operands: Record<string, unknown>;
}

/** A node's `${}` fields, keyed by path (`datasetParams.source.path`, `headers.x`). */
export type ExpressionTrace = Record<string, ExpressionRecord>;

/** A control activity's decision: the expression it evaluated and its result. */
export interface EvaluationRecord {
  /** The field the expression came from (`condition`, `on`, `value`, `exitWhen`). */
  field: string;
  expression: string;
  operands: Record<string, unknown>;
  result: unknown;
}

/** The trace as bounded JSON text, or `undefined` when no field held a `${}`. */
export function captureExpressions(
  trace: ExpressionTrace,
  maxChars: number,
): DispatchInput | undefined {
  return Object.keys(trace).length === 0 ? undefined : boundedJson(trace, maxChars);
}

/**
 * The evaluation record for one control field, from the trace its evaluation
 * wrote, or `undefined` when the field held no `${}` (a literal decides
 * nothing worth recording beyond the result the event already carries).
 */
export function evaluationOf(
  trace: ExpressionTrace,
  field: string,
  result: unknown,
): EvaluationRecord | undefined {
  const rec = trace[field];
  if (rec === undefined) return undefined;
  return { field, expression: rec.template, operands: rec.operands, result };
}

/** An evaluation record as bounded JSON text, the shape the events store. */
export function captureEvaluation(
  record: EvaluationRecord | undefined,
  maxChars: number,
): DispatchInput | undefined {
  return record === undefined ? undefined : boundedJson({ ...record }, maxChars);
}
