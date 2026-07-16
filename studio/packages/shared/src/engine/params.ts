import type {
  Container,
  Edge,
  Node,
  Param,
  PipelineVersion,
  SubstitutionContext,
} from './types.js';
import { ParamResolveError, SubstituteError, TERMINAL_NODE } from './types.js';
import type { OutputContract } from './outputs.js';
import { outputContract } from './outputs.js';
import type { Expr, ExprSegment, TemplateMode } from './expr.js';
import { interpolationMode, parseExpr, restoreEscapes } from './expr.js';
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
  | { kind: 'run'; field: string; arity: 2 };

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
   * Elements materialised so far by THIS field's evaluation. Shared by every
   * child Env (the object is passed by reference, deliberately), so nesting
   * cannot escape it — see `charge`.
   */
  budget: { spent: number };
}

/** A fresh evaluation scope for one field. */
function newEnv(ctx: SubstitutionContext): Env {
  return { ctx, budget: { spent: 0 } };
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
            'predicate — it has no value here',
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
 * and `run.triggerId` is seeded literal `null` for every run today, so
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
export function substitute(value: unknown, ctx: SubstitutionContext): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = substitute((value as Record<string, unknown>)[key], ctx);
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
  const env = newEnv(ctx);

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
  const outputsById = outputsByIdOf(doc.nodes);

  for (const node of doc.nodes) {
    const guaranteed = graph.guaranteed.get(node.id) ?? new Set<string>();
    const settled = graph.settled.get(node.id) ?? new Set<string>();
    const reachable = graph.reachable.get(node.id) ?? new Set<string>();
    const soft = graph.soft.get(node.id) ?? new Set<string>();
    scan(
      `nodes.${node.id}.config`,
      node.config,
      { declared, guaranteed, settled, reachable, soft, outputsById },
      errors,
    );
  }
  return errors;
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
 * No `ValidateDocOptions` are passed, deliberately: `selfId`/`resolvePipeline`
 * enable `call_pipeline` cycle+depth analysis, which needs a DB read (impure)
 * and would make the server enforce a rule the canvas never checked — a doc
 * that badges clean would newly 400. So `call_pipeline` cycles still reach the
 * reducer unchecked; wiring an OWNER-SCOPED resolver is its own ticket (the
 * resolver's errors echo another version's ids, which the #444 security
 * argument does not cover).
 *
 * PURE: no I/O, no clock. Returns error strings; `[]` means valid.
 */
export function validatePipelineDoc(
  doc: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
): string[] {
  return [...validateDoc(doc), ...validateRefs(doc)];
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
  for (const p of doc.params) declared.set(p.name, p);
  const outputsById = outputsByIdOf(doc.nodes);

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
  for (const node of doc.nodes) {
    const contract = outputsById.get(node.id);
    if (contract?.kind === 'invalid') {
      errors.push(`node '${node.id}': config.outputs is malformed (${contract.reason})`);
    }
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

  // Business `branch` edges: the union is settled here (spec #1 owns it, T3) so
  // #4 can build `if`/`switch` against a final schema — but no activity emits a
  // branch outcome yet, so a branch edge would silently skip everything
  // downstream. Report it; PARSE stays permissive so a git import round-trips
  // one unchanged.
  //
  // NB the WRITE PATH now refuses a doc this reports (#444 — the server calls
  // `validatePipelineDoc` in `createPipelineVersion`), but rows written BEFORE
  // that gate were never validated, so the reducer's diagnostic remains the
  // thing that makes an inert branch edge observable at run time. Both halves
  // are load-bearing; do not delete the reducer's on the strength of this one.
  // #4 A0/A1/A2 replaces this rule with the real one ("a branch edge's source
  // must declare that branch"), which needs the ActivityDefinition contract.
  for (const e of doc.edges) {
    if (e.on !== 'branch') continue;
    errors.push(
      `edge '${e.id}': business 'branch' edges are not routable yet — the if/switch activities ` +
        `that emit a branch outcome land with #4 A0/A1/A2`,
    );
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
}

function scan(where: string, value: unknown, scope: ScanScope, errors: string[]): void {
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
      checkExprStatic(parseExprSafe(m.body, where, errors), scope, errors, where, false);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(`${where}[${i}]`, v, scope, errors));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      scan(`${where}.${key}`, (value as Record<string, unknown>)[key], scope, errors);
    }
  }
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
function outputsByIdOf(nodes: readonly Node[]): Map<string, OutputContract> {
  const m = new Map<string, OutputContract>();
  for (const node of nodes) m.set(node.id, outputContract(node));
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
    // Every `RUN_FIELDS` member is a string. `triggerId`/`parentRunId` are seeded
    // `null` by the reducer today (#5 owns the real seed), and typing them `any`
    // instead would be strictly WEAKER, not safer: `any` additionally accepts
    // `${add(run.triggerId, 1)}`, and the run-time null throws under either
    // typing. The nullability gap is #5's to close, and no static type here can
    // paper over it — `SigType` has no null.
    case 'run':
      return (RUN_FIELDS as readonly string[]).includes(root.field) ? 'string' : 'any';
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
    checkExprStatic(seg.expr, scope, errors, where, softOk, itemInScope);
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
          'filter/map/count predicate',
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
  if (!(RUN_FIELDS as readonly string[]).includes(root.field)) {
    errors.push(
      `${where}: \${run.${root.field}} is not a known run field (${RUN_FIELDS.join(', ')})`,
    );
  }
}

// --- the graph / dominance helper -------------------------------------------

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
  const nodeIds = doc.nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  const effective = effectiveEdges(doc);
  const forward = effective.filter((e) => !e.back && idSet.has(e.from) && idSet.has(e.to));
  const back = doc.edges.filter((e) => e.back && idSet.has(e.from) && idSet.has(e.to));

  // Nodes with an incoming forward edge from an UNTRACKED endpoint — in practice
  // a CONTAINER (node and container ids share one endpoint namespace, and this
  // analysis is node-only, so a container predecessor is invisible here while
  // being fully live in the reducer's readiness graph).
  //
  // This asymmetry only bites under an `any` join, and there it is a
  // FALSE-ACCEPT, which is the one direction that is never safe: `r` dispatches
  // the moment the container satisfies, while a tracked sibling is still
  // running. Intersecting over the tracked edges alone silently asserts the
  // sibling settled. Under `all`, an untracked predecessor merely ADDS a
  // requirement — every tracked predecessor must satisfy regardless — so
  // ignoring it stays sound, which is why this is scoped to `any`.
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const untrackedAnyJoin = new Set<string>();
  for (const e of effective) {
    if (e.back || !idSet.has(e.to) || idSet.has(e.from)) continue;
    const to = nodeById.get(e.to);
    if (to !== undefined && nodeJoin(to) === 'any') untrackedAnyJoin.add(e.to);
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
  // A `stage` never re-rounds (`stepContainers` exits it once its children are
  // terminal), so it must NOT disable status refs.
  const canReRunNodes =
    doc.edges.some((e) => e.back === true) || doc.containers.some((c) => c.kind === 'loop');

  // Predecessors (forward), for reachability + the must-analysis.
  const preds = new Map<string, { from: string; on: string }[]>();
  const indeg = new Map<string, number>();
  for (const id of nodeIds) {
    preds.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of forward) {
    preds.get(e.to)!.push({ from: e.from, on: e.on });
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // reachable[R] = transitive closure of forward predecessors.
  const reachable = new Map<string, Set<string>>();
  for (const id of nodeIds) {
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
  // graph is a DAG (back-edges removed); any node stranded in a residual cycle
  // keeps the safe empty set (which refuses unconditional refs).
  const guaranteed = new Map<string, Set<string>>();
  const settled = new Map<string, Set<string>>();
  const indegWork = new Map(indeg);
  const queue = nodeIds.filter((id) => (indegWork.get(id) ?? 0) === 0);
  for (const id of nodeIds) {
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
        // failure/completion/branch: `from` ran but did not necessarily succeed
        // (a branch edge implies it did, but branch routing is inert until #4
        // A0 — staying conservative can only over-reject, never over-accept) →
        // its outputs are NOT guaranteed; only what was guaranteed before it is.
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
        // UNTRACKED (container) predecessor under an `all` join. There `from` is
        // skipped by the untracked group dying, while its tracked siblings —
        // which are all settled[from] contains — may still be in flight. Pinned
        // by test: "does not inherit a skipped node's own predecessors (untracked
        // predecessor)".
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
    for (const e of forward) {
      if (e.from !== id) continue;
      const d = (indegWork.get(e.to) ?? 0) - 1;
      indegWork.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }

  // Doc-wide `settled` refusal for a doc that can re-run nodes (see
  // `canReRunNodes`). Note this does NOT disable `${nodes.<child>.status}` inside
  // a loop's own `exitWhen`: `validateExitWhen` builds its own scope, where every
  // child is terminal by the reducer's own precondition.
  if (canReRunNodes) for (const id of nodeIds) settled.set(id, new Set());

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
