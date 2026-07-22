import type {
  Container,
  Edge,
  Node,
  Param,
  PipelineVersion,
  SubstitutionContext,
} from './types.js';
import { ParamResolveError, SubstituteError, TERMINAL_NODE } from './types.js';
import type { TriggerContext } from '../schemas/trigger-context.js';
import type { OutputContract } from './outputs.js';
import { containerOutputContract, outputContract } from './outputs.js';
import type { Expr, ExprSegment, TemplateMode } from './expr.js';
import { interpolationMode, parseExpr, restoreEscapes } from './expr.js';
import { getActivity } from '../catalog/registry.js';
import {
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  AGENT_TASK_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  IF_BRANCH_TRUE,
  IF_BRANCH_FALSE,
  LLM_CALL_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  SWITCH_DEFAULT_BRANCH,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
} from '../catalog/types.js';
import {
  llmOutputSchemaSchema,
  llmStructuredOutputSurfaceSchema,
  llmToolDefSchema,
  llmToolsSurfaceSchema,
  lowerOutputSchema,
} from '../catalog/llm-config.js';
import { SecretRefSchema, isSecretRef } from '../schemas/secret-ref.js';
import type { EvalIn, FnSpec, SigType } from './functions.js';
import {
  FUNCTIONS,
  MAX_ARRAY_ELEMENTS_TOTAL,
  MAX_PATH_DEPTH,
  argSigAt,
  arity,
  assignableTo,
  checkArgTypes,
  listFunctions,
  sigOfDeclared,
  toStr,
} from './functions.js';

// ---------------------------------------------------------------------------
// The `${...}` parameter language (ported from lib/pipeline.py's S3.1 resolver).
//
// The GRAMMAR (parser + AST) lives in `expr.ts`; this module is the EVALUATOR
// (`substitute`) + the static checker (`validateRefs`/`validateDoc`) built on
// it. Both read the one parser, so they can never disagree on what an
// expression means. There is NO `eval` and NO `new Function` anywhere:
// `${__import__(...)}` is simply an unknown function reference that RAISES.
//
// The security-critical property is INERTNESS — substitution scans a string
// ONCE and never rescans a replacement, so a resolved value that itself
// contains `${...}` is emitted literally (the no-injection guarantee). See
// `substitute`.
// ---------------------------------------------------------------------------

/**
 * Bounds how deep any walk may descend the node-`config` TREE (nested
 * objects/arrays) before it refuses. `config` is `z.record(z.string(),
 * z.unknown())` — opaque to Zod, so a stored/run-now config can nest
 * arbitrarily deep. Every recursor over the tree — `substitute` (RUN),
 * `scan` (the `${}` SAVE walk) and `walkConfigForMarkers`/`walkMarkerRegion`
 * (the `{$secret}` SAVE gate + DISPATCH resolver) — checks this cap at entry, so
 * a pathological config fails with a CLEAN error/throw instead of overflowing
 * the stack (`RangeError`). This is the config-TREE axis; it is ORTHOGONAL to
 * `MAX_EXPR_DEPTH` (expression AST nesting, `expr.ts`) and `MAX_PATH_DEPTH` (ref
 * path segments, `functions.ts`) — neither of those bounds the tree walk. It is
 * the SAME axis as server-side `MAX_REDACT_DEPTH` (`connectors/redact.ts`, which
 * caps the resolved-config redaction walk at 100); the two compose safely — a
 * config within this 64 cap is comfortably within redaction's 100 ceiling. The
 * config-tree analogue of #453, which bounded expression nesting for the same
 * class of raw-`RangeError` bug. 64 is reasoned by analogy to the sibling caps,
 * not a measured overflow point: a native stack blows in the low thousands of
 * frames (#453 measured ~2000 for the expression walk), and real config is a
 * handful of levels deep, so 64 is a wide safe band the cap only ever bites a
 * pathological input against.
 */
export const MAX_CONFIG_DEPTH = 64;

/**
 * Closed field set readable via `${run.<field>}`. SSOT — extend here only.
 *
 * Reconciled to spec #6's names at E3 (its spike-hardened "SSOT bug (must fix)"):
 * the run id is `runId`, not `id`, and `startedAt` now exists — before this the
 * spec's own dynamic-filename example (`file_${params.env}_${run.runId}.json`)
 * was REJECTED by the shipped resolver.
 *
 * `run.id` is RENAMED, not aliased. The set is documented as closed, so carrying
 * two spellings of one field would be precisely the drift this fixes; no doc,
 * fixture or seed used the old spelling.
 *
 * `pipelineVersionId`/`triggerId` are kept beyond the spec's line-50 table (which
 * lists `runId, startedAt, parentRunId?, attempt`): they already worked, and
 * removing a live field is a bigger break than documenting the deviation. The
 * spec is amended to match. `attempt` awaits #1 D4 (retry) — there is no attempt
 * fact to read until a retry can happen.
 */
export const RUN_FIELDS = [
  'runId',
  'startedAt',
  'pipelineVersionId',
  'triggerId',
  'parentRunId',
] as const;

/**
 * The CLOSED `${trigger.<field>}` field set (#5 S12). `triggerId`/`scheduledTime`
 * are strings (nullable at run time — a manual/child run carries neither, and a
 * null throws only under deep addressing, exactly as the nullable `run` fields
 * do). `body` is the fire payload, typed `json` so `${trigger.body.x}` deep-walks
 * as the runtime-validated escape hatch (E7) rather than a static shape.
 */
export const TRIGGER_FIELDS = ['triggerId', 'scheduledTime', 'body'] as const;

/**
 * The CONTEXT-SCOPED `${trigger.<field>}` extension (#5 S11b): a fired tumbling
 * window's bounds `[windowStart, windowEnd)` (ISO-8601 UTC strings). NOT in
 * `TRIGGER_FIELDS` because they are not globally readable — the spec scopes them
 * to "tumbling-window-bound pipelines", and the one save-time surface where that
 * binding is a KNOWN fact is the tumbling trigger's own param bindings (a
 * pipeline doc does not know its triggers at save; triggers reference pipelines,
 * are created later, and change mode). So — mirroring ADF, whose
 * `@trigger().outputs.windowStartTime` is usable only in the trigger's
 * parameter mapping — these fields are legal ONLY where `ScanScope.
 * windowFieldsInScope` is set: a tumbling trigger's param bindings
 * (`validateTriggerBindings` with `windowFields: true`). A node config or a
 * non-tumbling binding is refused at save with a message naming this rule,
 * never accepted-then-null on a manual/schedule run. At RUN time `triggerRoot`
 * carries them unconditionally (null when the fire had none) — the fail-soft
 * backstop for a pre-gate stored row, same as `scheduledTime` on a manual fire.
 */
export const TRIGGER_WINDOW_FIELDS = ['windowStart', 'windowEnd'] as const;

/**
 * A value that ISN'T THERE — a distinct error so `default()` (the one rescuing
 * function) can treat data absence as "use the fallback" while a typo'd param,
 * an out-of-scope `item` or a wrong SHAPE stays a hard error. Internal to this
 * module (`EvalIn.soft` hands the catalog a yes/no, never the class).
 *
 * RENAMED from `MissingNodeOutputError` at #6 E7: it now also covers a missing
 * key or an out-of-range index anywhere a deep path walks — including into a
 * `json` param or a bound `item`, neither of which is a node output — so the old
 * name would have lied about three of its four sites.
 *
 * The line this class draws is DATA ABSENCE vs DOC DEFECT, and it is what E3/E4
 * were actually reasoning about when they refused to route a status race or an
 * unbound `item` through it: `default()` must rescue a value the data legitimately
 * may not carry, and must NEVER mask a defect whose fix is to edit the doc.
 */
class MissingValueError extends SubstituteError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingValueError';
  }
}

// --- the closed pure-function allowlist --------------------------------------
//
// The catalog itself (one entry per fn, plus the eager/special calling
// convention and the per-fn type signatures) is `functions.ts` — #6 E4. This
// module is its only consumer: the evaluator below reads a spec's `call`/
// `lambdaArgs`, and the static checker reads `lambdaArgs`/`staticSoftArg`, so
// neither special-cases a function by NAME.

// --- reference shape (segments are the SSOT — `source` is never re-parsed) ---

/**
 * A ref's LEADING field names — the run of plain `.field` segments before the
 * first `[]` index, which is the region a namespace root can occupy.
 *
 * `segments` — not `source` — is the structural SSOT: a quoted index like
 * `m['b.c']` is ONE segment but TWO dot-parts, so splitting `source` on `.`
 * would disagree with the grammar on the doc's own meaning.
 */
function leadingFields(segments: ExprSegment[]): string[] {
  const names: string[] = [];
  for (const seg of segments) {
    if (seg.kind !== 'field') break;
    names.push(seg.name);
  }
  return names;
}

/**
 * What a reference NAMES, and how many leading segments say it (#6 E7).
 *
 * ONE answer to "where does the root end", read by all THREE consumers —
 * `resolveRef` (run), `checkExprStatic` (save) and `inferExprType` (E6). Before
 * E7 each re-derived it from its own `parts[0] === 'nodes' && parts.length === 4
 * && parts[2] === 'output'` predicate; E7 has to turn every one of those from
 * `=== N` into `>= N` (a root may now carry a deep TAIL), and three copies of one
 * new invariant is exactly the drift `typing.test.ts`'s "inference MUST agree
 * with checkExprStatic" test exists to catch.
 *
 * The root region is FIELDS ONLY: `leadingFields` stops at the first index, so
 * `${nodes[params.i].output.x}` matches nothing here and is refused outright. A
 * DYNAMIC output name would defeat the declared-name check (which is only
 * enforceable against a literal), and a dynamic namespace or node id is
 * meaningless. Consequence, recorded: an output name containing `.`/`[`/`]` stays
 * unaddressable — as it was before E7, since the grammar reserves those chars.
 */
type RefRoot =
  | { kind: 'item'; arity: 1 }
  | { kind: 'params'; name: string; arity: 2 }
  | { kind: 'nodeOutput'; id: string; name: string; arity: 4 }
  | { kind: 'nodeStatus'; id: string; arity: 3 }
  | { kind: 'run'; field: string; arity: 2 }
  | { kind: 'trigger'; field: string; arity: 2 }
  // #2 L10a — `${tool.args.<name>}`: a model-supplied tool-call argument, bound
  // ONLY while an llm_call tool expression evaluates (`evalToolExpression`).
  // Context-scoped like `${trigger.windowStart}` (S11b): save-time legality is
  // `scope.toolArgTypes` presence, run-time binding is `Env.toolArgs`.
  | { kind: 'tool'; name: string; arity: 3 };

function refRoot(fields: string[]): RefRoot | null {
  const [ns, a, b, c] = fields;
  if (ns === 'item') return { kind: 'item', arity: 1 };
  if (ns === 'params' && fields.length >= 2) return { kind: 'params', name: a as string, arity: 2 };
  if (ns === 'nodes' && fields.length >= 4 && b === 'output') {
    return { kind: 'nodeOutput', id: a as string, name: c as string, arity: 4 };
  }
  if (ns === 'nodes' && fields.length >= 3 && b === 'status') {
    return { kind: 'nodeStatus', id: a as string, arity: 3 };
  }
  if (ns === 'run' && fields.length >= 2) return { kind: 'run', field: a as string, arity: 2 };
  if (ns === 'trigger' && fields.length >= 2)
    return { kind: 'trigger', field: a as string, arity: 2 };
  // `${tool}` / `${tool.args}` (too short) fall through to `null` — an
  // unresolvable reference, matching every other under-specified root.
  if (ns === 'tool' && fields.length >= 3 && a === 'args') {
    return { kind: 'tool', name: b as string, arity: 3 };
  }
  return null;
}

/**
 * The path-length defect in a ref, or `null`. Both halves of the rule read this
 * (`resolveRef` throws it, `checkExprStatic` accumulates it), so save and run can
 * never disagree about which paths are too deep. See `MAX_PATH_DEPTH` for why the
 * cap is not decorative.
 */
function pathDepthDefect(expr: Extract<Expr, { kind: 'ref' }>): string | null {
  if (expr.segments.length <= MAX_PATH_DEPTH) return null;
  return (
    `\${${expr.source.slice(0, 40)}…}: reference path is too deep ` +
    `(${expr.segments.length} segments, max ${MAX_PATH_DEPTH})`
  );
}

// --- the evaluator ----------------------------------------------------------

/**
 * The evaluation scope: the run's facts (`ctx`) plus the LEXICAL binding of
 * `item` (#6 E4).
 *
 * `item` rides here rather than on `SubstitutionContext` because it is lexical,
 * not a run fact: it exists only inside a `filter`/`map`/`count` lambda arg, and
 * a nested array form must REBIND it for its own elements (spec #6 Round-2 M1:
 * "the nearest enclosing iteration binds it"). A child `Env` is created per
 * element, so the reducer's purity is untouched — nothing is mutated.
 *
 * The box (`{ value }`) distinguishes "bound to `undefined`" from "not bound".
 * When #4 A4 lands, a `foreach` body seeds this same field.
 */
interface Env {
  ctx: SubstitutionContext;
  item?: { value: unknown };
  /**
   * #2 L10a — the `${tool.args.*}` binding, present ONLY while a tool
   * expression evaluates (`evalToolExpression`). Lexical like `item`: it is not
   * a run fact, it exists only inside one tool call's evaluation. The validated
   * argument object (every declared parameter present — optionals as `null`,
   * per `validateStructuredOutput`'s present-null contract).
   */
  toolArgs?: Record<string, unknown>;
  /**
   * Elements materialised so far by THIS field's evaluation. Shared by every
   * child Env (the object is passed by reference, deliberately), so nesting
   * cannot escape it — see `charge`.
   */
  budget: { spent: number };
}

/**
 * A fresh evaluation scope for one field. `item` seeds the `${item}` binding for
 * a #4 A4 `foreach` body — lexical, so it rides on `Env` (not `SubstitutionContext`,
 * per the settled decision at the `RefRoot`/`item` note above). A nested
 * `filter`/`map`/`count` lambda still rebinds `item` in its own child `Env`, so
 * the NEAREST enclosing iteration binds it.
 */
function newEnv(ctx: SubstitutionContext, item?: { value: unknown }): Env {
  return item !== undefined ? { ctx, item, budget: { spent: 0 } } : { ctx, budget: { spent: 0 } };
}

/**
 * Charge an array flowing through the evaluation against the per-field budget.
 *
 * The per-array cap bounds ONE array; this bounds the whole field. Without it
 * `${length(map(range(0,10000), range(0,10000)))}` allocates 10^8 elements while
 * every individual array sits exactly AT the cap — the per-array check cannot
 * see the product. Called from `evalExpr`, the one node every value passes
 * through, so no fn can forget it and a fn added later inherits the bound free.
 */
function charge(env: Env, out: unknown): void {
  if (!Array.isArray(out)) return;
  env.budget.spent += out.length;
  if (env.budget.spent > MAX_ARRAY_ELEMENTS_TOTAL) {
    throw new SubstituteError(
      `expression materialises too many array elements ` +
        `(over ${MAX_ARRAY_ELEMENTS_TOTAL} in one field)`,
    );
  }
}

/**
 * Resolve a reference: its ROOT (a run fact or the lexical `item`), then the
 * deep `[]`/`.` TAIL over that value (#6 E7).
 */
function resolveRef(expr: Extract<Expr, { kind: 'ref' }>, env: Env): unknown {
  const root = refRoot(leadingFields(expr.segments));
  if (root === null) throw new SubstituteError(`unresolvable reference \${${expr.source}}`);
  const tooDeep = pathDepthDefect(expr);
  if (tooDeep !== null) throw new SubstituteError(tooDeep);
  const value = resolveRoot(expr, root, env);
  return walkPath(value, expr.segments.slice(root.arity), env, expr.source);
}

/** The root value a reference names, before any deep addressing. */
function resolveRoot(expr: Extract<Expr, { kind: 'ref' }>, root: RefRoot, env: Env): unknown {
  const ctx = env.ctx;
  switch (root.kind) {
    // `${item}` / `${item.<path>}` (#6 E4) — bound ONLY inside a lambda arg.
    //
    // A bare `${item}` (no path) is the element itself: `filter(params.nums,
    // greater(item, 5))` over a scalar array is the spec's own v1 shape.
    //
    // Unbound is a plain `SubstituteError`, never `MissingValueError`:
    // `default()` catches the latter, so routing an out-of-scope `item` through
    // it would let `${default(item.x, 'fb')}` silently return the fallback for
    // what is really a scope error. Same reasoning as E3's status refusal.
    case 'item': {
      if (env.item === undefined) {
        throw new SubstituteError(
          `\${${expr.source}}: 'item' is only bound inside a filter/map/count ` +
            'predicate or a foreach body — it has no value here',
        );
      }
      return env.item.value;
    }
    case 'params': {
      if (!Object.prototype.hasOwnProperty.call(ctx.params, root.name)) {
        throw new SubstituteError(`unknown param reference \${params.${root.name}}`);
      }
      return ctx.params[root.name];
    }
    case 'nodeOutput': {
      const outs = ctx.nodeOutputs[root.id];
      if (outs === undefined || !Object.prototype.hasOwnProperty.call(outs, root.name)) {
        throw new MissingValueError(`unknown node output \${nodes.${root.id}.output.${root.name}}`);
      }
      return outs[root.name];
    }
    // `${nodes.<id>.status}` (#6 E3 T6) — the ADF `@activity().Status` fan-in/OR
    // handle. Its vocabulary is the TERMINAL set only.
    //
    // Both refusals below are plain `SubstituteError`s, NEVER `MissingValueError`:
    // `default()` catches that one, so routing through it would let
    // `${default(nodes.a.status, 'none')}` silently return "none" for a real
    // dispatch race or a typo'd node id — reporting a verdict the run never
    // reached. A status either IS settled or the expression is wrong.
    case 'nodeStatus': {
      const status = ctx.nodeStatuses[root.id];
      if (status === undefined) {
        throw new SubstituteError(`\${nodes.${root.id}.status}: no node '${root.id}' in this run`);
      }
      if (!TERMINAL_NODE.has(status)) {
        throw new SubstituteError(
          `\${nodes.${root.id}.status}: node '${root.id}' has not settled here — a status is ` +
            `readable only once it is success/failure/skipped`,
        );
      }
      return status;
    }
    case 'run': {
      if (!Object.prototype.hasOwnProperty.call(ctx.run, root.field)) {
        throw new SubstituteError(`unknown run field \${run.${root.field}}`);
      }
      return ctx.run[root.field];
    }
    // `${trigger.<field>}` (#5 S12) — the fire-time trigger context. `buildCtx`
    // always populates every TRIGGER_FIELDS name (null where the fire carried
    // none), so a plain `SubstituteError` here means the AUTHOR named a field
    // that does not exist — never a data-absence `default()` should rescue.
    case 'trigger': {
      if (!Object.prototype.hasOwnProperty.call(ctx.trigger, root.field)) {
        throw new SubstituteError(`unknown trigger field \${trigger.${root.field}}`);
      }
      return ctx.trigger[root.field];
    }
    // `${tool.args.<name>}` (#2 L10a) — bound only inside `evalToolExpression`.
    // Both refusals are plain `SubstituteError`s, never `MissingValueError`:
    // an unbound `tool` is a scope error and an undeclared name is a doc error
    // (save-time scoping enforces both) — `default()` must not rescue either.
    case 'tool': {
      if (env.toolArgs === undefined) {
        throw new SubstituteError(
          `\${${expr.source}}: 'tool' is only bound inside an llm_call tool expression — ` +
            'it has no value here',
        );
      }
      if (!Object.prototype.hasOwnProperty.call(env.toolArgs, root.name)) {
        throw new SubstituteError(
          `\${tool.args.${root.name}}: this tool declares no parameter named '${root.name}'`,
        );
      }
      return env.toolArgs[root.name];
    }
  }
}

// --- the deep walk (#6 E7) — the runtime-validated escape hatch --------------
//
// Spec #6 L48/L111: deep `[]`/`.` into a `json`/`any` value is `any` — there is
// no static type to check it against (E4: `SigType` has no element type), so the
// walk IS the validation. ONE walk serves every root, so `item` (whose bespoke
// `.`-only walk E4 shipped) and a node output cannot drift.
//
// The walk is INERT: it SELECTS a sub-value of an already-resolved value and
// never re-parses it, so a deep-resolved `"${secret}"` is still emitted
// literally. It is also READ-ONLY — it never assigns — so there is no
// prototype-pollution vector.
//
// The error CLASS carries the rule (see `MissingValueError`):
//   MISSING (rescuable by `default()`) — an absent own property, an out-of-range
//     index, or a step onto null/undefined: the data legitimately varies, and on
//     an untyped path `default()` is the author's ONLY tool.
//   SHAPE (plain, never rescued) — a field on a scalar or an array, an index into
//     a scalar, or a nonsense index: the DOC is wrong, and masking that would
//     hide a defect whose fix is to edit the doc.

