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
 *    interpolation, which is what those rules read. A rule that reads ONLY
 *    presence (`PRESENCE_ONLY_RULE`, #1491) is never dropped: no expression
 *    resolves to `undefined`, so none can change which keys are present.
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
import { isPresenceOnlyIssue } from '../schemas/zod-issues.js';
import type { ActivityCatalog } from '../catalog/types.js';
import { catalog as sharedCatalog } from '../catalog/registry.js';
import { interpolationMode } from './expr.js';
import { MAX_CONFIG_DEPTH } from './limits.js';

/** How many catalog types an unknown-type refusal offers. */
const CLOSEST_TYPES = 3;

/**
 * How much of an unknown `type` the closest-type hint compares. `Node.type` has
 * no length bound of its own, and the edit distance costs O(length) per catalog
 * entry: uncapped, one 1 MB type took ~0.5 s of CPU at save (measured).
 */
const CLOSEST_COMPARED_CHARS = 64;

type Opacity = 'any' | 'whole';

/** Whether `v` itself is a value dispatch sees resolved rather than as written. */
function opaque(v: unknown, depth: Opacity): boolean {
  if (isSecretRef(v)) return true;
  if (typeof v !== 'string') return false;
  const mode = interpolationMode(v).mode;
  return depth === 'any' ? mode !== 'literal' : mode === 'whole';
}

/**
 * Whether anything in `v`'s subtree (itself included) is opaque at `depth`.
 * Bounded at `MAX_CONFIG_DEPTH`, as every config walk in `validateDoc` is, so a
 * hostile nesting cannot overflow the stack. Past the bound nothing counts as
 * opaque, so the issue STANDS: an over-deep config is refused, never waved
 * through unchecked — and it could not run anyway, since dispatch-time
 * substitution refuses a config nested past the same bound.
 */
function subtreeOpaque(v: unknown, depth: Opacity, level = 0): boolean {
  if (level > MAX_CONFIG_DEPTH) return false;
  if (opaque(v, depth)) return true;
  if (typeof v !== 'object' || v === null) return false;
  return Object.values(v).some((x) => subtreeOpaque(x, depth, level + 1));
}

/**
 * The raw values from `config` down `path`, `config` first. Shorter than
 * `path.length + 1` when a step's parent is not an object (the path is absent).
 */
function valuesAlong(config: unknown, path: readonly PropertyKey[]): unknown[] {
  const values: unknown[] = [config];
  let v: unknown = config;
  for (const key of path) {
    if (typeof v !== 'object' || v === null) break;
    v = (v as Record<PropertyKey, unknown>)[key];
    values.push(v);
  }
  return values;
}

/** True when the issue could be an artefact of judging the template, not its value. */
function decidedByExpression(config: unknown, issue: z.core.$ZodIssue): boolean {
  if (isPresenceOnlyIssue(issue)) return false;
  const values = valuesAlong(config, issue.path);
  if (values.some((v) => opaque(v, 'any'))) return true;
  if (values.length <= issue.path.length) return false;
  const atPath = values[values.length - 1];
  return (
    (issue.code === 'custom' || issue.code === 'invalid_union') && subtreeOpaque(atPath, 'whole')
  );
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
  const compared = type.slice(0, CLOSEST_COMPARED_CHARS);
  return [...known.keys()]
    .map((t) => ({ t, d: editDistance(compared, t) }))
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
      // A field that is simply absent reads as Zod's "expected string, received
      // undefined"; the operator's next step is to fill it, so say that.
      const values = valuesAlong(node.config, issue.path);
      const missing = issue.code === 'invalid_type' && values[issue.path.length] === undefined;
      return `node '${node.id}': ${path}: ${missing ? 'required' : issue.message}`;
    });
}
