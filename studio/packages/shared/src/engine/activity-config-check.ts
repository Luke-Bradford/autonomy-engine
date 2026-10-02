/**
 * #1480 — the save-time half of each activity's dispatch-time config parse.
 *
 * Until this existed a version could save with a `type` no adapter knows, or a
 * config the adapter refuses (`copy` with `mode: 'truncate'`), and fail only
 * when a run dispatched it — inside a version that is IMMUTABLE, so it could be
 * re-authored but never repaired, and that triggers and Execute Pipeline could
 * already be bound to. A version that saves must be one the run will accept.
 *
 * ONE schema per activity: `ActivityCatalogEntry.dispatchConfigSchema` is the
 * same instance the adapter parses `ctx.input` with, so save and dispatch cannot
 * disagree about a literal. What they legitimately differ on is `${}`: dispatch
 * parses the SUBSTITUTED config, save sees the template. So an issue is dropped
 * when the expression could be what decides it:
 *
 *  - an issue AT or UNDER a value that holds any `${}` (whole-value or
 *    interpolated — an interpolated string is still a string, but an enum or a
 *    regex cannot judge text that is not written yet), or a `{$secret}` marker
 *    (resolved into a side channel, never into the input);
 *  - a REFINEMENT (`custom`) or union issue at a value whose subtree holds a
 *    WHOLE-value expression or a marker anywhere: a whole value keeps its native
 *    type and may resolve to anything, so a cross-field rule cannot be judged.
 *    An interpolated descendant does not drop it — presence and type survive
 *    interpolation, which is what those rules read.
 *
 * The boundary errs one way only: a dropped issue is a config dispatch may
 * still refuse, exactly as before this gate; it is never a refusal of a config
 * that would run. The `llm_call` refinements that matter at save are also
 * checked by `validateDoc`'s hand-written `validateLlmCall*` rules.
 *
 * A node carrying `Node.call` is skipped: the engine dispatches it structurally,
 * never through an adapter, and the engine suite uses the literal
 * `type: 'call_pipeline'`, which no catalog entry names.
 */
import type { z } from 'zod';
import type { Node } from '../schemas/pipeline.js';
import { isSecretRef } from '../schemas/secret-ref.js';
import type { ActivityCatalog } from '../catalog/types.js';
import { catalog as sharedCatalog } from '../catalog/registry.js';
import { interpolationMode } from './expr.js';

/** How many catalog types an unknown-type refusal offers. */
const CLOSEST_TYPES = 3;

type Opacity = 'any' | 'whole';

/** Whether `v` itself is a value dispatch sees resolved rather than as written. */
function opaque(v: unknown, depth: Opacity): boolean {
  if (isSecretRef(v)) return true;
  if (typeof v !== 'string') return false;
  const mode = interpolationMode(v).mode;
  return depth === 'any' ? mode !== 'literal' : mode === 'whole';
}

/** Whether anything in `v`'s subtree (itself included) is opaque at `depth`. */
function subtreeOpaque(v: unknown, depth: Opacity): boolean {
  if (opaque(v, depth)) return true;
  if (Array.isArray(v)) return v.some((x) => subtreeOpaque(x, depth));
  if (typeof v === 'object' && v !== null) {
    return Object.values(v).some((x) => subtreeOpaque(x, depth));
  }
  return false;
}

/** True when the issue could be an artefact of judging the template, not its value. */
function decidedByExpression(config: unknown, issue: z.core.$ZodIssue): boolean {
  let v: unknown = config;
  if (opaque(v, 'any')) return true;
  for (const key of issue.path) {
    if (typeof v !== 'object' || v === null) return false;
    v = (v as Record<PropertyKey, unknown>)[key];
    if (opaque(v, 'any')) return true;
  }
  return (issue.code === 'custom' || issue.code === 'invalid_union') && subtreeOpaque(v, 'whole');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

function closestTypes(type: string, known: ActivityCatalog): string[] {
  return [...known.keys()]
    .map((t) => ({ t, d: editDistance(type, t) }))
    .sort((x, y) => x.d - y.d || x.t.localeCompare(y.t))
    .slice(0, CLOSEST_TYPES)
    .map((x) => x.t);
}

/**
 * Every save-time refusal for one node's `type` and `config`, as `validateDoc`
 * diagnostics (`node '<id>': <field path>: <message>`). `catalog` is the one the
 * executor dispatches with — the shared catalog unless a caller injects its own.
 */
export function activityNodeErrors(node: Node, catalog: ActivityCatalog = sharedCatalog): string[] {
  if (node.call !== undefined) return [];
  const entry = catalog.get(node.type);
  if (entry === undefined) {
    const closest = closestTypes(node.type, catalog);
    const hint = closest.length > 0 ? ` (closest: ${closest.join(', ')})` : '';
    return [`node '${node.id}': type: unknown activity type '${node.type}'${hint}`];
  }
  const schema = entry.dispatchConfigSchema;
  if (schema === undefined) return [];
  const parsed = schema.safeParse(node.config);
  if (parsed.success) return [];
  return parsed.error.issues
    .filter((issue) => !decidedByExpression(node.config, issue))
    .map((issue) => {
      const path = ['config', ...issue.path.map(String)].join('.');
      return `node '${node.id}': ${path}: ${issue.message}`;
    });
}