/** Walk `tail` over `start`. `tail` is `[]` for an ordinary (non-deep) ref. */
function walkPath(start: unknown, tail: ExprSegment[], env: Env, source: string): unknown {
  let cur = start;
  for (const seg of tail) {
    cur =
      seg.kind === 'field'
        ? stepField(cur, seg.name, source)
        : stepIndex(cur, evalExpr(seg.expr, env), source);
  }
  return cur;
}

/**
 * `.field` — an own property of a plain object.
 *
 * `hasOwnProperty`, NEVER `in`: `in` walks the PROTOTYPE CHAIN, so
 * `${x.constructor}` would hand back a real host function as resolved node
 * config, escaping the data model and defeating `toStr`'s string contract.
 *
 * The `typeof` and array guards are LOAD-BEARING, not defensive tidying — a
 * primitive BOXES, so `hasOwnProperty` alone says yes to host surface:
 *   - `hasOwnProperty('abc', 'length')` is TRUE (and `('abc')[0]` is 'a'), so
 *     without the `typeof` guard `${run.runId[0]}` resolves to 'r' and
 *     `${nodes.a.output.text.length}` to a number;
 *   - `hasOwnProperty([], 'length')` is TRUE, so without the array guard
 *     `${nodes.a.output.rows.length}` becomes an accidental alias for the
 *     catalog's `length()`.
 * A field NEVER applies to an array: `[]` is the one way to index one. This
 * narrows two accidental capabilities of E4's item walk (`${item.length}` and
 * `${item.0}`, neither designed, tested nor documented) — `[]`, which E7 adds, is
 * the designed form for both.
 */
function stepField(cur: unknown, name: string, source: string): unknown {
  if (cur === null || cur === undefined) {
    throw new MissingValueError(
      `\${${source}}: has no field '${name}' — the value before it is ${
        cur === null ? 'null' : 'absent'
      }`,
    );
  }
  if (Array.isArray(cur)) {
    throw new SubstituteError(
      `\${${source}}: cannot read field '${name}' on an array — index it with ` +
        `[] (or use length()/first()/last())`,
    );
  }
  if (typeof cur !== 'object') {
    throw new SubstituteError(
      `\${${source}}: cannot read field '${name}' — the value before it is a ` +
        `${typeof cur}, not an object`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(cur, name)) {
    throw new MissingValueError(`\${${source}}: has no field '${name}'`);
  }
  return (cur as Record<string, unknown>)[name];
}

/**
 * `[expr]` — an array index, or a dynamic/quoted object key (spec #6 L40-41).
 *
 * A null/undefined INDEX is refused rather than coerced: `toStr(null)` is `''`,
 * and a nullable field like `run.triggerId` is `null` on any run WITHOUT a
 * trigger (a child call_pipeline run, or a pre-S12 log), so
 * `${params.cfg[run.triggerId]}` would silently look up the own property `''`.
 * A null is never a key.
 */
function stepIndex(cur: unknown, idx: unknown, source: string): unknown {
  if (cur === null || cur === undefined) {
    throw new MissingValueError(
      `\${${source}}: cannot index — the value before it is ${cur === null ? 'null' : 'absent'}`,
    );
  }
  if (typeof idx !== 'number' && typeof idx !== 'string') {
    throw new SubstituteError(
      `\${${source}}: an index must be a number or a string, got ${
        idx === null ? 'null' : Array.isArray(idx) ? 'array' : typeof idx
      }`,
    );
  }
  // A non-finite number is refused for EVERY container shape, before the
  // array/object split — `String(Infinity)` is `'Infinity'`, so the object branch
  // would otherwise silently look up an own property spelled `Infinity`, which is
  // the same silent-wrong-key hazard the null refusal above exists to stop. It is
  // REACHABLE, not theoretical: `1e999` is valid JSON, so a `json` param or an
  // HTTP body carries `Infinity` straight through `JSON.parse` (E6 made `number`
  // mean FINITE at every other boundary for exactly this reason).
  if (typeof idx === 'number' && !Number.isFinite(idx)) {
    throw new SubstituteError(
      `\${${source}}: an index must be a finite number, got ${Number.isNaN(idx) ? 'NaN' : String(idx)}`,
    );
  }
  if (Array.isArray(cur)) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
      // `String`, not `JSON.stringify`: the latter renders a non-finite number as
      // `null`, so an Infinity index would report the baffling "got null".
      const got = typeof idx === 'string' ? `'${idx}'` : String(idx);
      throw new SubstituteError(
        `\${${source}}: an array index must be a non-negative whole number, got ${got}`,
      );
    }
    // Out of range is ABSENCE, not a doc defect — `default()` rescues it.
    if (idx >= cur.length) {
      throw new MissingValueError(
        `\${${source}}: index ${idx} is past the end of a ${cur.length}-element array`,
      );
    }
    return cur[idx];
  }
  if (typeof cur !== 'object') {
    throw new SubstituteError(
      `\${${source}}: cannot index into a ${typeof cur} — only an array or an object`,
    );
  }
  // A JSON object's keys are strings, so a number index addresses `{"0": …}`.
  // `String`, not `toStr`: `idx` is a string or a FINITE number by the guards
  // above, and `toStr` would coerce null/undefined to `''` — the silent-wrong-key
  // hazard those guards exist to refuse.
  const key = typeof idx === 'number' ? String(idx) : idx;
  if (!Object.prototype.hasOwnProperty.call(cur, key)) {
    throw new MissingValueError(`\${${source}}: has no field '${key}'`);
  }
  return (cur as Record<string, unknown>)[key];
}

/**
 * Evaluate one expression node and CHARGE its result against the budget.
 *
 * Charging wraps EVERY node — not just a call that returns an array — because
 * consuming an array is as much work as producing one: `sum(params.big)` scans
 * 10k elements and returns a scalar, so charging only array-shaped RESULTS of
 * CALLS would let `add(sum(a), add(sum(b), …))`, or a re-resolved array inside a
 * lambda (`count(a, contains(b, item))`, which resolves `b` once PER ELEMENT),
 * do the work the budget claims to bound while spending nothing. Charging at the
 * one node every value passes through keeps the bound honest: an array is
 * charged each time it is resolved OR produced.
 */
function evalExpr(expr: Expr, env: Env): unknown {
  const out = evalExprInner(expr, env);
  charge(env, out);
  return out;
}

function evalExprInner(expr: Expr, env: Env): unknown {
  switch (expr.kind) {
    case 'str':
    case 'num':
    case 'bool':
      return expr.value;
    case 'ref':
      return resolveRef(expr, env);
    case 'call': {
      const spec = FUNCTIONS[expr.name];
      if (spec === undefined) {
        throw new SubstituteError(`unknown function '${expr.name}' (allowed: ${allowedFnNames()})`);
      }
      checkArity(expr.name, spec, expr.args.length);
      try {
        return spec.call === 'special'
          ? spec.run(expr.args, evalIn(env))
          : callEager(expr.name, spec, expr.args, env);
      } catch (err) {
        if (err instanceof SubstituteError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new SubstituteError(`function '${expr.name}' failed: ${msg}`);
      }
    }
  }
}

/** Resolve every arg, type-check against the signature, then apply. */
function callEager(
  name: string,
  spec: Extract<FnSpec, { call: 'eager' }>,
  args: Expr[],
  env: Env,
): unknown {
  const values = args.map((a) => evalExpr(a, env));
  checkArgTypes(name, spec, values);
  return spec.impl(values);
}

/**
 * The evaluator handed to a `special` fn. `soft` keeps the try/catch — and so
 * `MissingValueError` itself — PRIVATE to this module: the catalog gets a
 * yes/no answer instead of an error class, so `functions.ts` never imports back.
 */
function evalIn(env: Env): EvalIn {
  return {
    eval: (e) => evalExpr(e, env),
    soft: (e) => {
      try {
        return { ok: true, value: evalExpr(e, env) };
      } catch (err) {
        if (err instanceof MissingValueError) return { ok: false };
        throw err;
      }
    },
    // A fresh child Env per element: `item` is rebound, never mutated, so a
    // nested array form shadows its parent and nothing leaks to a sibling arg.
    withItem: (e, item) => evalExpr(e, { ...env, item: { value: item } }),
  };
}

function allowedFnNames(): string {
  return listFunctions().join(', ');
}

function checkArity(name: string, spec: FnSpec, got: number): void {
  const { min, max } = arity(spec);
  if (got < min || (max !== null && got > max)) {
    throw new SubstituteError(
      `function '${name}' arity: expected ${arityText(min, max)}, got ${got}`,
    );
  }
}

function arityText(min: number, max: number | null): string {
  if (max === null) return `${min}+`;
  return max === min ? `${min}` : `${min}-${max}`;
}

// --- substitute (the security-critical inert single pass) -------------------

/**
 * Resolve every `${...}` in `value`. INERT SINGLE PASS: a string is scanned
 * once and each `${...}` is replaced with its resolved value; a replacement is
 * NEVER rescanned, so a resolved value containing `${...}` is emitted literally
 * (the no-injection guarantee). `$${` emits a literal `${`. An unterminated /
 * malformed `${` THROWS (never a silent literal).
 *
 * Type preservation: a WHOLE-string ref (`"${params.count}"`) keeps the native
 * type (number/bool/object/array); an EMBEDDED ref (`"n=${x}"`) coerces to
 * string. Arrays/objects recurse deterministically (object keys sorted). A
 * non-string scalar passes through untouched.
 */
export function substitute(
  value: unknown,
  ctx: SubstitutionContext,
  depth = 0,
  // The `${item}` binding for a #4 A4 `foreach` body, threaded UNCHANGED through
  // every recursion so a nested config value (`{a: {b: "${item}"}}`) sees the same
  // element as a top-level one. Undefined everywhere except a foreach child's
  // dispatch → `${item}` throws "only bound inside …" (the pre-A4 behaviour).
  item?: { value: unknown },
): unknown {
  // Bound the config-TREE recursion so a pathologically nested config raises a
  // clean `SubstituteError` a node-failure catch handles, never a raw stack
  // overflow (the RUN half of #537; the SAVE half is `scan`/`scanSecretSinks`).
  if (depth > MAX_CONFIG_DEPTH) {
    throw new SubstituteError(`config nested too deep (over ${MAX_CONFIG_DEPTH} levels)`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, ctx, depth + 1, item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = substitute((value as Record<string, unknown>)[key], ctx, depth + 1, item);
    }
    return out;
  }
  if (typeof value !== 'string') return value;

  // Classify via the shared SSOT (#6 E2), so the evaluator and the static
  // checkers can never disagree on a field's mode. An unterminated opener (no
  // matching top-level `}`) is a typo — RAISE (never leave it a silent literal).
  // The classifier only REPORTS it; raising is this caller's policy.
  const mode = interpolationMode(value);
  if (mode.unterminatedAt !== null) {
    throw new SubstituteError(
      `unterminated \${...} reference in ${JSON.stringify(value)} ` +
        '(write $${ for a literal ${)',
    );
  }

  // Deliberately NOT trimmed: mode is decided on the field AS WRITTEN. The
  // canonical trim of spec #6 Round-2 I1 belongs to whole-value-REQUIRED fields
  // only (`validateWholeValue` / `evalExitWhen`) — trimming here would silently
  // re-type `"${x}\n"`, a normal template, and eat the newline.
  if (mode.mode === 'literal') return restoreEscapes(mode.scanned);

  // ONE Env — and so ONE element budget — for the whole field: a field with
  // several embedded refs must not get a fresh allowance per `${}`.
  const env = newEnv(ctx, item);

  if (mode.mode === 'whole') {
    // Whole-value → preserve the resolved value's native type.
    const out = evalExpr(parseExpr(mode.body), env);
    return typeof out === 'string' ? restoreEscapes(out) : out;
  }

  // Embedded ref(s) → coerce each to string. Walking the SCANNED (protected)
  // string once and splicing in each match's resolved value keeps this pass
  // inherently inert — a resolved value is never itself rescanned. The offsets
  // index `mode.scanned`, never `value`.
  let result = '';
  let cursor = 0;
  for (const m of mode.matches) {
    result += mode.scanned.slice(cursor, m.start);
    result += toStr(evalExpr(parseExpr(m.body), env));
    cursor = m.end + 1;
  }
  result += mode.scanned.slice(cursor);
  return restoreEscapes(result);
}

// --- whole-value-REQUIRED fields (#6 E2) ------------------------------------
//
// A field where an embedded expression is not a choice but a BUG: the result can
// only ever be a STRING, so a boolean condition is never boolean-true. Spec #6's
// list: `exitWhen` (live today), `if.condition` / `foreach.items` / `switch` case
// selectors / `filter` predicates (#4).
//
// The rule needs BOTH halves — save-time (`validateWholeValue`: the canvas
// badge, and the write path, which refuses such a doc as of #444) and run-time
// (`wholeValueDefect`, binding: the reducer, since rows written before that gate
// never passed through save-time validation). Both read `defectOf` so the two
// halves can never word or judge the rule differently.

/**
 * The MODE defect in a whole-value-required field, or `null` if it is a proper
 * whole-value `${expr}`.
 *
 * `null` ALSO for an unterminated `${`: that is a GRAMMAR defect, and the grammar
 * scan already reports it precisely (`scan` at save time, `substitute` at run
 * time). Owning it here too would double-report it at save and mislabel it as a
 * mode defect at run time.
 *
 * `noun` names the field in the diagnostic (`exitWhen`, `condition`, `items`).
 */
function defectOf(mode: TemplateMode, noun: string): string | null {
  if (mode.unterminatedAt !== null) return null; // grammar's to report, not ours
  if (mode.mode === 'literal') return `${noun} must be a \${...} expression`;
  if (mode.mode === 'interpolated') {
    return (
      `${noun} must be a whole-value \${...} expression — text around the braces ` +
      'makes it an interpolated STRING, so a boolean result silently becomes ' +
      '"true"/"false" and never compares equal to a boolean'
    );
  }
  return null;
}

/**
 * The whole-value defect in `value`, or `null` if it is well-formed (or carries
 * an unterminated `${`, which the grammar reports). For the RUN-TIME half of the
 * rule, which throws rather than accumulating — see `reduce.ts` `evalExitWhen`.
 *
 * This is where spec #6 Round-2 I1's canonical trim lives: mode is decided AFTER
 * trimming, so a stray space or newline cannot demote a boolean to the string
 * `"true"`. Deliberately SCOPED here rather than applied inside `substitute`:
 * trimming every field would silently re-type `"${x}\n"` — an ordinary template
 * — and eat the newline.
 *
 * RAIL: only ever call this on DOC TEXT, never on a `substitute` result —
 * pointing it at a resolved value would re-read data as template and break the
 * no-injection guarantee.
 */
export function wholeValueDefect(value: string, noun: string): string | null {
  return defectOf(interpolationMode(value.trim()), noun);
}

/**
 * SAVE-TIME half: report a whole-value-required defect into `errors`. Returns the
 * classified `whole` result (so the caller reads `body` without rescanning), or
 * `null` if the field was not a clean whole-value expression.
 *
 * NB the returned `scanned`/match offsets index the TRIMMED text, not `value` —
 * this classifies `value.trim()`. Read `body`; do not splice these offsets
 * against the original field.
 *
 * PRECONDITION: callers must also `scan` the field for grammar/ref errors — this
 * checks MODE only, and stays silent on an unterminated `${` so it is reported
 * exactly once (by `scan`).
 */
export function validateWholeValue(
  where: string,
  value: string,
  errors: string[],
  noun: string,
): Extract<TemplateMode, { mode: 'whole' }> | null {
  const mode = interpolationMode(value.trim());
  const defect = defectOf(mode, noun);
  if (defect !== null) {
    errors.push(`${where}: ${defect}`);
    return null;
  }
  return mode.mode === 'whole' ? mode : null; // non-whole + no defect = unterminated
}

/**
 * #2 L10a — evaluate an llm_call TOOL EXPRESSION against the model-supplied,
 * schema-validated call arguments. The RUN-TIME half of the tool contract; the
 * save-time half is `scanLlmToolRefs` (whole-value + `${tool.args.*}`-only,
 * declared-name checked).
 *
 * The env binds ONLY `toolArgs` — `ctx` is EMPTY by construction, so a
 * run-state ref that slipped past save (`${params.x}`, `${run.runId}`, …)
 * throws its ordinary unknown-reference error rather than resolving. That is
 * what makes a v1 tool PURE + read-only (T11): the closed function catalog has
 * no side effects, and the env carries no run state, no I/O, no secrets.
 * `${item}` still binds inside a `filter`/`map`/`count` lambda over a tool-args
 * array (the `withItem` child-env spread carries `toolArgs` through).
 *
 * Whole-value REQUIRED, re-checked here (mirroring `filterFieldBody`): rows
 * written before the save gate existed never passed through it, and an
 * interpolated expression would coerce a non-string result to a string. Throws
 * `SubstituteError` on any defect; the caller (`executeLocalTool`, server)
 * turns it into an error tool_result for the model, never a node failure.
 */
export function evalToolExpression(expression: string, args: Record<string, unknown>): unknown {
  const defect = wholeValueDefect(expression, 'tool expression');
  if (defect !== null) throw new SubstituteError(defect);
  const mode = interpolationMode(expression.trim());
  // No defect yet NOT `whole` = an unterminated `${` (`defectOf` stays silent
  // on it at this layer). Fail LOUD rather than evaluate a broken body.
  if (mode.mode !== 'whole') {
    throw new SubstituteError('tool expression has an unterminated ${...} reference');
  }
  const env: Env = {
    ctx: { params: {}, nodeOutputs: {}, nodeStatuses: {}, run: {}, trigger: {} },
    toolArgs: args,
    budget: { spent: 0 },
  };
  return evalExpr(parseExpr(mode.body), env);
}

/**
 * #4 A8 — the composed `${filter(items, predicate)}` expression a `filter` control
 * node evaluates. A `filter` carries TWO whole-value `${}` config fields; their
 * bodies splice as the two arguments of the inert expression language's EXISTING
 * `filter(array, predicate)` closed-fn. This is the SINGLE SSOT for both halves:
 *  - RUN (`reduce.ts` `evalFilter`) passes the result to `substitute`, so the
 *    predicate re-evaluates per element with `${item}` bound (the fn's `withItem`),
 *    the array-element budget is charged ONCE (one `${}`/one `Env`), order is
 *    `Array.prototype.filter`'s, a non-array `items` / non-boolean predicate throw
 *    `SubstituteError` → `invalid_event`;
 *  - SAVE (`validateRefs`) scans this SAME string, so `checkExprStatic` gives the
 *    predicate (a `filter` `lambdaArg`) `${item}` scope while `items` (arg0) keeps
 *    only the outer/foreach scope — the field-aware `${item}` rule for free.
 *
 * Throws `SubstituteError` if either field is missing, non-string, empty, or not a
 * WHOLE-value `${}` (an embedded template like `"a${x}"` would splice as garbage).
 * On the SAVE path the SAME defects are reported first, with a per-field message,
 * by `validateFilterConfig` — this thrower is the run-time half (mirrors the
 * `wholeValueDefect` vs `validateWholeValue` split).
 *
 * RAIL: each body is one balanced whole-value expression. A body CAN contain a
 * top-level `,` (e.g. `${a, b}`), but that only splices a THIRD arg into the
 * fixed-arity (`minArgs:2`, non-variadic) `filter` call, which then fails LOUD at
 * both save (`checkArity`) and run — never a silent mis-parse. Never call on
 * resolved data (that would re-read output as template, breaking no-injection).
 */
export function composeFilterExpr(config: Record<string, unknown>): string {
  const items = filterFieldBody(config['items'], 'items');
  const predicate = filterFieldBody(config['predicate'], 'predicate');
  return `\${filter(${items}, ${predicate})}`;
}

/** Extract a filter field's whole-value `${}` body, or throw (run-time policy). */
function filterFieldBody(value: unknown, noun: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SubstituteError(
      `filter node has no '${noun}' — a filter needs a non-empty \${} ${noun} expression`,
    );
  }
  // Reuse the whole-value SSOT (`wholeValueDefect`), exactly as `evalIfBranch`
  // does — one "not whole-value" message shared across the control activities.
  const defect = wholeValueDefect(value, noun);
  if (defect !== null) throw new SubstituteError(defect);
  const mode = interpolationMode(value.trim());
  // No defect yet NOT `whole` = an unterminated `${` (`defectOf` stays silent on
  // it, leaving the grammar to the save-time scan — `scanFilterRefs`'s fallback).
  // Fail LOUD at run rather than splice a broken body.
  if (mode.mode !== 'whole') {
    throw new SubstituteError(`filter '${noun}' has an unterminated \${...} reference`);
  }
  return mode.body;
}

// --- resolveRunParams -------------------------------------------------------

/**
 * Resolve a run's params at run start (PURE): precedence is pipeline default <
 * caller override; each value is coerced to its declared `Param` type. A
 * required-unset param or a type mismatch THROWS `ParamResolveError`. An
 * override for an undeclared param THROWS.
 *
 * SECURITY: a SECRET-typed param is validated (required/label charset) but its
 * value is STRIPPED — it never enters the returned map, so it can never reach a
 * `SubstitutionContext.params`. Secret resolution is the executor's job (P3),
 * at the env sink, just-in-time — never through the `${}` language.
 */
export function resolveRunParams(
  doc: Pick<PipelineVersion, 'params'>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  // LAST-WINS on duplicate names, deliberately left tolerant here: the WRITE
  // gate (`NewPipelineVersionSchema`, #458) refuses duplicate param names, so a
  // fresh doc can't reach this map with a collision. A pre-gate STORED row still
  // can (the read schema stays tolerant to keep it repairable), and last-wins is
  // the defined behaviour for those — not a silent bug to re-detect here.
  const byName = new Map<string, Param>();
  for (const p of doc.params) byName.set(p.name, p);

  for (const key of Object.keys(overrides)) {
    if (!byName.has(key)) {
      throw new ParamResolveError(`override for undeclared param '${key}'`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, p] of byName) {
    let value: unknown;
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      value = overrides[name];
    } else if (Object.prototype.hasOwnProperty.call(p, 'default')) {
      value = p.default;
    } else if (p.required) {
      throw new ParamResolveError(`required param '${name}' has no value`);
    } else {
      continue; // optional, unset → absent
    }

    if (p.type === 'secret') {
      // NEVER echo the value: a misconfigured caller may have pasted a real
      // credential where a secret's LABEL belongs. Validate shape, then strip.
      if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
        throw new ParamResolveError(
          `param '${name}': a secret's value must be a credential label ` +
            '(charset [A-Za-z0-9._-]{1,64}); it never enters substitution',
        );
      }
      continue; // stripped — never enters the substitution context
    }

    out[name] = coerce(name, p.type, value);
  }
  return out;
}

function coerce(name: string, type: Param['type'], value: unknown): unknown {
  switch (type) {
    case 'number': {
      // Deliberately independent of `expr.ts`'s number-LITERAL grammar, which
      // this currently happens to match: that governs what an author may write
      // inside `${}`, this governs what an inbound param VALUE may be coerced
      // from. The two are free to diverge — don't merge them into one constant.
      //
      // FINITE, not merely `!isNaN` (#6 E6): `number` means finite everywhere
      // else in this engine (`matchesSig` has always enforced it on every fn
      // arg), and E6 types `${params.n}` from this very declaration. Accepting
      // `Infinity` here seeded a declared-`number` param that then FAILED its own
      // arg check at run — and it is reachable over HTTP, because `1e400` is
      // valid JSON and `JSON.parse` yields `Infinity`.
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        // The regex has no exponent, but 310 digits overflow anyway — so the
        // finite check belongs on the RESULT, not on the shape of the input.
        const n = Number(value.trim());
        if (Number.isFinite(n)) return n;
      }
      throw new ParamResolveError(`param '${name}': expected a finite number`);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new ParamResolveError(`param '${name}': expected boolean`);
    }
    case 'string': {
      if (typeof value === 'string') return value;
      throw new ParamResolveError(`param '${name}': expected string`);
    }
    case 'json':
      // A `json` param accepts any already-parsed structured value as-is.
      return value;
    case 'secret':
      // Handled (and stripped) by the caller; never reaches here.
      throw new ParamResolveError(`param '${name}': secret must not be coerced`);
  }
}

// --- JSON-replay safety (#547) ----------------------------------------------

/**
 * The studio run model is EVENT-SOURCED: `run.params` and (once S8 feeds it)
 * `${trigger.body}` land in the `run.started` / `run.triggerContext` events,
 * which are `JSON.stringify`-ed to persist and replayed to rebuild `RunState`.
 * `JSON.stringify` renders every non-finite number (`Infinity` / `-Infinity` /
 * `NaN`) as `null`, so a non-finite value that enters a durable, replayed
 * structure SILENTLY changes value on append→replay — a fidelity break
 * indistinguishable from an authored `null`. And a non-finite is reachable over
 * HTTP: `1e999` is valid JSON and `JSON.parse('{"x":1e999}')` yields
 * `{x: Infinity}`.
 *
 * So every param INGESTION boundary refuses a non-finite number at entry
 * (validate at system boundaries; never silently manufacture a lossy fact — the
 * same posture as `coerce`'s finite-`number` check above, and F13a's fail-open
 * contract). This is the ONE shared check every boundary reuses:
 * `jsonReplaySafetyErrors` collects one path-labelled error per offending number
 * (for the write schemas, which surface them as Zod issues → 400);
 * `assertJsonReplaySafe` throws the first as a `SubstituteError` (for the
 * fire-time resolution backstop, which every fire caller already maps:
 * manual→400, schedule/webhook→skip-and-log).
 *
 * ONLY numbers are inspected — a string (a `${}` expression or a literal),
 * boolean, `null`, or nested container is walked but never rejected on its own
 * account. `-0` and any finite magnitude (e.g. `1e308`) pass; only `NaN` and
 * `±Infinity` are refused. The tree walk is bounded by `MAX_CONFIG_DEPTH` (the
 * same axis the config walkers use), so a pathologically nested value is
 * reported, never a raw `RangeError`. The message is PATH-ONLY and never echoes
 * the numeric value: the manual fire route surfaces a resolved binding's message
 * in a client-facing 400 (`routes/triggers.ts`), whose contract is to never echo
 * a resolved value.
 */
export function jsonReplaySafetyErrors(where: string, value: unknown): string[] {
  const errors: string[] = [];
  walkReplaySafe(where, value, 0, errors);
  return errors;
}

function walkReplaySafe(where: string, value: unknown, depth: number, errors: string[]): void {
  if (depth > MAX_CONFIG_DEPTH) {
    errors.push(`${where}: config nested too deep (over ${MAX_CONFIG_DEPTH} levels)`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push(`${where}: non-finite number refused (cannot be durably replayed)`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkReplaySafe(`${where}[${i}]`, v, depth + 1, errors));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      walkReplaySafe(`${where}.${key}`, (value as Record<string, unknown>)[key], depth + 1, errors);
    }
  }
}

/**
 * Throwing form for the FIRE-TIME resolution backstop (boundary 3). A resolved
 * trigger binding (or, once S8 feeds it, a `${trigger.body}` passthrough) — or a
 * PRE-GATE stored literal that `substitute` passes through untouched — that came
 * to rest a non-finite number is refused BEFORE it can be frozen into a run's
 * params. Throws `SubstituteError`: the same class an unresolvable binding
 * throws, so every fire caller maps it with no new catch arm.
 */
export function assertJsonReplaySafe(where: string, value: unknown): void {
  const [first] = jsonReplaySafetyErrors(where, value);
  if (first !== undefined) {
    throw new SubstituteError(first);
  }
}

// --- trigger param bindings (#5 S12b) ---------------------------------------

/**
 * Flatten a `TriggerContext` to the CLOSED `${trigger.*}` root object every
 * consumer resolves against — the SSOT for that shape, so a `TRIGGER_FIELDS`
 * addition updates ONE site. `null` (a run with no trigger) yields all-null
 * fields rather than an absent root, so `${trigger.scheduledTime}` resolves to
 * `null` instead of throwing an unknown-field error. Shared by the reducer's
 * `buildCtx` (RUN-time reads) and `resolveTriggerBindings` (FIRE-time binding
 * resolution), so the two can never disagree about a trigger field's value.
 */
export function triggerRoot(tc: TriggerContext | null): {
  triggerId: string | null;
  scheduledTime: string | null;
  body: unknown;
  windowStart: string | null;
  windowEnd: string | null;
} {
  return {
    triggerId: tc?.triggerId ?? null,
    scheduledTime: tc?.scheduledTime ?? null,
    body: tc?.body ?? null,
    // #5 S11b — the window bounds, null for every non-window fire. Save-time
    // context-scoping (`TRIGGER_WINDOW_FIELDS`) means no legal doc/binding reads
    // them outside a tumbling trigger's bindings; carrying them here
    // unconditionally makes a pre-gate stored row fail SOFT (null — the
    // scheduledTime-on-manual semantic) rather than throw at fire time.
    // `windowEpoch` stays deliberately ABSENT: internal linkage, never readable.
    windowStart: tc?.windowStart ?? null,
    windowEnd: tc?.windowEnd ?? null,
  };
}

/**
 * Resolve a trigger's expression-valued param bindings at FIRE time (#5 S12b).
 * A `trigger.params` value may be a `${trigger.*}` expression (e.g. `{when:
 * "${trigger.scheduledTime}"}`); this evaluates every one against the fire-time
 * trigger context, so a schedule fire binds the occurrence it fired for.
 *
 * The substitution context carries ONLY the `trigger` root: a binding may
 * reference nothing else, and the save-time gate (`validateTriggerBindings`)
 * enforces that statically. The other roots are empty here so a stored,
 * pre-gate binding referencing `${params.*}`/`${run.*}` throws (fail-safe)
 * rather than resolving against a stale/absent value.
 *
 * PURE: reuses `substitute`, so it inherits the inert single-pass no-injection
 * guarantee (a resolved value that itself contains `${...}` is emitted
 * literally) and whole-value native-type preservation (a bare `${trigger.body}`
 * keeps its json shape). Whole-value type preservation is why the result feeds
 * `resolveRunParams` as the override layer directly, with no re-coercion here.
 */
export function resolveTriggerBindings(
  triggerParams: Record<string, unknown>,
  tc: TriggerContext,
): Record<string, unknown> {
  const ctx: SubstitutionContext = {
    params: {},
    nodeOutputs: {},
    nodeStatuses: {},
    run: {},
    trigger: triggerRoot(tc),
  };
  const resolved = substitute(triggerParams, ctx) as Record<string, unknown>;
  // #547 — boundary 3 (fire-time backstop). A binding whose whole-value result
  // is a non-finite number (a pre-gate stored literal `substitute` passes
  // through untouched, or a `${trigger.body.n}` passthrough once S8 feeds a body)
  // must not be frozen into a run's params, where it would `JSON.stringify` to
  // `null` on the `run.started` append and replay as a silent-wrong `null`. The
  // save-time boundary 1 (`TriggerParamsWriteSchema`) refuses a LITERAL non-finite
  // on write; this catches the pre-gate/expression-produced cases fail-safe.
  assertJsonReplaySafe('trigger param binding', resolved);
  return resolved;
}

// --- validateRefs (pure static validation, run at pipeline-SAVE time) -------

/**
 * PURE static validation of every `${...}` in a pipeline's node configs.
 * Returns a list of error strings (`[]` = valid). Enforces: declared params
 * only; a secret-typed param ref ANYWHERE is refused; the fn allowlist + arity;
 * unterminated `${` is an error; and node-output refs are validated by
 * AVAILABILITY / DOMINANCE over the doc's edge graph (see `computeGraph`).
 */
export function validateRefs(
  doc: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
): string[] {
  const errors: string[] = [];
  const declared = new Map<string, Param>();
  for (const p of doc.params) declared.set(p.name, p);

  const graph = computeGraph(doc);

  // Each producer's declared outputs (req c + E6 typing), computed once. The
  // SSOT is the same `config.outputs` the reducer stores/validates against, so a
  // name static validation accepts is exactly one the run would keep at
  // `succeeded`, and the TYPE it infers is the one the reducer enforces there.
  const outputsById = outputsByIdOf(doc.nodes, doc.containers ?? []);

  // #4 A4 — nodes that are children of a `foreach` body may reference `${item}`.
  // `scan` refuses `${item}` by default (it is "only bound inside a filter/map/
  // count predicate"), so a foreach body node is scanned with `itemInScope=true`
  // — the SAVE-TIME half of the binding the reducer seeds at dispatch
  // (`foreachItemOf`). First-declared-wins ownership is handled by the reducer's
  // `containerMembership`; here a plain membership set suffices (a node in two
  // foreach bodies would be a disjointness error `validateDoc` already reports).
  const foreachChildIds = new Set<string>();
  for (const c of doc.containers ?? []) {
    if (c.kind === 'foreach') for (const ch of c.children) foreachChildIds.add(ch);
  }

  for (const node of doc.nodes) {
    const guaranteed = graph.guaranteed.get(node.id) ?? new Set<string>();
    const settled = graph.settled.get(node.id) ?? new Set<string>();
    const reachable = graph.reachable.get(node.id) ?? new Set<string>();
    const soft = graph.soft.get(node.id) ?? new Set<string>();
    const scope: ScanScope = { declared, guaranteed, settled, reachable, soft, outputsById };
    if (node.type === FILTER_ACTIVITY_TYPE) {
      // #4 A8 — a `filter`'s two `${}` fields must be scanned as ONE composed
      // `filter(items, predicate)` expression, NOT field-by-field: only then does
      // `checkExprStatic` give the predicate (a `filter` `lambdaArg`) `${item}`
      // scope while `items` (arg0) keeps the outer/foreach scope. Scanning the raw
      // `predicate` field via the generic path would wrongly REFUSE its `${item}`
      // outside a foreach. `items`+`predicate` are the filter's only `${}` config,
      // so the composed scan replaces the generic one with no loss (`outputs` is
      // inert to `scan`; `scanSecretSinks` still runs below). A malformed field
      // (missing/non-whole-value) is skipped here and reported by
      // `validateFilterConfig` — scanning garbage would double-report or mis-parse.
      scanFilterRefs(node, scope, errors, foreachChildIds.has(node.id));
    } else if (node.type === LLM_CALL_ACTIVITY_TYPE && node.config['tools'] !== undefined) {
      // #2 L10a — an llm_call's `tools` subtree is DEFERRED-EVAL (its
      // expressions reference `${tool.args.*}`, bound only when the model calls
      // the tool), so the generic scan must not walk it: it would refuse the
      // `tool` root as context-scoped. Scan the REST of the config normally,
      // then each tool expression with the `tool` root in scope + restricted
      // (`scanLlmToolRefs`). `scanSecretSinks` (below) still walks the whole
      // config including `tools` — correct fail-closed behaviour (`llm_call`
      // declares no secret sink, so a `{$secret}` marker anywhere is refused).
      const rest: Record<string, unknown> = { ...node.config };
      delete rest['tools'];
      scan(
        `nodes.${node.id}.config`,
        rest,
        scope,
        errors,
        0,
        undefined,
        foreachChildIds.has(node.id),
      );
      scanLlmToolRefs(node, errors);
    } else {
      scan(
        `nodes.${node.id}.config`,
        node.config,
        scope,
        errors,
        0,
        undefined,
        foreachChildIds.has(node.id),
      );
    }
    // #2 L13a — a node's top-level `connectionId` may be a `${}` expression
    // (dynamic connection routing), resolved at dispatch by the reducer against
    // the SAME env `scan` scopes here (params/nodes/run/trigger, plus `${item}`
    // for a foreach body child). Validate its refs at SAVE so a bad ref is badged
    // rather than deferred to a run-time `invalid_event`. A literal id has no
    // `${}` and `scan` no-ops on it; it is NOT a secret sink (no `$secret` marker
    // — a secret-typed ref is refused by `scan` itself), so no `scanSecretSinks`.
    if (node.connectionId !== undefined) {
      scan(
        `nodes.${node.id}.connectionId`,
        node.connectionId,
        scope,
        errors,
        0,
        undefined,
        foreachChildIds.has(node.id),
      );
    }
    // Item 7 / S2: a `{ "$secret": "<name>" }` marker is valid ONLY within a
    // declared sink field of this node's activity. `getActivity` reads the
    // shared module catalog (no signature change to this fn or its callers,
    // spec §3.2). An unknown type ⇒ no sinks ⇒ every marker refused. Because
    // BOTH gates reach this via `validatePipelineDoc`, the canvas badge and the
    // server write-gate refuse an ill-placed marker identically (the #473
    // lesson, by construction).
    scanSecretSinks(
      `nodes.${node.id}.config`,
      node.config,
      getActivity(node.type)?.secretSinkFields ?? [],
      errors,
    );
  }
  return errors;
}

// --- secret-sink gate (item 7 / S2) ----------------------------------------

/**
 * PURE static gate for `{ "$secret": "<name>" }` markers in a node's `config`.
 * A marker is permitted ONLY within the subtree of a declared sink field — its
 * FIRST `config` path segment must be one of `sinkFields`. A marker anywhere
 * else is refused (`<path>: secret reference is not allowed here`). At a sink,
 * the marker's SHAPE is checked (strict `{ $secret: <non-empty string> }` and a
 * LITERAL name — no `${}` expression, spec §2). Runs alongside the `${}` `scan`,
 * never inside it: a marker is a distinguished object, not part of the inert
 * expression language (#1 D8). `sinkFields` is `[]` for every activity until a
 * consumer declares one (S4), so this is FAIL-CLOSED — no stored version can
 * hold a marker until the same slice that can also resolve it.
 *
 * Exported so S2 can exercise the ACCEPT branch directly with a synthetic sink
 * list — no real activity declares a sink yet, and `validateRefs` deliberately
 * has no catalog-injection seam (spec §3.2). S4 owns the `validateRefs`-level
 * accept test once `http_request` declares its sink.
 */
export function scanSecretSinks(
  where: string,
  config: unknown,
  sinkFields: readonly string[],
  errors: string[],
): void {
  // The gate and the S3 DISPATCH-time resolver (`server/.../executor.ts`) MUST
  // visit the EXACT same set of marker positions — the classic "two walkers
  // drift" hazard (#473). They share ONE traversal (`walkConfigForMarkers`);
  // this call only supplies the gate's per-marker ACTION (reject-or-shape-check),
  // the resolver supplies its own (resolve-or-fail). Neither owns the walk.
  walkConfigForMarkers(
    where,
    config,
    sinkFields,
    (path, value, allowed) => {
      if (!allowed) {
        errors.push(`${path}: secret reference is not allowed here`);
        return;
      }
      validateSecretMarker(path, value, errors);
    },
    // Bound the shared config-TREE walk (#537): the SAVE gate reports a clean
    // error past the cap, so a pathological config fails validation rather than
    // overflowing the stack. The `${}` `scan` (sibling walk) caps identically.
    (path) => errors.push(`${path}: config nested too deep (over ${MAX_CONFIG_DEPTH} levels)`),
  );
}

/**
 * The ONE shared traversal over a node `config` that both the save-time gate
 * (`scanSecretSinks`) and the dispatch-time resolver (`collectSecretSinkMarkers`)
 * drive. It calls `visit(path, value, allowed)` at every `{$secret}`-shaped
 * position (`isSecretRef` loose), carrying whether that position sits under a
 * declared sink field. A detected marker is a LEAF — never recursed into (its
 * `$secret` name is the value). A malformed marker is still DETECTED (loose
 * check) so a consumer can reject it rather than let it slip through as config.
 *
 * `allowed` is decided by the marker's FIRST `config` path segment: a top-level
 * field NAME in `sinkFields` makes its whole subtree in-region. The `config`
 * root itself is not a field, so a bare-marker root (or anything in a
 * non-object/array root) is always `allowed = false` — defence-in-depth parity
 * with the `${}` `scan`, never a live path under `StrictNodeSchema`.
 */
function walkConfigForMarkers(
  where: string,
  config: unknown,
  sinkFields: readonly string[],
  visit: (path: string, value: unknown, allowed: boolean) => void,
  onTooDeep?: (path: string) => void,
): void {
  // The config ROOT is always depth 0, so no cap check here — all recursion (and
  // so the config-TREE depth cap, #537) lives in `walkMarkerRegion`, which every
  // child descends through starting at depth 1. `onTooDeep` is how a caller with
  // an error sink (the SAVE gate) surfaces a clean over-depth error; a caller
  // without one (the DISPATCH resolver) simply STOPS past the cap — fail-safe,
  // since a marker below an over-deep cut was never blessed by the gate.
  if (isSecretRef(config)) {
    visit(where, config, false);
    return;
  }
  if (Array.isArray(config)) {
    config.forEach((v, i) => walkMarkerRegion(`${where}[${i}]`, v, false, visit, onTooDeep, 1));
    return;
  }
  if (config === null || typeof config !== 'object') return;
  for (const key of Object.keys(config as Record<string, unknown>).sort()) {
    walkMarkerRegion(
      `${where}.${key}`,
      (config as Record<string, unknown>)[key],
      sinkFields.includes(key),
      visit,
      onTooDeep,
      1,
    );
  }
}

/** Recurse a subtree carrying its in-sink `allowed` flag; a marker is a leaf. */
function walkMarkerRegion(
  path: string,
  value: unknown,
  allowed: boolean,
  visit: (path: string, value: unknown, allowed: boolean) => void,
  onTooDeep?: (path: string) => void,
  depth = 0,
): void {
  if (depth > MAX_CONFIG_DEPTH) {
    onTooDeep?.(path);
    return;
  }
  if (isSecretRef(value)) {
    visit(path, value, allowed);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      walkMarkerRegion(`${path}[${i}]`, v, allowed, visit, onTooDeep, depth + 1),
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      walkMarkerRegion(
        `${path}.${key}`,
        (value as Record<string, unknown>)[key],
        allowed,
        visit,
        onTooDeep,
        depth + 1,
      );
    }
  }
}

/**
 * DISPATCH-time (item 7 / S3) companion to the save-time gate: collect every
 * VALID `{ "$secret": "<name>" }` marker sitting at a declared sink field of a
 * node's `config`, as `{ path, name }` pairs. `path` is CONFIG-RELATIVE (no
 * `nodes.<id>.config` prefix, no leading `.`) — e.g. `secretHeaders.X-Api-Key`
 * — and is the KEY the executor's resolved-plaintext side channel uses, so an
 * adapter correlates a resolved value to the exact config position.
 *
 * Uses the SAME `walkConfigForMarkers` traversal as `scanSecretSinks`, so the
 * resolver can only ever resolve markers the gate already blessed (no drift).
 * Markers OUTSIDE a sink are skipped (never resolved) — a stored version cannot
 * contain one (the save gate rejects it), and skipping is the fail-safe read if
 * one somehow appears. A marker that fails the STRICT shape check is likewise
 * skipped: only `{ $secret: <non-empty string> }` (the gate's own contract) is
 * returned, so a caller never resolves a malformed marker.
 */
export function collectSecretSinkMarkers(
  config: unknown,
  sinkFields: readonly string[],
): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  walkConfigForMarkers('', config, sinkFields, (path, value, allowed) => {
    if (!allowed) return;
    const parsed = SecretRefSchema.safeParse(value);
    if (!parsed.success) return;
    // `walkConfigForMarkers` seeds the root as `''`, so the first segment comes
    // through as `.field` — strip the single leading dot to a clean rel path.
    out.push({ path: path.replace(/^\./, ''), name: parsed.data.$secret });
  });
  return out;
}

/** Shape-validate a marker at a declared sink: strict schema + literal name (§2). */
function validateSecretMarker(where: string, value: unknown, errors: string[]): void {
  const parsed = SecretRefSchema.safeParse(value);
  if (!parsed.success) {
    errors.push(`${where}: malformed secret reference (expected { "$secret": "<name>" })`);
    return;
  }
  // The `$secret` value must be a LITERAL name — a `${}` inside it would let
  // `substitute` interpolate it, defeating the "secret stays out of the inert
  // expression language" guarantee (spec §2). Same classifier the runtime reads.
  //
  // The `$${` escape is refused for the SAME invariant: `substitute` recurses
  // into the marker and rewrites `$${` → `${` (`expr.ts` restoreEscapes), so an
  // authored `foo$${x}` would resolve at S3 as a DIFFERENT name (`foo${x}`) than
  // the one this gate blessed. Rejecting it guarantees the name `validateRefs`
  // approves is byte-for-byte the name dispatch resolves — the marker really
  // does "survive substitution unchanged" (spec §2), not merely look like it.
  const name = parsed.data.$secret;
  const mode = interpolationMode(name);
  if (mode.unterminatedAt !== null || mode.matches.length > 0 || name.includes('$${')) {
    errors.push(`${where}: secret name must be a literal, not a \${} expression or $\${ escape`);
  }
}

// --- validatePipelineDoc (the ONE composition both gates call) -------------

/**
 * The COMPLETE static validation of a pipeline doc: the union of the two pure
 * validators. This is the SSOT for *which* rules a doc must satisfy, and both
 * gates call it — the canvas badge (`web/.../canvasDoc.ts`) and the server
 * write-gate (`server/.../repo/pipeline-versions.ts`, #444).
 *
 * It exists so those two can never drift apart. Hand-composing the two calls at
 * each site would make "the badge shows exactly what the server refuses" a
 * convention that holds only while every call site is remembered — the same
 * per-site-convention class that silently dropped `containers` in #473. Here it
 * holds by construction.
 *
 * `containers` is load-bearing for BOTH halves, not just the structural one: a
 * LOOP container re-runs its children, which is what makes a
 * `${nodes.<id>.status}` ref unanswerable in that doc (#6 E3).
 *
 * `options` forwards to `validateDoc` and gates the `call_pipeline` cycle+depth
 * analysis (#495). The two gates supply DIFFERENT options ON PURPOSE:
 *  - the CANVAS badge passes NONE (`canvasDoc.ts`) — it has no DB, and enforcing
 *    a rule the canvas never checked would newly 400 a doc that badges clean;
 *  - the SERVER write gate passes `{ selfId, resolvePipeline }` where
 *    `resolvePipeline` is OWNER-SCOPED (`repo/pipeline-versions.ts`, #495).
 * This function stays PURE — it does no I/O and reads no clock. The DB read the
 * call graph needs lives entirely in the resolver the SERVER injects; passing a
 * function is not an effect, and `validateDoc` only invokes whatever resolver it
 * is handed (the pure-core / injected-effect pattern `ValidateDocOptions` was
 * built for). A cycle that only manifests DYNAMICALLY (an unresolvable `${}` or
 * cross-owner callee) is still caught at run time by the reducer's `stalled`
 * backstop (#491), which the static gate does not replace.
 *
 * Returns error strings; `[]` means valid.
 */
export function validatePipelineDoc(
  doc: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
  options: ValidateDocOptions = {},
): string[] {
  return [...validateDoc(doc, options), ...validateRefs(doc)];
}

// --- validateDoc (structural static validation, run at pipeline-SAVE time) --

/** A pipeline-version resolver: the `nodes` of another version, for the call graph. */
export type PipelineResolver = (
  pipelineVersionId: string,
) => Pick<PipelineVersion, 'nodes'> | undefined;

export interface ValidateDocOptions {
  /** This version's own id — catches a direct self-call + seeds the call graph. */
  selfId?: string;
  /** Resolve another version's `nodes`, for cross-pipeline cycle/depth analysis. */
  resolvePipeline?: PipelineResolver;
  /** Max call-graph depth (hops from this version). Default 3. */
  maxCallDepth?: number;
}

/**
 * PURE structural validation of a pipeline's P2c constructs, at SAVE time
 * (complements `validateRefs`, which checks the `${}` language). Returns error
 * strings (`[]` = valid). Enforces:
 *  - container children exist as nodes and are DISJOINT across containers;
 *  - a loop declares an `exitWhen` (a `maxRounds` is only the round cap, never
 *    the exit condition) and has at least one child (an empty loop re-rounds
 *    forever), and a stage carries no `exitWhen`;
 *  - a container's `exitWhen` is a valid `${}` expr over its OWN child outputs;
 *  - a `back` edge's `to` is an ANCESTOR (a loop/stage container, or an upstream
 *    node) that forward-reaches its `from`;
 *  - a `call_pipeline` node introduces no cycle and no path deeper than
 *    `maxCallDepth` over the (statically-resolvable) call graph.
 */
export function validateDoc(
  doc: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
  options: ValidateDocOptions = {},
): string[] {
  const errors: string[] = [];
  const nodeIdList = doc.nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIdList);
  const containers = doc.containers ?? [];
  const declared = new Map<string, Param>();
  for (const p of doc.params) {
    declared.set(p.name, p);
    // #547 — a param DEFAULT is applied by `resolveRunParams` for any
    // un-overridden param and, for a `json`-typed default, passed through
    // `coerce` UNTOUCHED into `run.params` → the `run.started` event, where a
    // non-finite number `JSON.stringify`s to `null` and replays silently-wrong.
    // (A `number`-typed non-finite default already fails LOUD at `coerce`; this
    // closes the `json` hole at the same save-time, write-path-only,
    // by-construction gate as every other doc-integrity rule here — on an
    // IMMUTABLE doc, so it can only be refused at write, never repaired later.)
    if (Object.prototype.hasOwnProperty.call(p, 'default')) {
      errors.push(...jsonReplaySafetyErrors(`param '${p.name}' default`, p.default));
    }
  }
  const outputsById = outputsByIdOf(doc.nodes, doc.containers ?? []);
  // #567 — a `foreach`'s `items` is validated against the container ENDPOINT's real
  // OUTER dominance (see `validateForeachItems`). Built lazily: only a foreach with
  // an `items` expression needs it, so a foreach-free doc pays nothing.
  let graphForItems: Graph | null = null;
  const itemsGraph = (): Graph => (graphForItems ??= computeGraph(doc));

  // GLOBAL id uniqueness: node ids and container ids share ONE namespace (the
  // projection keys `state.nodes` / `state.outputs` / `endpointOutcome` by id),
  // so a duplicate or a node/container collision silently corrupts state.
  const idKind = new Map<string, 'node' | 'container'>();
  for (const id of nodeIdList) {
    if (idKind.has(id)) errors.push(`duplicate node id '${id}' (ids must be globally unique)`);
    else idKind.set(id, 'node');
  }
  for (const c of containers) {
    const prior = idKind.get(c.id);
    if (prior !== undefined) {
      errors.push(
        `container id '${c.id}' collides with an existing ${prior} id ` +
          '(node and container ids share one namespace)',
      );
    } else idKind.set(c.id, 'container');
  }

  // A CORRUPT `config.outputs` (#1 F13a). Reported HERE as a readable
  // diagnostic so the authoring UI can show it; `StrictNodeSchema` is what
  // actually REFUSES it on save — it runs FIRST, so this rule is unreachable
  // from the #444 write gate (a corrupt contract is a `ZodError`/400
  // `validation_error`, never `invalid_pipeline_doc`) — and the reducer fails
  // the node at run time. Reported once per node: every
  // `${nodes.<id>.output.*}` ref against a corrupt contract has the same one
  // root cause, so per-ref errors would just bury it.
  const nodeById = new Map<string, Node>(doc.nodes.map((n) => [n.id, n]));
  for (const node of doc.nodes) {
    const contract = outputsById.get(node.id);
    if (contract?.kind === 'invalid') {
      errors.push(`node '${node.id}': config.outputs is malformed (${contract.reason})`);
    }
    // #4 A1 — an `if`'s boolean condition must be WHOLE-VALUE (save-time half).
    if (node.type === IF_ACTIVITY_TYPE) validateIfCondition(node, errors);
    // #4 A2 — a `switch`'s `on` + `cases` shape (save-time half).
    if (node.type === SWITCH_ACTIVITY_TYPE) validateSwitchConfig(node, errors);
    // #4 A7 — a `fail`'s `message` presence (save-time half).
    if (node.type === FAIL_ACTIVITY_TYPE) validateFailConfig(node, errors);
    // #4 A8 — a `filter`'s `items`+`predicate` presence + whole-value shape.
    if (node.type === FILTER_ACTIVITY_TYPE) validateFilterConfig(node, errors);
    // #4 A6 — a `wait`'s `seconds` presence + whole-value shape (number field).
    if (node.type === WAIT_ACTIVITY_TYPE) validateWaitConfig(node, errors);
    // #4 A13 — a `webhook`'s `timeoutSeconds` presence + whole-value shape.
    if (node.type === WEBHOOK_ACTIVITY_TYPE) validateWebhookConfig(node, errors);
    // #4 A9 — an `execute_pipeline` MUST carry a `Node.call` (save-time half).
    if (node.type === EXECUTE_PIPELINE_ACTIVITY_TYPE) validateExecutePipelineConfig(node, errors);
    // #2 L4a — an `llm_call`'s structured output surface (outputMode/outputSchema).
    if (node.type === LLM_CALL_ACTIVITY_TYPE) {
      validateLlmCallOutput(node, errors);
      validateLlmCallTools(node, errors); // #2 L10a — the tools config surface
    }
    // #2 L11b — an `agent_task`'s optional structured `outputSchema` subset.
    if (node.type === AGENT_TASK_ACTIVITY_TYPE) validateAgentTaskOutput(node, errors);
  }

  // Node-only forward reachability + the container index, for the back-edge
  // reset-body (no-progress) guard below — computed via the SSOT helpers so the
  // reducer and this validator agree on which nodes a bounce resets.
  const containerById = new Map<string, Container>(containers.map((c) => [c.id, c]));
  const nodeAdj = nodeForwardAdjacency(doc);
  const descendants = new Map<string, Set<string>>();
  for (const id of nodeIdList) descendants.set(id, forwardDescendants(id, nodeAdj));

  // Container children: existence + disjointness; loop/stage exit configuration.
  // Ownership (disjointness) is resolved by the shared `containerMembership` SSOT,
  // FIRST-declared-wins, so the reducer classifies edges and neutralizes duplicates
  // against the SAME owner this validator names — the divergence #492 closed, where
  // the reducer silently took the LAST owner instead. Existence and loop/stage
  // config stay here.
  const { owner: childOwner } = containerMembership(containers);
  for (const c of containers) {
    for (const ch of c.children) {
      if (!nodeIdSet.has(ch)) {
        errors.push(`container '${c.id}': child '${ch}' is not a node in this pipeline`);
      }
      // Disjointness read from the shared owner map (FIRST-wins): a child whose
      // resolved owner is some OTHER container is a duplicate here. Emitted per
      // occurrence, interleaved with the existence error, to keep this validator's
      // error ARRAY — not just its message text — byte-identical to the pre-#492
      // pass this replaced.
      const own = childOwner.get(ch);
      if (own !== undefined && own !== c.id) {
        errors.push(
          `container '${c.id}': child '${ch}' already belongs to container '${own}' (children must be disjoint)`,
        );
      }
    }
    if (c.kind === 'loop' && c.exitWhen === undefined) {
      errors.push(
        `container '${c.id}': a loop needs an exitWhen ` +
          '(maxRounds is only the round cap, not the exit condition)',
      );
    }
    // The container counterpart of the back-edge no-progress rule below. A loop
    // with no children re-rounds forever: the round is vacuously terminal, the
    // reset returns nothing to `pending`, so `exitWhen` can never change. The
    // reducer refuses it too (`stepContainers` → `no_progress`) — it has to, for
    // the rows written before the #444 write gate, which were never validated —
    // but a doc this broken should be reported here as well, not only discovered
    // at run time.
    // Counts only children that RESOLVE to a node, which is what makes this the
    // reducer's rule rather than a near-miss of it: the reducer tests the body it
    // will actually run (non-node children are neutralized at the bind), so a
    // loop whose only child is a container id is empty to the reducer. Testing
    // raw `children.length` here would let exactly that doc — the one that makes
    // #487 and this fix inseparable — pass the validator and still fail the run.
    if (c.kind === 'loop' && c.children.filter((ch) => nodeIdSet.has(ch)).length === 0) {
      errors.push(
        `container '${c.id}': makes no progress — a loop needs at least one child ` +
          '(an empty loop re-rounds forever: a round resets nothing, so exitWhen never changes)',
      );
    }
    if (c.kind === 'stage' && c.exitWhen !== undefined) {
      errors.push(`container '${c.id}': exitWhen is only meaningful on a loop, not a stage`);
    }
    // Symmetric to the exitWhen/maxRounds refusals: `items` is foreach-only, so a
    // stray `items` on a loop/stage is a dead field — refuse it LOUDLY rather than
    // silently accept it (the reducer ignores it, so nothing else would surface it).
    if (c.kind !== 'foreach' && c.items !== undefined) {
      errors.push(`container '${c.id}': items is only meaningful on a foreach, not a ${c.kind}`);
    }
    // #4 A17 — `timeout` is a WALL-CLOCK bound on a re-rounding loop; a `stage`/
    // `foreach` runs its body a fixed number of times and cannot spin, so a timeout
    // there is a dead field. Refuse it LOUDLY (the reducer only arms it for a loop,
    // so nothing else would surface a stray one), symmetric to the exitWhen/items
    // loop-vs-foreach refusals.
    if (c.kind !== 'loop' && c.timeout !== undefined) {
      errors.push(`container '${c.id}': timeout is only meaningful on a loop, not a ${c.kind}`);
    }
    // #4 A4 — a `foreach` iterates its body once per element of `items`; it needs
    // an items expression and takes NEITHER a loop's exitWhen NOR its maxRounds
    // (it is bounded by items.length, not a predicate/cap). A zero-CHILD foreach
    // terminates (it is not the loop's infinite-re-round hazard) but is useless,
    // so it is refused for parity with the loop child-count rule.
    if (c.kind === 'foreach') {
      if (c.items === undefined) {
        errors.push(
          `container '${c.id}': a foreach needs an items expression ` +
            '(the ${} array the body iterates)',
        );
      }
      if (c.exitWhen !== undefined) {
        errors.push(`container '${c.id}': exitWhen is only meaningful on a loop, not a foreach`);
      }
      if (c.maxRounds !== undefined) {
        errors.push(`container '${c.id}': maxRounds is only meaningful on a loop, not a foreach`);
      }
      if (c.children.filter((ch) => nodeIdSet.has(ch)).length === 0) {
        errors.push(`container '${c.id}': a foreach needs at least one child (its per-item body)`);
      }
      if (c.items !== undefined)
        validateForeachItems(c, declared, outputsById, itemsGraph(), errors);
    }
    if (c.exitWhen !== undefined) validateExitWhen(c, declared, outputsById, errors);
  }

  // A child's FORWARD edges must stay WITHIN its container: a cross-boundary
  // edge (exactly one endpoint a child, or children of different containers)
  // breaks encapsulation — the outside node would run from the child's terminal
  // before the container exits. Back-edges are exempt (a child may back-edge to
  // its own enclosing container). Top-level ↔ container-id edges are fine (both
  // have no child-owner).
  for (const e of doc.edges) {
    if (e.back) continue;
    const fromOwner = childOwner.get(e.from);
    const toOwner = childOwner.get(e.to);
    if (fromOwner !== toOwner) {
      const loc = (id: string, owner: string | undefined): string =>
        owner !== undefined ? `'${id}' (child of '${owner}')` : `'${id}'`;
      errors.push(
        `edge '${e.id}': crosses a container boundary ${loc(e.from, fromOwner)} → ` +
          `${loc(e.to, toOwner)}; a child's forward edges must stay within its container`,
      );
    }
  }

  // Business `branch` edges (#4 A0): the REAL rule now that `if` routes them — a
  // branch edge is valid iff its SOURCE is a branching activity that DECLARES the
  // label. `if` declares exactly {'true','false'}; any other source type (or a
  // container) declares none, so a branch edge off it can never satisfy at run
  // time (`edgeState` reads `state.branches`, which only an `if` populates). This
  // replaces the pre-A0 blanket "not routable yet" error. Advisory like every
  // rule here (canvas badge + the #444 write gate); PARSE stays permissive
  // (`EdgeSchema`) so a pre-gate git import round-trips one unchanged. A2 (switch)
  // extends `declaredBranchesOf` with the node's configured case labels + default.
  for (const e of doc.edges) {
    if (e.on !== 'branch') continue;
    const src = nodeById.get(e.from);
    const branches = src === undefined ? undefined : declaredBranchesOf(src);
    if (branches === undefined) {
      errors.push(
        `edge '${e.id}': source '${e.from}' is not a branching activity — only an ` +
          `'if' (true/false) or a 'switch' (its cases/default) emits a branch outcome`,
      );
    } else if (!branches.has(e.branch)) {
      errors.push(
        `edge '${e.id}': source '${e.from}' does not declare branch '${e.branch}' — ` +
          `it routes only ${[...branches].map((b) => `'${b}'`).join('/')}`,
      );
    }
  }

  // The FORWARD graph (all edges minus `back:true`) must be a DAG — a forward
  // cycle wedges the walk: its nodes never become ready, so `settle` emits no
  // command. #491's backstop now terminalizes such a run as
  // `failure{reason:'stalled'}` instead of hanging it forever, but that is
  // CONTAINMENT, not permission — the run still does nothing the author asked
  // for, so this stays a hard error and #444's write gate still refuses the doc.
  // (Not every forward cycle stalls: one whose skip enters from outside
  // terminalizes every node without running it. It is refused all the same.)
  errors.push(...forwardCycleErrors(doc, containers));

  // Back-edge ancestry: `to` must forward-reach `from` (a container also
  // "reaches" — encloses — its own children). Plus every back-edge MUST declare
  // `maxBounces` (an unbounded loop never terminates) and must actually make
  // PROGRESS — its reset body must include its own source, else firing it resets
  // nothing and `fireBackEdges` re-sees the same satisfied edge forever.
  const reach = forwardReach(doc, containers);
  for (const e of doc.edges) {
    if (!e.back) continue;
    const fromTarget = reach.get(e.to) ?? new Set<string>();
    if (!fromTarget.has(e.from)) {
      errors.push(
        `back-edge '${e.id}': its target '${e.to}' must be an ancestor of '${e.from}' ` +
          '(a loop/stage container or an upstream node that reaches it)',
      );
    }
    if (e.maxBounces === undefined) {
      errors.push(
        `back-edge '${e.id}': must declare maxBounces ` + '(an unbounded back-edge loops forever)',
      );
    }
    const body = backEdgeResetBody(e, nodeIdList, descendants, containerById);
    if (body.length === 0 || !body.includes(e.from)) {
      errors.push(
        `back-edge '${e.id}': makes no progress — its reset body must include its ` +
          `source '${e.from}' (a container-targeted back-edge whose source is outside ` +
          'the container, or a body that never re-runs the source, re-fires forever)',
      );
    }
  }

  errors.push(...validateCallGraph(doc, options));
  return errors;
}

/** Validate a container's `exitWhen` `${}` refs point only at its OWN children. */
/**
 * The business branch labels an activity DECLARES it can emit (#4 A0) — the ONE
 * SSOT the branch-edge rule reads, so the declared set and the reducer's routing
 * (`edgeState` over `state.branches`) cannot drift. `if` routes exactly
 * `true`/`false`; every other type — and a container — declares none
 * (`undefined`: only a control branching activity routes). A2 extends this with a
 * `switch`'s configured case labels + `default`.
 */
function declaredBranchesOf(node: Node): Set<string> | undefined {
  if (node.type === IF_ACTIVITY_TYPE) return new Set([IF_BRANCH_TRUE, IF_BRANCH_FALSE]);
  if (node.type === SWITCH_ACTIVITY_TYPE) {
    // A `switch` declares its configured case labels PLUS the implicit `default`
    // fallthrough (`evalSwitchBranch` routes an unmatched value there). Only
    // STRING case entries count — a malformed non-string case is reported by
    // `validateSwitchConfig`, and including it here would just double up the noise.
    const rawCases = node.config['cases'];
    const cases = Array.isArray(rawCases)
      ? rawCases.filter((c): c is string => typeof c === 'string')
      : [];
    return new Set([...cases, SWITCH_DEFAULT_BRANCH]);
  }
  return undefined;
}

/**
 * #4 A1 — the SAVE-TIME half of the `if`-condition rule the reducer's
 * `evalIfBranch` enforces at run time (both halves, or the rule is decorative —
 * the E2/E6 split `exitWhen` follows). Whole-value ONLY: an EMBEDDED expression
 * (`x${c}y`) can only ever resolve to a STRING, never a boolean, so it can never
 * route — refuse it at save. The condition's `${}` refs are already
 * existence+grammar checked doc-wide by `validateRefs`; the boolean TYPE of the
 * whole expression is enforced by the reducer at run time (`evalIfBranch` throws
 * a non-boolean → `invalid_event`) rather than re-derived here, which would need
 * this validator to rebuild the per-node ref scope `validateRefs` already owns —
 * a deliberate, documented deferral, not a gap (both halves are covered).
 */
function validateIfCondition(node: Node, errors: string[]): void {
  const where = `node.${node.id}.condition`;
  const raw = node.config['condition'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(
      `${where}: an if needs a boolean condition expression ` +
        `(e.g. \${equals(nodes.check.output.ok, 'true')})`,
    );
    return;
  }
  validateWholeValue(where, raw, errors, 'condition');
}

/**
 * #4 A2 — the SAVE-TIME half of the `switch` `on`/`cases` rule the reducer's
 * `evalSwitchBranch` enforces at run time (both halves, or the rule is
 * decorative). Advisory like every rule here (canvas badge + the #444 write gate).
 *
 * Deliberately UNLIKE `validateIfCondition`: an `if`'s boolean can only come from
 * a whole-value `${}`, so an embedded template is refused; a `switch` matches on a
 * STRING, and an embedded template (`"tier-${x}"`) resolves to a valid string, so
 * `on` is NOT whole-value-gated here — its `${}` refs are already existence+grammar
 * checked doc-wide by `validateRefs`, and the string TYPE of the result is enforced
 * by the reducer at run time (`evalSwitchBranch` throws a non-string →
 * `invalid_event`), the same deferral `validateIfCondition` documents for its
 * boolean type. The `cases` rules (non-empty, unique strings, no `default`
 * collision) are hygiene the reducer does not need — a duplicate or a `'default'`
 * case routes deterministically regardless — but a save-time author error worth
 * surfacing, matching `if`'s advisory posture.
 */
function validateSwitchConfig(node: Node, errors: string[]): void {
  const where = `node.${node.id}`;
  const on = node.config['on'];
  if (typeof on !== 'string' || on.trim() === '') {
    errors.push(
      `${where}.on: a switch needs a string 'on' expression to match against its cases ` +
        `(e.g. \${nodes.classify.output.label})`,
    );
  }
  const rawCases = node.config['cases'];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    errors.push(`${where}.cases: a switch needs a non-empty 'cases' array of case labels`);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < rawCases.length; i += 1) {
    const c = rawCases[i];
    if (typeof c !== 'string' || c === '') {
      errors.push(`${where}.cases[${i}]: a case label must be a non-empty string`);
      continue;
    }
    if (c === SWITCH_DEFAULT_BRANCH) {
      errors.push(
        `${where}.cases[${i}]: a case may not be named '${SWITCH_DEFAULT_BRANCH}' — ` +
          `that label is reserved for the switch's implicit fallthrough branch`,
      );
      continue;
    }
    if (seen.has(c)) {
      errors.push(`${where}.cases[${i}]: duplicate case label '${c}'`);
      continue;
    }
    seen.add(c);
  }
}

/**
 * #4 A7 — the SAVE-TIME half of the `fail` `message` rule the reducer's
 * `evalFailMessage` enforces at run time (both halves, or the rule is decorative).
 * Advisory like every rule here (canvas badge + the #444 write gate). A `fail`
 * needs a non-empty `message` string; its `${}` refs are already existence+grammar
 * checked doc-wide by `validateRefs`, and the message is an EMBEDDED template (not
 * whole-value-gated) the same way a `switch`'s `on` is — so this only pins the
 * presence, matching the reducer's raw-`message` check (which fails a message-less
 * fail LOUD as `invalid_event`).
 */
function validateFailConfig(node: Node, errors: string[]): void {
  const where = `node.${node.id}.message`;
  const raw = node.config['message'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(
      `${where}: a fail needs a non-empty message describing the failure ` +
        `(e.g. 'validation rejected the input')`,
    );
  }
}

/**
 * #4 A8 — a `filter`'s `items`+`predicate` SHAPE (save-time half). Both are
 * WHOLE-value-REQUIRED `${}` fields: `items` resolves to the array to filter,
 * `predicate` to the per-element boolean — an embedded template (`"a${x}"`) would
 * resolve to a STRING, so `composeFilterExpr` could not splice it into the
 * `filter(items, predicate)` closed-fn. Mirrors `foreach.items`/`if.condition`'s
 * whole-value rule (`validateWholeValue`) and `validateFailConfig`'s presence
 * check. The `${}` REF checking (and the field-aware `${item}` scope) is
 * `validateRefs`' job, which scans the SAME composed expression.
 */
function validateFilterConfig(node: Node, errors: string[]): void {
  for (const noun of ['items', 'predicate'] as const) {
    const where = `node.${node.id}.${noun}`;
    const raw = node.config[noun];
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`${where}: a filter needs a non-empty \${} ${noun} expression`);
      continue;
    }
    validateWholeValue(where, raw, errors, noun);
  }
}

/**
 * #4 A6 — a `wait`'s `seconds` SHAPE (save-time half). A WHOLE-value-REQUIRED `${}`
 * field: it resolves to the NUMBER of seconds to park, so an embedded template
 * (`"wait ${x}s"`) — which can only ever resolve to a STRING — could never be a
 * duration; refuse it at save, exactly as `if.condition`/`filter.items` refuse a
 * non-whole-value boolean/array (`validateWholeValue`). The `${}` REF checking is
 * `validateRefs`' job (the generic node scan); the RUN-TIME type gate — that the
 * resolved value is a finite, non-negative number — is `evalWaitSeconds`, which
 * fails a malformed wait LOUD as `invalid_event` (the `wholeValueDefect` vs
 * `validateWholeValue` split `if`/`filter` follow).
 */
function validateWaitConfig(node: Node, errors: string[]): void {
  validateDurationConfig(node, errors, 'seconds', 'wait');
}

/**
 * #4 A13 — a `webhook` node parks on a `${}` `timeoutSeconds` (the save-time half,
 * the twin of `validateWaitConfig`; the run-time half is
 * `evalWebhookTimeoutSeconds`). Required — a webhook must always be time-bounded so
 * it can never park indefinitely.
 */
function validateWebhookConfig(node: Node, errors: string[]): void {
  validateDurationConfig(node, errors, 'timeoutSeconds', 'webhook');
}

/**
 * #4 A6/A13 — the SSOT save-time rule for a durable-park node's `${}` DURATION
 * field: a non-empty whole-value `${}` number expression. Parameterised by the
 * config key + node noun so `wait` (`seconds`) and `webhook` (`timeoutSeconds`)
 * share one rule with the matching run-time `evalDurationSeconds`.
 */
function validateDurationConfig(node: Node, errors: string[], field: string, noun: string): void {
  const where = `node.${node.id}.${field}`;
  const raw = node.config[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(
      `${where}: a ${noun} needs a non-empty \${} ${field} expression ` +
        '(e.g. ${5} or ${nodes.check.output.retryAfter})',
    );
    return;
  }
  validateWholeValue(where, raw, errors, field);
}

/**
 * #4 A9 — an `execute_pipeline` node routes structurally on `Node.call` (it
 * surfaces the `call_pipeline` mechanism as a first-class TYPE). A node typed
 * `execute_pipeline` with NO `call` never reaches the call machinery: the reducer
 * falls through to dispatch and the executor fails it `CONTROL_NOT_DISPATCHABLE`
 * at run time. Refuse it at SAVE. The call BLOB's shape (`pipelineVersionId` etc.)
 * is already enforced by `CallConfigSchema` on the write path (`StrictNodeSchema`),
 * so this only checks PRESENCE. The converse is deliberately NOT enforced — a
 * legacy `call_pipeline`-typed call node stays valid (back-compat), since routing
 * keys on `call`, not this type.
 */
function validateExecutePipelineConfig(node: Node, errors: string[]): void {
  if (node.call === undefined) {
    errors.push(
      `node.${node.id}: an execute_pipeline needs a call config ` +
        '(target pipeline version + params)',
    );
  }
}

/**
 * #2 L4a — the save-time rule for a `llm_call`'s structured OUTPUT surface
 * (`outputMode` + `outputSchema`). Parses the `{outputMode, outputSchema}` SLICE
 * of the node config through `llmStructuredOutputSurfaceSchema` — the SAME schema
 * the lowering pass (`catalog/lower.ts`) gates on — and turns any subset/coupling
 * issue into a readable diagnostic the authoring UI can show. Because lowering and
 * this validator parse through ONE schema, a schema that lowers is exactly a
 * schema that validates, and vice versa (no drift between "what saves" and "what
 * lowers").
 *
 * This checks ONLY the L4a surface; the rest of `llm_call` config
 * (prompt/messages/sampling) is intentionally NOT re-validated here (it never was
 * at save time — the adapters validate the whole config at dispatch), so L4a adds
 * no back-compat risk to existing text nodes.
 */
function validateLlmCallOutput(node: Node, errors: string[]): void {
  const parsed = llmStructuredOutputSurfaceSchema.safeParse(node.config);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    // Every issue path starts at the `outputSchema`/`outputMode` field (the two
    // keys this slice picks), so the dotted path already names the surface — no
    // hardcoded prefix needed.
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    errors.push(`node.${node.id}: ${path}${issue.message}`);
  }
}

/**
 * #2 L10a — the tools-surface counterpart of `validateLlmCallOutput`: parse the
 * `{ tools, toolChoice, outputMode }` slice through `llmToolsSurfaceSchema`
 * (ToolDef shapes, unique names, the toolChoice/structured coupling) and
 * surface each issue as a node-scoped diagnostic. The EXPRESSION refs are
 * `scanLlmToolRefs`'s half (validateRefs); this is the config SHAPE half.
 */
function validateLlmCallTools(node: Node, errors: string[]): void {
  const parsed = llmToolsSurfaceSchema.safeParse(node.config);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    errors.push(`node.${node.id}: ${path}${issue.message}`);
  }
}

/**
 * #2 L11b — the `agent_task` counterpart of `validateLlmCallOutput`: an OPTIONAL
 * structured `outputSchema`, opted into by presence (no `outputMode` coupling), so
 * the gate is `llmOutputSchemaSchema` on the raw field directly — the SAME
 * predicate `lowerAgentTaskStructuredOutputs` uses, so a schema that lowers is
 * exactly one that saves (the SSOT invariant). Absent → nothing to check; a present
 * schema that fails the subset → readable per-issue diagnostics (prefixed
 * `outputSchema.`) that refuse the whole save (no garbage-lowered contract ever
 * persists — the same fail-closed shape as the `llm_call` path).
 */
function validateAgentTaskOutput(node: Node, errors: string[]): void {
  const raw = node.config['outputSchema'];
  if (raw === undefined) return;
  const parsed = llmOutputSchemaSchema.safeParse(raw);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const suffix = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    errors.push(`node.${node.id}: outputSchema${suffix}: ${issue.message}`);
  }
}

/**
 * #4 A8 — scan a `filter` node's `${}` refs as the ONE composed
 * `filter(items, predicate)` expression (see `composeFilterExpr`), so
 * `checkExprStatic` scopes `${item}` field-aware: allowed in the predicate (arg1,
 * a `lambdaArg`) always, in `items` (arg0) only under `itemInScope` (foreach
 * membership). A malformed field (missing / non-whole-value) is skipped —
 * `validateFilterConfig` reports it — since a garbage compose would mis-parse.
 */
function scanFilterRefs(
  node: Node,
  scope: ScanScope,
  errors: string[],
  itemInScope: boolean,
): void {
  let composed: string;
  try {
    composed = composeFilterExpr(node.config);
  } catch {
    // Not composable (a missing / non-whole-value field): `validateFilterConfig`
    // reports the SHAPE defect, but `validateWholeValue`/`defectOf` deliberately
    // stay silent on a GRAMMAR error (an unterminated `${`) — every other field
    // relies on the generic `scan` for that. Since a filter REPLACES that generic
    // scan, fall back to scanning each raw field so an unterminated `${` / bad ref
    // is still badged at SAVE, not deferred to a run-time `invalid_event`. Field-
    // aware `${item}` scope even here: the predicate is a lambda position (`${item}`
    // always bound), `items` only under foreach membership (`itemInScope`).
    const rawItems = node.config['items'];
    const rawPredicate = node.config['predicate'];
    if (typeof rawItems === 'string') {
      scan(`nodes.${node.id}.config.items`, rawItems, scope, errors, 0, undefined, itemInScope);
    }
    if (typeof rawPredicate === 'string') {
      scan(`nodes.${node.id}.config.predicate`, rawPredicate, scope, errors, 0, undefined, true);
    }
    return;
  }
  scan(`nodes.${node.id}.config`, composed, scope, errors, 0, undefined, itemInScope);
}

/**
 * #2 L10a — scan an llm_call's `tools[].expression` fields, each with the
 * `tool` root IN SCOPE (`toolArgTypes` = that tool's declared parameters,
 * lowered to `SigType` via the SAME `lowerOutputSchema` the structured path
 * freezes with) and every OTHER root RESTRICTED out (`TOOL_EXPRESSION_ROOTS`
 * — a `${params.x}` names run state a tool evaluation deliberately cannot
 * see). Whole-value REQUIRED (`validateWholeValue`, mirroring the filter
 * fields): an interpolated expression would coerce the result to a string.
 *
 * A tool that fails `llmToolDefSchema` is SKIPPED here — `validateLlmCallTools`
 * reports the shape defect, and scanning a malformed def would mis-derive its
 * parameter scope. The scope sets are empty: a tool expression references no
 * graph fact, and the root restriction refuses any that tries before the scope
 * is consulted.
 */
function scanLlmToolRefs(node: Node, errors: string[]): void {
  const rawTools = node.config['tools'];
  if (!Array.isArray(rawTools)) return; // shape defect — validateLlmCallTools reports it
  rawTools.forEach((raw, i) => {
    const parsed = llmToolDefSchema.safeParse(raw);
    if (!parsed.success) return;
    const where = `nodes.${node.id}.config.tools[${i}].expression`;
    const argTypes = new Map<string, SigType>();
    for (const out of lowerOutputSchema(parsed.data.parameters)) {
      argTypes.set(out.name, sigOfDeclared(out.type));
    }
    const scope: ScanScope = {
      declared: new Map(),
      guaranteed: new Set(),
      settled: new Set(),
      reachable: new Set(),
      soft: new Set(),
      toolArgTypes: argTypes,
    };
    validateWholeValue(where, parsed.data.expression, errors, 'tool expression');
    scan(where, parsed.data.expression, scope, errors, 0, TOOL_EXPRESSION_ROOTS);
  });
}

function validateExitWhen(
  c: Container,
  declared: Map<string, Param>,
  outputsById: Map<string, OutputContract>,
  errors: string[],
): void {
  if (c.exitWhen === undefined) return;
  const where = `container.${c.id}.exitWhen`;
  const scope: ScanScope = {
    declared,
    // E6 needs the child producers' declared output types to type the exitWhen
    // expression — without them `${nodes.check.output.done}` is `any` and the
    // boolean check never fires on the shape every real loop uses.
    //
    // A deliberate CONSEQUENCE: the undeclared-output-NAME refusal that
    // `validateRefs` applies doc-wide now applies inside `exitWhen` too, where
    // the absent map previously disabled it. That gap was never intentional —
    // the rule (a name the producer does not declare can only throw at run) is
    // no less true here.
    outputsById,
    guaranteed: new Set(c.children), // a child's output is in-scope for exit
    // Every child is SETTLED here by construction: the reducer only evaluates
    // `exitWhen` once every child is terminal (`stepContainers`), so unlike the
    // doc-level analysis this needs no conservatism — the gate is the reducer's
    // own precondition.
    //
    // AVAILABILITY only. It does NOT make a bare `${nodes.check.status}` a usable
    // exitWhen: the field needs a BOOLEAN, and a status resolves to the string
    // `'success'`. The usable form is `${equals(nodes.check.status, 'success')}`.
    // That refusal is the TYPE check at the foot of this function (#6 E6), per
    // E2's split (E2 owns the MODE check, E6 the TYPE check) — refusing
    // availability HERE instead would misattribute a type defect to a scope rule.
    settled: new Set(c.children),
    reachable: new Set<string>(),
    soft: new Set<string>(),
  };
  // Reuse the shared scanner so exitWhen agrees with the `${}` runtime grammar.
  scan(where, c.exitWhen, scope, errors);

  // `exitWhen` is whole-value-REQUIRED: an embedded expression resolves to a
  // STRING, so the loop can never see a boolean and silently burns every round
  // before reporting `capped` (#6 E2; the reducer enforces the same rule at run
  // time, which is what actually binds — see `evalExitWhen`). One classification
  // serves both this rule and the constant rule below.
  const whole = validateWholeValue(where, c.exitWhen, errors, 'exitWhen');
  if (whole === null) return;

  // A CONSTANT is not an exit condition: `${true}` exits the loop after round
  // one and `${false}` never exits at all (it degrades to the maxRounds cap).
  // Literals only became parseable at #6 E1 — before that they failed as
  // unresolvable refs, so the ref-scan above caught them for free. It no longer
  // does, hence this explicit rule. Checking the WHOLE-VALUE body (not every
  // match) also makes it precise: `x=${true}` is an embedding defect, already
  // reported as such above, and is no longer double-reported as a constant.
  let parsed: Expr;
  try {
    parsed = parseExpr(whole.body);
  } catch {
    return; // malformed — already reported by `scan` above
  }
  if (parsed.kind === 'str' || parsed.kind === 'num' || parsed.kind === 'bool') {
    errors.push(
      `${where}: exitWhen must reference child outputs, not the constant ` +
        `\${${whole.body.trim()}}`,
    );
    return; // a constant is one defect; don't also report its type
  }

  // THE FIELD TYPE (#6 E6). `exitWhen` needs a BOOLEAN, and this is the check
  // E2 deferred here when it split the rule: E2 owns the MODE (is it a
  // whole-value `${expr}`?), E6 owns the TYPE (does that expr yield a boolean?).
  //
  // The case this exists for: a bare `${nodes.check.status}` resolves to the
  // string 'success', which is never boolean-true, so the loop burned every
  // round and reported the misleading `capped`. The usable form is
  // `${equals(nodes.check.status, 'success')}`.
  //
  // The write path refuses this now (#444), but rows written before that gate
  // were never validated — `evalExitWhen` throws on the same defect at RUN time,
  // which is what binds for those. Both halves or the rule is decorative.
  const type = inferExprType(parsed, scope);
  if (!assignableTo(type, 'boolean')) {
    errors.push(
      `${where}: exitWhen must be a boolean expression, got ${type} — ` +
        `wrap it in a comparison (e.g. \${equals(${whole.body.trim()}, 'success')})`,
    );
  }
}

/**
 * #4 A4 — SAVE-TIME half of the `foreach.items` rule (the reducer's
 * `evalForeachItems` is the run-time half that BINDS for a pre-gate row). Enforces
 * the CHECKABLE defects: `items` is a whole-value `${}` expression (an interpolated
 * or literal `items` can only be a STRING, never the array the body iterates), its
 * grammar/fn allowlist/param/secret/output-NAME refs are valid, and it does NOT
 * reference `${item}` (unbound: items is evaluated BEFORE any item exists) or its
 * OWN children (whose outputs do not exist until the body runs).
 *
 * SCOPE IS OUTER: `items` is evaluated over the container's upstream, so its
 * availability is the container ENDPOINT's own dominance set (#567 — `computeGraph`
 * now models container graph position). A ref to a genuinely un-dominating upstream
 * node is caught at SAVE (not deferred to `evalForeachItems`' run-time
 * `invalid_event`). Own-children are excluded FOR FREE: a child runs only after the
 * container enters, so it can never be a forward-ancestor of the container endpoint
 * (no child→container forward edge survives the partition), hence never in
 * `guaranteed`/`reachable` of `c.id`.
 */
function validateForeachItems(
  c: Container,
  declared: Map<string, Param>,
  outputsById: Map<string, OutputContract>,
  graph: Graph,
  errors: string[],
): void {
  if (c.items === undefined) return;
  const where = `container.${c.id}.items`;
  // The container endpoint's real OUTER dominance sets (#567). `soft` is node-only,
  // so a container id has no soft entry (`?? ∅`) — `items` has no default()-round
  // semantics anyway.
  const scope: ScanScope = {
    declared,
    outputsById,
    guaranteed: graph.guaranteed.get(c.id) ?? new Set<string>(),
    settled: graph.settled.get(c.id) ?? new Set<string>(),
    reachable: graph.reachable.get(c.id) ?? new Set<string>(),
    soft: graph.soft.get(c.id) ?? new Set<string>(),
  };
  // `itemInScope` defaults false → a `${item}` in `items` is refused for free.
  scan(where, c.items, scope, errors);

  // `items` is whole-value-REQUIRED, mirroring `exitWhen`: an embedded expression
  // resolves to a STRING, so the body would iterate the string's characters (or
  // `evalForeachItems` throws) — never the intended array.
  validateWholeValue(where, c.items, errors, 'items');
}

/**
 * Detect a cycle in the FORWARD edge graph (all edges except `back:true`), over
 * node + container endpoints. Kahn's algorithm: any endpoint left with residual
 * in-degree after the topological sweep sits in (or downstream of) a cycle.
 * Returns a single error naming those endpoints, or `[]` when the graph is a DAG.
 */
function forwardCycleErrors(
  doc: Pick<PipelineVersion, 'nodes' | 'edges'>,
  containers: Container[],
): string[] {
  const endpoints = new Set<string>([
    ...doc.nodes.map((n) => n.id),
    ...containers.map((c) => c.id),
  ]);
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of endpoints) {
    adj.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of doc.edges) {
    if (e.back) continue;
    if (!endpoints.has(e.from) || !endpoints.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...endpoints].filter((id) => (indeg.get(id) ?? 0) === 0);
  let removed = 0;
  while (queue.length) {
    const id = queue.shift() as string;
    removed += 1;
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 0) - 1;
      indeg.set(nxt, d);
      if (d === 0) queue.push(nxt);
    }
  }
  if (removed >= endpoints.size) return [];
  const stuck = [...endpoints].filter((id) => (indeg.get(id) ?? 0) > 0).sort();
  return [
    `forward cycle detected involving {${stuck.join(', ')}} — the forward graph must be a ` +
      'DAG (mark a loop edge back:true with a maxBounces cap)',
  ];
}

/**
 * Forward reachability over the doc's forward edges (node OR container
 * endpoints), PLUS containment: a container reaches (encloses) its own
 * children, so a back-edge from a child to its enclosing loop/stage counts the
 * container as an ancestor.
 */
function forwardReach(
  doc: Pick<PipelineVersion, 'nodes' | 'edges'>,
  containers: Container[],
): Map<string, Set<string>> {
  const endpoints = new Set<string>([
    ...doc.nodes.map((n) => n.id),
    ...containers.map((c) => c.id),
  ]);
  const adj = new Map<string, string[]>();
  for (const id of endpoints) adj.set(id, []);
  for (const e of doc.edges) {
    if (e.back) continue;
    if (endpoints.has(e.from) && endpoints.has(e.to)) adj.get(e.from)!.push(e.to);
  }
  for (const c of containers) {
    for (const ch of c.children) if (endpoints.has(ch)) adj.get(c.id)!.push(ch);
  }
  const reach = new Map<string, Set<string>>();
  for (const id of endpoints) {
    const seen = new Set<string>();
    const stack = [...(adj.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
    }
    reach.set(id, seen);
  }
  return reach;
}

/**
 * The literal (non-`${}`) call targets of a set of nodes — a dynamic id cannot
 * be resolved at save time, so it is skipped by the cycle/depth analysis.
 *
 * Classified through the mode SSOT rather than a bare `includes('${')`: that
 * test read a `$${`-escaped id as dynamic and dropped it from the call graph,
 * silently exempting it from the cycle + depth checks. `literal` mode also means
 * the target is the UNESCAPED text, which is the id the run would actually call.
 */
function literalCallTargets(nodes: Pick<Node, 'call'>[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.call === undefined) continue;
    const mode = interpolationMode(n.call.pipelineVersionId);
    if (mode.mode === 'literal') out.push(restoreEscapes(mode.scanned));
  }
  return out;
}

/**
 * Refuse a `call_pipeline` cycle / a path deeper than `maxCallDepth`. A direct
 * self-call is caught from `selfId` alone; the broader graph needs a
 * `resolvePipeline` to fetch each callee's `nodes` (a dynamic `${}` target is
 * skipped — it cannot be resolved at save time).
 */
function validateCallGraph(
  doc: Pick<PipelineVersion, 'nodes'>,
  options: ValidateDocOptions,
): string[] {
  const errors: string[] = [];
  const maxDepth = options.maxCallDepth ?? 3;
  const { selfId, resolvePipeline } = options;

  if (selfId !== undefined) {
    for (const t of literalCallTargets(doc.nodes)) {
      if (t === selfId)
        errors.push(`call_pipeline cycle: a node calls its own version '${selfId}'`);
    }
  }
  if (resolvePipeline === undefined || selfId === undefined) return errors;

  // `depth` counts call HOPS from this version (root = 0). `maxDepth` hops are
  // allowed; entering a version deeper than that is an error.
  const path: string[] = [selfId];
  const dfs = (pvId: string, nodes: Pick<Node, 'call'>[], depth: number): void => {
    if (depth > maxDepth) {
      errors.push(`call_pipeline depth exceeds ${maxDepth} at version '${pvId}'`);
      return;
    }
    for (const t of literalCallTargets(nodes)) {
      if (path.includes(t)) {
        errors.push(`call_pipeline cycle: version '${t}' is reachable from itself`);
        continue;
      }
      const childDoc = resolvePipeline(t);
      if (childDoc === undefined) continue; // unresolvable callee — not analyzable
      path.push(t);
      dfs(t, childDoc.nodes, depth + 1);
      path.pop();
    }
  };
  dfs(selfId, doc.nodes, 0);
  return errors;
}

interface ScanScope {
  declared: Map<string, Param>;
  /** Node ids whose SUCCESS (outputs) is guaranteed on every path here. */
  guaranteed: Set<string>;
  /**
   * Node ids guaranteed TERMINAL here — the availability rule for
   * `${nodes.<id>.status}`. A SUPERSET of `guaranteed` in the ordinary case (a
   * node whose outputs are readable has necessarily settled), but not derivable
   * from it: the two answer different questions, and `settled` is deliberately
   * empty in shapes where `guaranteed` is not (a looping doc).
   *
   * REQUIRED, not optional: an omitted set reads as "nothing is settled" and
   * would silently reject every status ref in that scope, so the compiler must
   * force each call site to make the choice explicitly.
   */
  settled: Set<string>;
  /** Node ids that MAY run before this one on some path (forward-reachable). */
  reachable: Set<string>;
  /** Back-edge-visible sibling node ids — readable only inside `default()`. */
  soft: Set<string>;
  /**
   * Producer node id → its DECLARED outputs (from `config.outputs`), or `null`
   * when it declares no contract. A `${nodes.X.output.NAME}` whose NAME is
   * absent from a non-`null` list can only fail at run time, so it is rejected
   * (req c). Absent from the map (or `undefined`) → no name-check for that id.
   *
   * Carries the full `{name, type}` — ONE map serving both the name-check and
   * E6's type inference, per `outputs.ts`'s SSOT rule. A second, type-only map
   * could drift from this one about which outputs a node declares.
   *
   * Only a `declared` contract carries enforceable names/types: `absent` has no
   * contract, and `invalid` is reported once by `validateDoc` (below) rather
   * than manufacturing a second error per ref against a contract that is
   * already known to be corrupt (#1 F13a).
   *
   * NOTE that "reported by `validateDoc`" is a claim about the CALLER: a
   * `validateRefs`-only caller (it is separately exported) gets no such report,
   * and ref-name checking against a corrupt contract stays silently disabled for
   * it. The live authoring path calls both (`web/.../canvasDoc.ts`). The
   * run-time refusal in the reducer is what makes that safe rather than
   * fail-open.
   */
  outputsById?: Map<string, OutputContract>;
  /**
   * #5 S11b — whether `${trigger.windowStart/End}` (`TRIGGER_WINDOW_FIELDS`)
   * are legal in this scan. TRUE only for a trigger's param-binding scan
   * (`validateTriggerBindings` with `windowFields: true` — the field-level
   * write gate; the MODE-scoped half, tumbling-only, is the route's cross-field
   * assert via `windowBindingErrors`). Absent/false everywhere else — a node
   * config cannot know its firing trigger's mode at save, so the ref is refused
   * there with a message naming the binding surface.
   */
  windowFieldsInScope?: boolean;
  /**
   * #2 L10a — whether `${tool.args.*}` is legal in this scan, and against which
   * declared parameters. PRESENT only for a tool expression's scan
   * (`scanLlmToolRefs`): the map carries each declared parameter's lowered
   * `SigType` for E6 typing, and membership is the declared-name check. Absent
   * everywhere else — an ordinary config field has no tool call in flight, so
   * the ref is refused with a message naming the legal surface.
   */
  toolArgTypes?: ReadonlyMap<string, SigType>;
}

/**
 * A ROOT RESTRICTION for a scan (#5 S12b, generalized for #2 L10a): `roots` is
 * the closed set of legal root kinds; `describe` is the caller-worded refusal
 * ("a trigger param binding may reference only ${trigger.*} (the fire-time
 * trigger context)") that `checkExprStatic` completes with ", not ${<shown>}".
 * Carried as ONE object so a second restricted surface (a tool expression)
 * cannot inherit another surface's wording.
 */
interface RootRestriction {
  roots: ReadonlySet<RefRoot['kind']>;
  describe: string;
}

function scan(
  where: string,
  value: unknown,
  scope: ScanScope,
  errors: string[],
  depth = 0,
  // A root restriction (#5 S12b), threaded UNCHANGED through every recursion so
  // a nested binding value (`{a: {b: "${params.x}"}}`) is restricted the same as
  // a top-level one. Undefined (`validateRefs`/`validateExitWhen`) = all roots.
  allowedRoots?: RootRestriction,
  // Whether `${item}` is bound at this field's top level (#4 A4): true for a
  // node scanned as a `foreach` body child, so `${item}` is accepted here the
  // same way a `filter`/`map`/`count` lambda arg accepts it. Threaded UNCHANGED
  // through the config tree (a nested `{a: "${item}"}` in a foreach child is
  // still in scope). Default false = the pre-A4 doc-wide behaviour.
  itemInScope = false,
): void {
  // Bound the config-TREE recursion so a pathologically nested config is
  // reported as a collected error, never a raw `RangeError` this pure validator
  // is not contracted to throw (the SAVE half of #537, paired with `substitute`
  // on the RUN half). `scanSecretSinks` caps the sibling `{$secret}` walk.
  if (depth > MAX_CONFIG_DEPTH) {
    errors.push(`${where}: config nested too deep (over ${MAX_CONFIG_DEPTH} levels)`);
    return;
  }
  if (typeof value === 'string') {
    // The same classifier `substitute` reads, so the runtime and static paths
    // agree on where a `${...}` body ends. `matches` is populated in every mode,
    // so this scan is mode-AGNOSTIC: it checks every ref the field contains,
    // whether the field is whole-value or interpolated.
    const mode = interpolationMode(value);
    if (mode.unterminatedAt !== null) {
      errors.push(`${where}: unterminated \${ reference`);
    }
    for (const m of mode.matches) {
      checkExprStatic(
        parseExprSafe(m.body, where, errors),
        scope,
        errors,
        where,
        false,
        itemInScope,
        allowedRoots,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      scan(`${where}[${i}]`, v, scope, errors, depth + 1, allowedRoots, itemInScope),
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      scan(
        `${where}.${key}`,
        (value as Record<string, unknown>)[key],
        scope,
        errors,
        depth + 1,
        allowedRoots,
        itemInScope,
      );
    }
  }
}

/** The only expression root a trigger param binding may reference (#5 S12b). */
const TRIGGER_BINDING_ROOTS: RootRestriction = {
  roots: new Set(['trigger']),
  describe:
    'a trigger param binding may reference only ${trigger.*} (the fire-time trigger context)',
};

/** #2 L10a — the only expression root an llm_call tool expression may reference. */
const TOOL_EXPRESSION_ROOTS: RootRestriction = {
  roots: new Set(['tool']),
  describe:
    'a tool expression may reference only ${tool.args.*} (the model-supplied tool-call arguments)',
};

/**
 * SAVE-TIME validation of a trigger's expression-valued param BINDINGS (#5
 * S12b). Every `${...}` in a `trigger.params` value must parse AND reference
 * ONLY the `${trigger.*}` root — the sole facts that exist at fire time. A
 * `${params.*}`/`${nodes.*}`/`${run.*}`/`${item}` binding is refused (they name
 * a run's own state, which the trigger predates). Returns error strings (`[]` =
 * valid); the write schema surfaces them as Zod issues.
 *
 * REUSES the one `scan`/`checkExprStatic` machinery `validateRefs` runs, via the
 * `allowedRoots` restriction — so the fn allowlist, arity, arg-typing, path-depth
 * and grammar rules are enforced identically and can never drift from a
 * hand-rolled second walker. The scope is EMPTY (no declared params, no graph):
 * a trigger has no nodes/params of its own, and any node/param ref is refused by
 * the root restriction before the scope is ever consulted.
 *
 * A ROOTLESS expression (`${upper('x')}`, `${add(1, 2)}`) is ACCEPTED: the rule
 * is "no root OTHER than trigger", and a pure-function binding references no
 * fire-time-absent fact. `substitute` resolves it at fire time like any other.
 *
 * `windowFields` (#5 S11b) puts `${trigger.windowStart/End}` in scope. The
 * FIELD-level write gate (`TriggerParamsWriteSchema`) passes TRUE — it cannot
 * see the trigger's `mode`, so the tumbling-only half of the rule is the
 * route's cross-field assert against the effective post-write state, via
 * `windowBindingErrors` below (the `assertWindowConsistent` pattern).
 */
export function validateTriggerBindings(
  params: Record<string, unknown>,
  opts?: { windowFields?: boolean },
): string[] {
  const errors: string[] = [];
  const scope: ScanScope = {
    declared: new Map(),
    guaranteed: new Set(),
    settled: new Set(),
    reachable: new Set(),
    soft: new Set(),
    windowFieldsInScope: opts?.windowFields === true,
  };
  for (const [name, value] of Object.entries(params)) {
    scan(`params.${name}`, value, scope, errors, 0, TRIGGER_BINDING_ROOTS);
  }
  return errors;
}

/**
 * The `${trigger.windowStart/End}` references in a trigger's param bindings —
 * as context-scoped error strings, `[]` when none (#5 S11b). The MODE-scoping
 * primitive: the route's cross-field assert (and the import guard) refuse a
 * NON-tumbling trigger whose bindings reference window fields, against the
 * effective post-write state where `mode` is known.
 *
 * Implemented as the SET DIFFERENCE of two runs of the one scan — restricted
 * (`windowFields: false`) minus permissive (`windowFields: true`). The flag's
 * ONLY message-visible effect is the context-scoped arm of `checkRefRoot`
 * (every OTHER message — a disallowed root, a typo'd unknown field, a grammar
 * error — is scope-independent BY CONSTRUCTION: the unknown-field enumeration
 * deliberately lists all five fields in both scopes), so the difference is
 * exactly the window-field defects: a stored binding's unrelated errors
 * (`${params.x}`, a `${trigger.nope}` typo) appear in BOTH runs, string-equal,
 * and cancel — a mode/enabled-only PATCH on such a row is never refused for
 * noise it did not introduce. Kept HERE, next to the arm that creates the
 * delta, so the invariant and its unit test live in one file.
 */
export function windowBindingErrors(params: Record<string, unknown>): string[] {
  const permitted = new Set(validateTriggerBindings(params, { windowFields: true }));
  return validateTriggerBindings(params, { windowFields: false }).filter((e) => !permitted.has(e));
}

/**
 * Parse an expr for static checking. A malformed body is reported ONCE, here,
 * and yields an inert literal — `checkExprStatic` returns early on a literal,
 * so the caller adds no second, misleading error. (A null-ish REF would be
 * walked as a reference and re-reported as `unresolvable reference ${}`,
 * naming an empty ref that appears nowhere in the doc.)
 */
function parseExprSafe(body: string, where: string, errors: string[]): Expr {
  try {
    return parseExpr(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${where}: ${msg}`);
    return { kind: 'str', value: '' };
  }
}

/**
 * Every node's output CONTRACT, keyed by id — the shape `ScanScope.outputsById`
 * wants. One helper so `validateRefs` and `validateExitWhen` build it the same
 * way and cannot disagree about a node's contract.
 */
function outputsByIdOf(
  nodes: readonly Node[],
  containers: readonly Container[] = [],
): Map<string, OutputContract> {
  const m = new Map<string, OutputContract>();
  for (const node of nodes) m.set(node.id, outputContract(node));
  // #567: container endpoints are first-class producers. A foreach declares
  // `results`; loop/stage carry an `absent` (dynamic) contract (name-unchecked).
  for (const c of containers) m.set(c.id, containerOutputContract(c));
  return m;
}

/**
 * Infer an expression's RESULT type (#6 E6). `any` means "not statically known"
 * — `assignableTo` accepts it in both directions, so an `any` never causes a
 * refusal. That is the safe default here: there is no cast function, so a
 * false-REJECT has no author workaround.
 *
 * The rule for a ref the surrounding `checkExprStatic` ALREADY errored on is
 * `any` — one defect, one error. Inference never adds a second, type-flavoured
 * report for a ref that is simply unresolvable.
 *
 * `itemInScope` is not a parameter: an `${item}` path infers `any` wherever it
 * appears (E4 decided the element shape is run-time-only — `SigType` has no
 * element type), and its SCOPE is `checkExprStatic`'s to police.
 */
function inferExprType(expr: Expr, scope: ScanScope): SigType {
  if (expr.kind === 'str') return 'string';
  if (expr.kind === 'num') return 'number';
  if (expr.kind === 'bool') return 'boolean';
  if (expr.kind === 'call') {
    // An unknown fn is already reported; `any` keeps it to that one error.
    return FUNCTIONS[expr.name]?.ret ?? 'any';
  }

  // A reference. `refRoot` is the SSOT for segmentation — never split `source`.
  const root = refRoot(leadingFields(expr.segments));
  if (root === null) return 'any'; // unresolvable — already reported

  // A DEEP path is `any` (#6 E7, spec L111): it addresses into a `json`/`any`
  // value, which has no element type to infer (E4). `assignableTo` waves `any`
  // through both ways, so the escape hatch never false-rejects downstream — the
  // walk validates it at run time instead.
  if (expr.segments.length > root.arity) return 'any';
  return refRootType(root, scope);
}

/**
 * The static type of a reference's ROOT value — before any deep addressing.
 *
 * Split out of `inferExprType` at E7 because the SCALAR-ROOT rule needs it: a
 * deep path is FOR a `json`/`any` root (spec L48), so `checkExprStatic` must ask
 * for the root's own type even where the whole expression infers `any`.
 */
function refRootType(root: RefRoot, scope: ScanScope): SigType {
  switch (root.kind) {
    case 'item':
      return 'any'; // element shape is run-time-only (E4)
    case 'params': {
      const decl = scope.declared.get(root.name);
      // Undeclared (reported) and secret (reported, and never substituted) both
      // fall to `any` rather than manufacturing a second error.
      return decl === undefined ? 'any' : sigOfDeclared(decl.type);
    }
    case 'nodeOutput': {
      const contract = scope.outputsById?.get(root.id);
      // No contract (`absent`), a corrupt one (`invalid` — reported once by
      // validateDoc), producer not in the map, or a name the producer does not
      // declare (reported already) → no static type.
      if (contract?.kind !== 'declared') return 'any';
      const out = contract.outputs.find((d) => d.name === root.name);
      return out === undefined ? 'any' : sigOfDeclared(out.type);
    }
    // A status is the STRING 'success'|'failure'|'skipped' — typed even when it
    // is unavailable here (availability is a separate, already-reported
    // question). This is what makes a bare `${nodes.x.status}` a rejectable
    // `exitWhen`.
    case 'nodeStatus':
      return 'string';
    // Every `RUN_FIELDS` member is a string. `run.triggerId` is now seeded from
    // the `run.triggerContext` fact (#5 S12); `parentRunId` is still reducer-null
    // until a child-run seed carries it. Typing a nullable field `any` instead
    // would be strictly WEAKER, not safer: `any` additionally accepts
    // `${add(run.parentRunId, 1)}`, and the run-time null throws under either
    // typing. No static type here can paper over the nullability — `SigType` has
    // no null.
    case 'run':
      return (RUN_FIELDS as readonly string[]).includes(root.field) ? 'string' : 'any';
    // `${trigger.<field>}` (#5 S12). `triggerId`/`scheduledTime` are strings
    // (nullable at run time, same as the nullable `run` fields above); `body` is
    // an untyped `json` payload, so it is `any` — the escape hatch that lets
    // `${trigger.body.x}` deep-address (the walk validates it at run time, E7).
    // An unknown field also falls to `any` — `checkRefRoot` reports it once, and
    // this avoids manufacturing a second error.
    case 'trigger':
      if (root.field === 'body') return 'any';
      // `windowStart`/`windowEnd` (#5 S11b) type 'string' like the other
      // timestamp fields — typing is scope-independent (an out-of-scope ref is
      // already refused by `checkRefRoot`; `any` here would only weaken the
      // in-scope check, per the `run` note above).
      return (TRIGGER_FIELDS as readonly string[]).includes(root.field) ||
        (TRIGGER_WINDOW_FIELDS as readonly string[]).includes(root.field)
        ? 'string'
        : 'any';
    // `${tool.args.<name>}` (#2 L10a) — the declared parameter's lowered type
    // (string/number/boolean; object/array lower to `json` → `any`, the E7 deep-
    // addressing escape hatch). Out of scope / undeclared falls to `any` —
    // `checkRefRoot` reports it once. NOTE an OPTIONAL parameter is present-null
    // at run (`validateStructuredOutput`); `SigType` has no null, so a null that
    // reaches a typed position throws at run — the same recorded posture as the
    // nullable `run` fields above.
    case 'tool':
      return scope.toolArgTypes?.get(root.name) ?? 'any';
  }
}

/**
 * Static-check ONE parsed expression. Mirrors `evalExpr`'s grammar exactly — if
 * this accepts, resolution can only fail on run-time-only facts.
 *
 * `softOk` is true only inside the arg a fn declares as `staticSoftArg`
 * (`default`'s first — the one place a back-edge or non-dominating node output
 * may be read). `itemInScope` is true only inside a `lambdaArgs` position, where
 * `${item}` is bound.
 *
 * Both come from the CATALOG rather than a name check, so the checker and the
 * evaluator read one declaration of each fn's convention.
 *
 * DELIBERATELY NOT relaxed for `and`/`or`/`if`, which short-circuit at run time:
 * this checker cannot know that arg0 is `false`, so treating their later args as
 * soft would equally accept `${and(true, nodes.a.output.v)}` — a doc that passes
 * save and then THROWS at run with no escape hatch. Over-refusing is safe; a
 * false-accept here is not (the same call E3 made for `${nodes.x.status}`).
 */
function checkExprStatic(
  expr: Expr,
  scope: ScanScope,
  errors: string[],
  where: string,
  softOk: boolean,
  itemInScope = false,
  allowedRoots?: RootRestriction,
): void {
  if (expr.kind === 'str' || expr.kind === 'num' || expr.kind === 'bool') return;
  if (expr.kind === 'call') {
    const spec = FUNCTIONS[expr.name];
    if (spec === undefined) {
      errors.push(`${where}: unknown function '${expr.name}' (allowed: ${allowedFnNames()})`);
      return;
    }
    const { min, max } = arity(spec);
    if (expr.args.length < min || (max !== null && expr.args.length > max)) {
      errors.push(
        `${where}: function '${expr.name}' arity: expected ${arityText(min, max)}, ` +
          `got ${expr.args.length}`,
      );
    }
    const lambdas = spec.lambdaArgs ?? [];
    expr.args.forEach((a, i) => {
      checkExprStatic(
        a,
        scope,
        errors,
        where,
        i === spec.staticSoftArg,
        // `item` stays in scope for anything nested inside a lambda arg; a
        // SIBLING arg of the same call does not inherit it.
        itemInScope || lambdas.includes(i),
        // A root restriction (#5 S12b) applies to a ref nested under a call too:
        // `${default(params.x, 'fb')}` in a trigger binding must still reject
        // the `${params.x}` root.
        allowedRoots,
      );
      // ARG TYPING (#6 E6) — the save-time mirror of run-time `checkArgTypes`,
      // reading the same `spec.args` with the same variadic-tail rule, so the
      // two cannot disagree about which type a position wants. It fires for
      // `special` fns too: their `args` describes what `run` enforces itself
      // (`filter`'s `expectBool` on the predicate), and only the EAGER path goes
      // through `checkArgTypes`.
      //
      // Reports only where BOTH sides are known — `assignableTo` waves `any`
      // through in either direction.
      //
      // It is NOT true that this only rejects what the run-time check would also
      // reject: `${and(false, 'x')}` short-circuits to `false` at run and never
      // type-checks arg 2, but is rejected here. That over-refusal is E4's
      // recorded position, pinned by `functions.test.ts`'s "laziness does NOT
      // relax the static checker" — the checker cannot know arg0 is `false`, and
      // relaxing it would equally accept `${and(true, 'x')}`, which THROWS at run
      // with no escape hatch. Over-refusing a short-circuited arg is safe; that
      // false-accept is not.
      const actual = inferExprType(a, scope);
      if (!assignableTo(actual, argSigAt(spec, i))) {
        errors.push(
          `${where}: function '${expr.name}': argument ${i + 1} must be a ` +
            `${argSigAt(spec, i)}, got ${actual}`,
        );
      }
    });
    return;
  }

  // A reference. `refRoot` is the SSOT for what a path names (never split
  // `source`: a quoted index `m['b.c']` is one segment but two dot-parts).
  const root = refRoot(leadingFields(expr.segments));
  if (root === null) {
    // Includes an index in the ROOT region (`${nodes[params.i].output.x}`):
    // `leadingFields` stops at the first index, so nothing matches. Refused at
    // save AND run, so the secret rule needs no recursion here — an index expr
    // in the root region never resolves. Only a TAIL index does; see below.
    errors.push(`${where}: unresolvable reference \${${expr.source}}`);
    return;
  }
  // #5 S12b — ROOT RESTRICTION. When a caller restricts which roots are legal
  // (a trigger param binding may reference ONLY `${trigger.*}` — the sole facts
  // that exist at fire time), a ref whose root is outside the set is refused
  // here, EARLY: returning before `pathDepthDefect`/tail-index/`checkRefRoot`/
  // the scalar-root rule keeps a disallowed deep ref like `${run.x.y}` to ONE
  // error rather than also tripping "deep addressing needs a json/any value".
  // Undefined (every ordinary caller) = all roots allowed, so this is inert
  // outside the binding gate. `refRoot` above already turned the segments into
  // a root; `checkRefRoot` (below) still validates the field of an ALLOWED root.
  if (allowedRoots !== undefined && !allowedRoots.roots.has(root.kind)) {
    // Name the offending root as the AUTHOR wrote it: the two node kinds share
    // the `nodes` namespace, and `item` has no dot-form (it is `${item}`, never
    // `${item.*}`) — so render it bare rather than as a namespace prefix.
    const ns = root.kind === 'nodeOutput' || root.kind === 'nodeStatus' ? 'nodes' : root.kind;
    const shown = ns === 'item' ? '${item}' : `\${${ns}.*}`;
    errors.push(`${where}: \${${expr.source}} — ${allowedRoots.describe}, not ${shown}`);
    return;
  }
  const tooDeep = pathDepthDefect(expr);
  if (tooDeep !== null) {
    errors.push(`${where}: ${tooDeep}`);
    return;
  }
  const tail = expr.segments.slice(root.arity);

  // #6 E7 — WALK EVERY TAIL INDEX EXPR. Pre-E7 this branch returned before
  // reaching an index's own sub-expression, which was sound only while the ref
  // itself was refused. Now that `[]` RESOLVES, skipping the recursion would put
  // a real hole in the rules below: a secret-typed `${params.tok}` smuggled into
  // `${nodes.a.output.rows[params.tok]}` would go unreported.
  //
  // `softOk`/`itemInScope` are THREADED from this ref's own position, mirroring
  // the runtime exactly: `default`'s `ev.soft` wraps the WHOLE arg-0 evaluation,
  // so a `MissingValueError` raised from an index expr IS rescued at run — and
  // forcing `false` here would manufacture a false-reject.
  for (const seg of tail) {
    if (seg.kind !== 'index') continue;
    checkExprStatic(seg.expr, scope, errors, where, softOk, itemInScope, allowedRoots);
    // And TYPE it. `stepIndex` refuses a non-number/non-string index for EVERY
    // container shape, before it even splits array-vs-object, so an index whose
    // type is statically KNOWN to be boolean/array can never resolve for any
    // data — a TRUE-reject, exactly like the scalar-root rule below, and the
    // same call the sibling arg-typing 40 lines up already makes.
    //
    // `number`/`string`/`any` all stay open, and that is not conservatism: the
    // indexed value is `any`, so it may be an OBJECT at run and a string index
    // its key. `assignableTo` cannot express the `number|string` union, hence the
    // explicit test.
    const idxType = inferExprType(seg.expr, scope);
    if (idxType !== 'any' && idxType !== 'number' && idxType !== 'string') {
      errors.push(
        `${where}: \${${expr.source}} — an index must be a number or a string, got ${idxType}`,
      );
    }
  }

  checkRefRoot(expr, root, scope, errors, where, softOk, itemInScope);

  // #6 E7 — the SCALAR-ROOT rule. Deep addressing is FOR a `json`/`any` value
  // (spec L48: "deep [] / . into a json-typed output = any"). A root whose type
  // is statically KNOWN to be a scalar can never carry a sub-path, so this is a
  // TRUE-reject, not a conservative one: `matchesType` enforces the declared type
  // at `node.succeeded`, so a `string`-declared output cannot hold an object, and
  // `run.*`/`.status` are strings by construction. The run-time walk refuses the
  // same shapes (`stepField`/`stepIndex`), so the rule has both halves.
  //
  // A declared `OutputType` is never `array` (it is `ParamType` minus `secret`),
  // so for a REF the root type is always one of string|number|boolean|any and the
  // `array` case cannot arise here.
  if (tail.length > 0) {
    const rootType = refRootType(root, scope);
    if (rootType !== 'any') {
      errors.push(
        `${where}: \${${expr.source}} — deep addressing needs a json/any value, ` +
          `but this one is a ${rootType}`,
      );
    }
  }
}

/** The availability/declaration rules for a ref's ROOT (`refRoot`'s kinds). */
function checkRefRoot(
  expr: Extract<Expr, { kind: 'ref' }>,
  root: RefRoot,
  scope: ScanScope,
  errors: string[],
  where: string,
  softOk: boolean,
  itemInScope: boolean,
): void {
  // `${item}` (#6 E4) — legal ONLY inside a lambda arg. The ELEMENT'S OWN shape
  // is not checked here: the type vocabulary has no element type, so a misspelled
  // `${item.badField}` is a run-time throw, not an edit-time error (E4's recorded
  // decision — E6 + #2's `OutputSpec` own closing that gap).
  if (root.kind === 'item') {
    if (!itemInScope) {
      errors.push(
        `${where}: \${${expr.source}} — 'item' is only bound inside a ` +
          'filter/map/count predicate or a foreach body',
      );
    }
    return;
  }
  if (root.kind === 'params') {
    const name = root.name;
    const decl = scope.declared.get(name);
    if (decl === undefined) {
      errors.push(`${where}: \${params.${name}} is not a declared param`);
    } else if (decl.type === 'secret') {
      errors.push(
        `${where}: \${params.${name}} is secret-typed — a secret never enters ` +
          'the ${} language (its only sink is the executor env channel)',
      );
    }
    return;
  }
  if (root.kind === 'nodeOutput') {
    const id = root.id;
    const name = root.name;
    // req (c): reject an output NAME the producer does not declare. A bare ref
    // to an absent output can only throw at run time (dispatch-prep fails), so
    // it is invalid regardless of dominance. EXCLUDED inside `default()`'s
    // first arg (`softOk`), where a missing node output is caught and the
    // fallback used — an unknown name resolves fine there, so rejecting it
    // would be a false reject. A producer with no declared contract (`absent`)
    // has no enforceable names; a corrupt one (`invalid`) is reported once by
    // validateDoc; an id absent from the map is not checked.
    const contract = scope.outputsById?.get(id);
    const declaredOuts = contract?.kind === 'declared' ? contract.outputs : null;
    if (!softOk && declaredOuts !== null && !declaredOuts.some((d) => d.name === name)) {
      errors.push(
        `${where}: \${nodes.${id}.output.${name}} — node '${id}' declares no output named '${name}'`,
      );
      return;
    }
    if (scope.guaranteed.has(id)) return; // dominates + succeeded → available
    // KNOWN RESTRICTION (safe false-reject, not fixed here): `softOk` is only
    // threaded to `default()`'s OWN first-arg ref — a non-dominating node
    // output wrapped in another fn call inside that first arg (e.g.
    // `default(slug(nodes.x.output.v), "fb")`) is statically rejected even
    // though `evalExpr`'s `default` case would actually catch the resulting
    // `MissingValueError` at runtime and fall back correctly (the arg is
    // evaluated as a whole before the absence check). Over-refusing here is
    // safe (never a false-accept); a pipeline author must reference the bare
    // node output as `default`'s first arg to satisfy the static checker.
    if (softOk && (scope.reachable.has(id) || scope.soft.has(id))) return;
    if (scope.reachable.has(id) || scope.soft.has(id)) {
      errors.push(
        `${where}: \${nodes.${id}.output.${name}} is not guaranteed here — ` +
          'wrap it in default() (it is reachable only on a failure/completion ' +
          'branch or a loop round, or does not dominate this node)',
      );
    } else {
      errors.push(
        `${where}: \${nodes.${id}.output.${name}} does not name an upstream ` +
          'node (a self, downstream, or unrelated node has no output here)',
      );
    }
    return;
  }
  // `${nodes.<id>.status}` (#6 E3 T6). Availability is `settled` — "is `id`
  // guaranteed TERMINAL here" — NOT `guaranteed`, which asks whether it
  // SUCCEEDED. A status is readable on exactly the failure/completion/skipped
  // paths where an output is not, which is what makes the fan-in/OR pattern
  // expressible at all.
  //
  // `softOk` is deliberately IGNORED: `default()` only rescues a
  // `MissingValueError`, and `resolveRoot` raises a plain `SubstituteError`
  // for an unsettled status, so relaxing the check inside `default()` would
  // accept a doc at save that still THROWS at run — a manufactured false-accept
  // with no escape hatch (the same call E3 made, and the reason the SHAPE half
  // of E7's walk is likewise never rescuable).
  if (root.kind === 'nodeStatus') {
    const id = root.id;
    if (scope.settled.has(id)) return;
    if (scope.reachable.has(id) || scope.soft.has(id)) {
      errors.push(
        `${where}: \${nodes.${id}.status} is not settled here — '${id}' may still be ` +
          'running when this node dispatches (it is reachable only on some paths, ' +
          "sits behind an 'any' join, or lives in a doc whose back-edge can reset it)",
      );
    } else {
      errors.push(
        `${where}: \${nodes.${id}.status} does not name an upstream node ` +
          '(a self, downstream, or unrelated node has no status here)',
      );
    }
    return;
  }
  // `${trigger.<field>}` (#5 S12) — always AVAILABLE (a run-level seed, like
  // `run`/`params`; there is no dominance question), so the only check is that
  // the field is a known one. `softOk` is irrelevant: no trigger field is
  // rescuable-absent — `body` is always present (null when the fire carried
  // none), and a deep miss into it is E7's runtime walk, not a save-time error.
  // `${tool.args.<name>}` (#2 L10a) — context-scoped like the window fields:
  // legal only inside an llm_call tool expression's scan (`toolArgTypes`
  // present), and then only for a parameter that tool declares. `softOk` is
  // irrelevant: an unbound/undeclared tool ref raises a plain `SubstituteError`
  // at run (never `MissingValueError`), so `default()` cannot rescue it and
  // relaxing here would accept a doc that still throws.
  if (root.kind === 'tool') {
    if (scope.toolArgTypes === undefined) {
      errors.push(
        `${where}: \${${expr.source}} is context-scoped — only an llm_call tool ` +
          `expression may reference \${tool.args.*} (the model-supplied tool-call arguments)`,
      );
      return;
    }
    if (!scope.toolArgTypes.has(root.name)) {
      errors.push(
        `${where}: \${tool.args.${root.name}} — this tool declares no parameter named ` +
          `'${root.name}'`,
      );
    }
    return;
  }
  if (root.kind === 'trigger') {
    if ((TRIGGER_FIELDS as readonly string[]).includes(root.field)) return;
    // #5 S11b — the window bounds are CONTEXT-SCOPED: legal only where the
    // tumbling binding is a known save-time fact (a trigger's param bindings,
    // `windowFieldsInScope`). Out of scope gets a message naming the rule and
    // the legal surface — not the generic unknown-field message, which would
    // read as "this field does not exist" when it exists elsewhere.
    if ((TRIGGER_WINDOW_FIELDS as readonly string[]).includes(root.field)) {
      if (!scope.windowFieldsInScope) {
        errors.push(
          `${where}: \${trigger.${root.field}} is context-scoped — only a ` +
            `tumbling trigger's param bindings may reference it (window facts ` +
            `reach a pipeline as params bound there)`,
        );
      }
      return;
    }
    // The enumeration is deliberately SCOPE-INDEPENDENT (all five fields, even
    // where the window pair is out of scope): `windowBindingErrors` is a string
    // set-difference of a restricted and a permissive run, and a scope-dependent
    // message here would make a TYPO'd unknown field differ between the runs and
    // leak into the difference as a phantom "window binding" (pre-PR lens
    // finding). An in-scope-refused window field never reaches this message (the
    // arm above owns it), and listing the pair to a node-config author is honest
    // — the fields exist; the context-scoped arm explains where.
    const known = [...TRIGGER_FIELDS, ...TRIGGER_WINDOW_FIELDS];
    errors.push(
      `${where}: \${trigger.${root.field}} is not a known trigger field (${known.join(', ')})`,
    );
    return;
  }
  if (!(RUN_FIELDS as readonly string[]).includes(root.field)) {
    errors.push(
      `${where}: \${run.${root.field}} is not a known run field (${RUN_FIELDS.join(', ')})`,
    );
  }
}

// --- the graph / dominance helper -------------------------------------------

/**
 * The per-endpoint FORWARD readiness partition, shared by the runtime reducer
 * (`reduce.ts`) and the static availability analysis (`computeGraph`). Both must
 * key readiness/dominance off the SAME edge partition, or the static checker
 * describes a different engine than the one that runs — the #567 drift the SSOT
 * discipline exists to prevent. `reduce.ts` consumes `topIncoming`/`childIncoming`
 * verbatim for its readiness walk; `computeGraph` merges them into its predecessor
 * cone. The equivalence is pinned by test (`readiness-partition.test.ts`).
 *
 * Endpoints = node ids ∪ container ids. A FORWARD edge (both endpoints known,
 * `!back`) is classified:
 *   - INTERNAL — both endpoints children of the SAME container: gates that child's
 *     readiness within its container body (`childIncoming`).
 *   - TOP-LEVEL — between top-level entities (top nodes + container ids): gates the
 *     target (`topIncoming`), EXCEPT a child → its OWN enclosing container id, which
 *     is dropped (it would strand the run — the container must activate before the
 *     child runs; reduce.ts #488). A child → a top-level target IS kept (it still
 *     SKIPS the target when the child does not take it; reduce.ts #480).
 *   - CROSS-BOUNDARY — exactly one endpoint a child, or children of DIFFERENT
 *     containers, with a CHILD target: inert for readiness (reduce.ts #480/#498;
 *     `validateDoc` reports it) — a child target is not a `topIncoming` key, so it
 *     is naturally excluded.
 *
 * This function IS the SSOT (it replaced the reducer's former inline partition):
 * `reduce.ts` and `computeGraph` both CONSUME it rather than re-deriving the rules.
 * `childToContainer` (the membership owner map) is supplied by the caller so each
 * side controls its own neutralization: the reducer passes its `kept`-filtered
 * membership, the static path a fresh `containerMembership(doc.containers)`. A
 * non-node/undeclared child id is absent from `endpointIds`, so every edge touching
 * it is filtered out here regardless. The line references below point at the
 * reducer sites that own the sibling concerns (topOutgoing index + diagnostics).
 */
export interface ReadinessPartition {
  endpointIds: Set<string>;
  backEdges: Edge[];
  internalForwardByContainer: Map<string, Edge[]>;
  topForwardEdges: Edge[];
  /** per top-level entity (top node or container id) → its readiness-gating incoming edges. */
  topIncoming: Map<string, Edge[]>;
  /** per child node id → its within-container readiness-gating incoming edges. */
  childIncoming: Map<string, Edge[]>;
}

export function partitionReadiness(
  doc: Pick<PipelineVersion, 'nodes' | 'edges'>,
  containers: readonly Container[],
  childToContainer: Map<string, string>,
): ReadinessPartition {
  const nodeIds = doc.nodes.map((n) => n.id);
  const containerIds = containers.map((c) => c.id);
  const endpointIds = new Set<string>([...nodeIds, ...containerIds]);
  const childSet = new Set(childToContainer.keys());
  const allEdges = effectiveEdges(doc);
  const forwardEdges = allEdges.filter(
    (e) => !e.back && endpointIds.has(e.from) && endpointIds.has(e.to),
  );
  const backEdges = allEdges.filter(
    (e) => e.back && endpointIds.has(e.from) && endpointIds.has(e.to),
  );

  // INTERNAL (same-container children) vs TOP-LEVEL split (reduce.ts:359-366).
  const internalForwardByContainer = new Map<string, Edge[]>();
  for (const c of containers) internalForwardByContainer.set(c.id, []);
  const topForwardEdges: Edge[] = [];
  for (const e of forwardEdges) {
    const fc = childToContainer.get(e.from);
    const tc = childToContainer.get(e.to);
    if (fc !== undefined && fc === tc) internalForwardByContainer.get(fc)!.push(e);
    else topForwardEdges.push(e);
  }

  // Top-level readiness incoming (reduce.ts:452-481, topIncoming half only — the
  // topOutgoing index + cross-boundary diagnostics stay in the reducer).
  const topLevelNodeIds = nodeIds.filter((id) => !childSet.has(id));
  const topIncoming = new Map<string, Edge[]>();
  for (const id of [...topLevelNodeIds, ...containerIds]) topIncoming.set(id, []);
  for (const e of topForwardEdges) {
    if (childToContainer.get(e.from) === e.to) continue; // #488 child → own container
    const bucket = topIncoming.get(e.to);
    if (bucket !== undefined) bucket.push(e); // a CHILD target (#498) has no bucket → excluded
  }

  // Per-container internal readiness incoming (reduce.ts:490-501).
  const childIncoming = new Map<string, Edge[]>();
  for (const ch of childSet) childIncoming.set(ch, []);
  for (const c of containers) {
    for (const e of internalForwardByContainer.get(c.id)!) childIncoming.get(e.to)!.push(e);
  }

  return {
    endpointIds,
    backEdges,
    internalForwardByContainer,
    topForwardEdges,
    topIncoming,
    childIncoming,
  };
}

interface Graph {
  /** nodeId → node ids whose SUCCESS is guaranteed on every path to it. */
  guaranteed: Map<string, Set<string>>;
  /** nodeId → node ids guaranteed TERMINAL (settled) on every path to it. */
  settled: Map<string, Set<string>>;
  /** nodeId → node ids forward-reachable (may run before it on some path). */
  reachable: Map<string, Set<string>>;
  /** nodeId → back-edge-visible sibling node ids (default()-only reads). */
  soft: Map<string, Set<string>>;
}

/**
 * Build the availability model over nodes + edges. Back-edges (`back: true`) are
 * excluded from forward analysis (their outputs are "from the future" and only
 * default()-readable). Edge-less docs synthesize the implicit success-chain over
 * node array order — one engine, both shapes.
 *
 * `guaranteed[R]` is a MUST-analysis (intersection at joins): a node X is in it
 * iff every path from a root to R passes through X AND continues via an
 * X→success edge (so X actually succeeded and its outputs exist). That is
 * exactly "X dominates R on the success graph" — the spec's dominance rule.
 */
function computeGraph(doc: Pick<PipelineVersion, 'nodes' | 'edges' | 'containers'>): Graph {
  // Endpoints = node ids ∪ container ids (#567). Container endpoints are FIRST-CLASS
  // producers here — a `${nodes.<container>.output.*}` ref resolves against the
  // container's real graph position, matching the reducer, which already keys
  // readiness off exactly this partition (`partitionReadiness`, the shared SSOT).
  const nodeIds = doc.nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const containers = doc.containers ?? [];
  const childToContainer = containerMembership(containers).owner;
  const part = partitionReadiness(doc, containers, childToContainer);
  const endpointIds = part.endpointIds;
  // Merged per-endpoint incoming: a top entity draws from `topIncoming`, a child
  // from `childIncoming` (an endpoint is exactly one of the two).
  const incomingOf = (id: string): Edge[] =>
    part.topIncoming.get(id) ?? part.childIncoming.get(id) ?? [];
  // Flattened forward edges (partition-correct) for the topo succ-decrement.
  const forwardForWalk: Edge[] = [];
  for (const id of endpointIds) for (const e of incomingOf(id)) forwardForWalk.push(e);

  // `soft` + `back` stay NODE-ONLY (#567): a container-targeted back-edge would be
  // the one LOOSENING direction (a new `default()`-visible source), and #567 needs
  // neither back nor soft widened. A node-only `back` matches the pre-#567 behaviour
  // exactly (a child→container back-edge was already dropped when idSet was nodes).
  const back = doc.edges.filter((e) => e.back && nodeIdSet.has(e.from) && nodeIdSet.has(e.to));

  // Endpoints whose readiness draws on an UNTRACKED predecessor — an edge from an
  // id that is neither a node nor a container (a dangling reference `validateDoc`
  // rejects). Real containers are now TRACKED, so their any-join is handled by the
  // genuine intersection below (which excludes a still-running sibling — the correct
  // conservative any-join answer). This guard survives only as a fail-safe for a
  // malformed doc reaching `validateRefs` on its own: an unseen `any`-join
  // predecessor is a FALSE-ACCEPT risk (the endpoint dispatches while a tracked
  // sibling is still running), so its guaranteed/settled are zeroed.
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const containerById = new Map(containers.map((c) => [c.id, c]));
  const joinOf = (id: string): 'all' | 'any' => {
    const c = containerById.get(id);
    if (c !== undefined) return containerJoin(c);
    const n = nodeById.get(id);
    return n !== undefined ? nodeJoin(n) : 'all';
  };
  const untrackedAnyJoin = new Set<string>();
  for (const e of effectiveEdges(doc)) {
    if (e.back || !endpointIds.has(e.to) || endpointIds.has(e.from)) continue;
    if (joinOf(e.to) === 'any') untrackedAnyJoin.add(e.to);
  }

  // A doc that can RE-RUN a node cannot support a stable `settled` answer: a
  // node that had settled goes back to `pending` mid-run while a node outside
  // the re-run body stays ready and dispatches. Rather than model that, `settled`
  // is refused doc-wide for such a doc (see `Graph.settled`).
  //
  // The reducer resets nodes from TWO places, and both must be covered — missing
  // either is a FALSE-ACCEPT, the one direction that is never safe here:
  //   - `fireBackEdges` → `resetNodes`, for a `back:true` edge; and
  //   - `resetContainerRound` → `resetNodes(state, c.children)`, when a LOOP
  //     container starts another round. A loop re-rounds off `exitWhen`/
  //     `maxRounds` alone and carries NO back-edge, so an edge-only test misses
  //     it entirely (verified by test: a loop child's status accepted at save,
  //     then killing the run with `invalid_event` at dispatch).
  // A `foreach` (#4 A4) re-runs its children exactly the same way — one round per
  // item, via the SAME `resetContainerRound`→`resetNodes` — so it must disable
  // status refs identically, or a `${nodes.<foreachChild>.status}` is false-
  // accepted at save and then killed `invalid_event` at dispatch. A `stage` never
  // re-rounds (`stepContainers` exits it once its children are terminal), so it
  // must NOT disable status refs.
  const canReRunNodes =
    doc.edges.some((e) => e.back === true) ||
    doc.containers.some((c) => c.kind === 'loop' || c.kind === 'foreach');

  // Predecessors (forward), for reachability + the must-analysis. Keyed over ALL
  // endpoints (nodes + containers) off the shared readiness partition, so a
  // container's dominance is computed identically to the reducer's readiness.
  const preds = new Map<string, { from: string; on: string }[]>();
  const indeg = new Map<string, number>();
  for (const id of endpointIds) {
    preds.set(id, []);
    indeg.set(id, 0);
  }
  for (const id of endpointIds) {
    for (const e of incomingOf(id)) {
      preds.get(id)!.push({ from: e.from, on: e.on });
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
    }
  }

  // reachable[R] = transitive closure of forward predecessors.
  const reachable = new Map<string, Set<string>>();
  for (const id of endpointIds) {
    const acc = new Set<string>();
    const stack = preds.get(id)!.map((p) => p.from);
    while (stack.length) {
      const cur = stack.pop() as string;
      if (acc.has(cur)) continue;
      acc.add(cur);
      for (const p of preds.get(cur) ?? []) stack.push(p.from);
    }
    reachable.set(id, acc);
  }

  // guaranteed[R] + settled[R] via ONE topological pass (Kahn). The forward
  // graph is a DAG (back-edges removed); any endpoint stranded in a residual cycle
  // keeps the safe empty set (which refuses unconditional refs).
  const guaranteed = new Map<string, Set<string>>();
  const settled = new Map<string, Set<string>>();
  const indegWork = new Map(indeg);
  const queue = [...endpointIds].filter((id) => (indegWork.get(id) ?? 0) === 0);
  for (const id of endpointIds) {
    guaranteed.set(id, new Set());
    settled.set(id, new Set());
  }

  while (queue.length) {
    const id = queue.shift() as string;
    const incoming = preds.get(id)!;
    if (incoming.length > 0) {
      let acc: Set<string> | null = null;
      let sacc: Set<string> | null = null;
      for (const { from, on } of incoming) {
        // A `skipped` edge INVERTS its predecessor's guarantees: this node runs
        // only when `from` was skipped, and `from` is skipped precisely because
        // ITS dependency was not met — so nothing `from` was guaranteed on its
        // own (never-taken) path holds here. Inheriting that set would assert a
        // node succeeded on the one path where it provably didn't: the checker
        // would accept the doc and the run would then hard-fail at dispatch.
        // Nothing upstream is guaranteed through a skip.
        const base =
          on === 'skipped' ? new Set<string>() : new Set(guaranteed.get(from) ?? new Set<string>());
        if (on === 'success') base.add(from);
        // failure/completion/branch: `from`'s OUTPUTS are not guaranteed to the
        // target; only what was guaranteed before it is. A branch edge's source
        // (an `if`, #4 A0) does reach `success`, but it produces NO outputs, so
        // it is treated like failure/completion here — staying conservative can
        // only over-reject, never over-accept (and `switch`, A2, is the same).
        acc = acc === null ? base : intersect(acc, base);

        // SETTLED asks a strictly weaker question than `guaranteed` — "did
        // `from` reach a terminal state", not "did it SUCCEED" — so it holds on
        // every edge kind, including the failure/completion/skipped paths where
        // outputs are unavailable. That gap IS the point: it is what makes the
        // ADF `@activity().Status` fan-in/OR pattern expressible.
        //
        // Reaching this node via ANY edge proves `from` itself is terminal, so
        // `from` is always added. What `from` in turn vouches for is a different
        // question, and the skip inversion applies there too: a node is skipped
        // as soon as ONE incoming group is dead, and its OTHER predecessors may
        // still be RUNNING at that moment — so a skipped `from` is terminal while
        // its own upstream may not be.
        //
        // The intersection below subsumes this for a fully-TRACKED graph (every
        // element of settled[from] survives only if it survives the dead group's
        // own edge, and that group's predecessor is terminal). The inversion is
        // load-bearing for exactly the case the intersection cannot see: an
        // UNTRACKED predecessor under an `all` join — an edge from a dangling id
        // `validateDoc` rejects (containers are now TRACKED endpoints, #567, so a
        // container predecessor is handled by the intersection itself). There
        // `from` is skipped by the untracked group dying, while its tracked
        // siblings — which are all settled[from] contains — may still be in flight.
        // Pinned by test: "does not inherit a skipped node's own predecessors
        // (untracked predecessor)".
        const sbase =
          on === 'skipped' ? new Set<string>() : new Set(settled.get(from) ?? new Set<string>());
        sbase.add(from);
        sacc = sacc === null ? sbase : intersect(sacc, sbase);
      }
      guaranteed.set(id, acc ?? new Set());
      settled.set(id, sacc ?? new Set());
    }
    // Applied HERE, inside the topological pass rather than as a post-pass, so a
    // descendant reading this node's set can only ever read the zeroed one.
    if (untrackedAnyJoin.has(id)) {
      guaranteed.set(id, new Set());
      settled.set(id, new Set());
    }
    for (const e of forwardForWalk) {
      if (e.from !== id) continue;
      const d = (indegWork.get(e.to) ?? 0) - 1;
      indegWork.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }

  // Doc-wide `settled` refusal for a doc that can re-run nodes (see
  // `canReRunNodes`). Note this does NOT disable `${nodes.<child>.status}` inside
  // a loop's own `exitWhen`: `validateExitWhen` builds its own scope, where every
  // child is terminal by the reducer's own precondition. Zeroed over ALL endpoints
  // so a `${nodes.<container>.status}` ref is refused in a re-run doc too.
  if (canReRunNodes) for (const id of endpointIds) settled.set(id, new Set());

  // soft[R]: back-edge sources whose outputs R may read ONLY inside default().
  // A source `s` is soft-visible to R iff R is the back-edge target (or a
  // forward-descendant of it) AND R is a forward-ancestor of `s` (so a bounce
  // re-runs R, and `s` produced its output on the prior round).
  const soft = new Map<string, Set<string>>();
  for (const id of nodeIds) soft.set(id, new Set());
  for (const id of nodeIds) {
    const s = soft.get(id)!;
    const ancOfId = reachable.get(id)!;
    for (const e of back) {
      const onReRunStretch = id === e.to || ancOfId.has(e.to);
      const upstreamOfSrc = (reachable.get(e.from)?.has(id) ?? false) || e.from === id;
      if (onReRunStretch && upstreamOfSrc) s.add(e.from);
    }
  }

  return { guaranteed, settled, reachable, soft };
}

/**
 * A node's join rule from `config.join` (`'any'` opt-in; default `'all'`).
 * SSOT shared by the reducer's readiness rule (`computeReadiness`) and this
 * module's availability analysis — the two MUST agree on when a node can run,
 * or static validation describes a different engine than the one that executes.
 * Lives here, like `effectiveEdges`, because `reduce.ts` imports `params.ts`.
 */
export function nodeJoin(node: Pick<Node, 'config'>): 'all' | 'any' {
  return node.config['join'] === 'any' ? 'any' : 'all';
}

/**
 * A CONTAINER's join rule (`'any'` opt-in; default `'all'`), gating its readiness
 * from its incoming OUTER edges — the container-endpoint sibling of `nodeJoin`.
 * SSOT shared by the reducer (`reduce.ts` imports this) and `computeGraph`, so the
 * static availability analysis and the runtime readiness rule agree on when a
 * container can run. Unlike a node, a container carries `join` directly (not under
 * `config`).
 */
export function containerJoin(c: Pick<Container, 'join'>): 'all' | 'any' {
  return c.join === 'any' ? 'any' : 'all';
}

/**
 * Declared edges, or the implicit success-chain over node order when none.
 * Exported as the SSOT for "edge-less docs synthesize the success-chain" — the
 * walk (`engine/reduce.ts`) and the dominance analysis here must agree on the
 * one canonical edge set, so both read it from this single function.
 */
export function effectiveEdges(doc: Pick<PipelineVersion, 'nodes' | 'edges'>): Edge[] {
  if (doc.edges.length > 0) return doc.edges;
  const out: Edge[] = [];
  for (let i = 0; i + 1 < doc.nodes.length; i += 1) {
    out.push({
      id: `__implicit_${i}`,
      from: doc.nodes[i]!.id,
      to: doc.nodes[i + 1]!.id,
      on: 'success',
    });
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

// --- back-edge reset body (SSOT shared by the reducer + validateDoc) ---------

/**
 * Node-only forward adjacency (back-edges AND container endpoints excluded).
 * SSOT for "what nodes a node forward-reaches", used to compute a back-edge's
 * reset body identically in the reducer and in `validateDoc`.
 */
export function nodeForwardAdjacency(
  doc: Pick<PipelineVersion, 'nodes' | 'edges'>,
): Map<string, string[]> {
  const idSet = new Set(doc.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const n of doc.nodes) adj.set(n.id, []);
  for (const e of effectiveEdges(doc)) {
    if (e.back) continue;
    if (idSet.has(e.from) && idSet.has(e.to)) adj.get(e.from)!.push(e.to);
  }
  return adj;
}

/** Forward-reachable node ids from `start` (NOT including `start`). */
export function forwardDescendants(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return seen;
}

/**
 * A back-edge's RESET BODY — the nodes it returns to `pending` on a bounce:
 *   - target is a container → its children.
 *   - target is a node → the nodes on forward paths target..source (inclusive).
 * SSOT: the reducer (`fireBackEdges`) and `validateDoc`'s no-progress guard both
 * read this so they can never disagree on which nodes a bounce resets.
 */
export function backEdgeResetBody(
  be: Edge,
  nodeIds: string[],
  descendants: Map<string, Set<string>>,
  containerById: Map<string, Container>,
): string[] {
  const targetContainer = containerById.get(be.to);
  if (targetContainer !== undefined) return [...targetContainer.children];
  const fromTarget = descendants.get(be.to) ?? new Set<string>();
  const body: string[] = [];
  for (const n of nodeIds) {
    const reachedByTarget = n === be.to || fromTarget.has(n);
    const reachesSource = n === be.from || (descendants.get(n)?.has(be.from) ?? false);
    if (reachedByTarget && reachesSource) body.push(n);
  }
  return body;
}

/** A single re-declaration of an already-owned container child, in document order. */
export interface ContainerChildDuplicate {
  /** the child id claimed by more than one container. */
  readonly child: string;
  /** the FIRST container that declared it — the owner that wins. */
  readonly first: string;
  /** the later container whose claim is overridden. */
  readonly container: string;
}

/** Container membership resolved to ONE owner per child, plus the claims it overrode. */
export interface ContainerMembership {
  /** child id → the FIRST container that declared it. */
  readonly owner: Map<string, string>;
  /** each re-declaration of an already-owned child, in document order. */
  readonly duplicates: readonly ContainerChildDuplicate[];
}

/**
 * Resolve which container OWNS each child, FIRST-declared-wins, and collect the
 * later claims that resolution overrode.
 *
 * SSOT: `validateDoc` (which turns `duplicates` into "must be disjoint" errors)
 * and the reducer (which uses `owner` to classify edges and neutralizes each
 * duplicate out of every non-owning container's body, reporting it as a
 * `docDefect`) both read this — so the two can never disagree on who owns a
 * child. That disagreement was #492: the validator resolved FIRST-wins and
 * reported it, while the reducer's `childToContainer` silently took the LAST
 * owner, so a non-disjoint doc had two containers both claiming success off one
 * child execution with nothing saying the doc was ambiguous.
 *
 * Built over RAW children — a non-node id gets an owner too. Existence is a
 * SEPARATE question each caller answers itself; membership must reflect what the
 * author wrote so edge classification stays honest (the reason the reducer reads
 * membership from raw, not `#487`-filtered, children).
 */
export function containerMembership(containers: Container[]): ContainerMembership {
  const owner = new Map<string, string>();
  const duplicates: ContainerChildDuplicate[] = [];
  for (const c of containers) {
    for (const ch of c.children) {
      const prev = owner.get(ch);
      if (prev === undefined) owner.set(ch, c.id);
      else if (prev !== c.id) duplicates.push({ child: ch, first: prev, container: c.id });
      // prev === c.id (one container lists a child twice) is not a
      // cross-container duplicate — it already resolves to this container.
    }
  }
  return { owner, duplicates };
}
