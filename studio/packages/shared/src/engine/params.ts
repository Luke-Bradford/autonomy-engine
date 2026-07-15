import type {
  Container,
  Edge,
  Node,
  Param,
  PipelineVersion,
  SubstitutionContext,
} from './types.js';
import { ParamResolveError, SubstituteError, TERMINAL_NODE } from './types.js';
import { declaredOutputNames } from './outputs.js';
import type { Expr, TemplateMode } from './expr.js';
import { interpolationMode, parseExpr, restoreEscapes } from './expr.js';
import type { EvalIn, FnSpec } from './functions.js';
import {
  FUNCTIONS,
  MAX_ARRAY_ELEMENTS_TOTAL,
  arity,
  checkArgTypes,
  listFunctions,
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
 * Missing node-output — a distinct error so `default()` (the ONE lazy function)
 * can treat an absent node output as "use the fallback" while a typo'd param or
 * run field stays a hard error. Internal to this module.
 */
class MissingNodeOutputError extends SubstituteError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingNodeOutputError';
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
 * A ref's path as plain field NAMES, or `null` if any segment is an `[]` index.
 *
 * `segments` — not `source` — is the structural SSOT: a quoted index like
 * `m['b.c']` is ONE segment but TWO dot-parts, so splitting `source` on `.`
 * would disagree with the grammar on the doc's own meaning.
 */
function fieldPath(expr: Extract<Expr, { kind: 'ref' }>): string[] | null {
  const names: string[] = [];
  for (const seg of expr.segments) {
    if (seg.kind !== 'field') return null;
    names.push(seg.name);
  }
  return names;
}

/**
 * The refusal for a ref carrying `[]` deep addressing. E1 parses `[]` into the
 * AST; RESOLVING it is E7 (the runtime-validated escape hatch into `json`/`any`
 * outputs). Until then such a ref is refused — loudly, at save AND at run time.
 *
 * This MUST be a plain `SubstituteError`, never a `MissingNodeOutputError`:
 * `default()` catches the latter and would silently substitute its fallback, so
 * `${default(nodes.a.output.rows[0], 'fb')}` would validate clean today and
 * then SILENTLY CHANGE MEANING when E7 lands.
 */
function deferredToE7(source: string): SubstituteError {
  return new SubstituteError(
    `\${${source}}: deep [] addressing into an output is not supported yet ` +
      '(it parses, but resolving it lands with #6 E7)',
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

function resolveRef(expr: Extract<Expr, { kind: 'ref' }>, env: Env): unknown {
  const ctx = env.ctx;
  const parts = fieldPath(expr);
  // NB `${item[0]}` lands HERE, not in the `item` branch below: an index-bearing
  // path has no plain field path, so it is refused as E7 work. The message says
  // "into an output" while `item` is not an output — a known misattribution,
  // accepted because the refusal itself is correct and E7 owns the fix.
  if (parts === null) throw deferredToE7(expr.source);

  // `${item}` / `${item.<path>}` (#6 E4) — bound ONLY inside a lambda arg.
  //
  // A bare `${item}` (no path) is the element itself: `filter(params.nums,
  // greater(item, 5))` over a scalar array is the spec's own v1 shape.
  //
  // Unbound is a plain `SubstituteError`, never `MissingNodeOutputError`:
  // `default()` catches the latter, so routing an out-of-scope `item` through it
  // would let `${default(item.x, 'fb')}` silently return the fallback for what is
  // really a scope error. Same reasoning as E3's status refusal.
  if (parts[0] === 'item') {
    if (env.item === undefined) {
      throw new SubstituteError(
        `\${${expr.source}}: 'item' is only bound inside a filter/map/count ` +
          'predicate — it has no value here',
      );
    }
    let cur: unknown = env.item.value;
    for (const name of parts.slice(1)) {
      // `hasOwnProperty`, NEVER `in`: `in` walks the PROTOTYPE CHAIN, so
      // `${item.constructor}` would hand back a real host function (and
      // `${item.__proto__}` an object's prototype) as resolved node config —
      // escaping the data model and defeating `toStr`'s string contract. Matches
      // the own-property rule every sibling branch in this function uses.
      if (
        cur === null ||
        typeof cur !== 'object' ||
        !Object.prototype.hasOwnProperty.call(cur, name)
      ) {
        throw new SubstituteError(`\${${expr.source}}: the current item has no field '${name}'`);
      }
      cur = (cur as Record<string, unknown>)[name];
    }
    return cur;
  }

  if (parts[0] === 'params' && parts.length === 2) {
    const name = parts[1] as string;
    if (!Object.prototype.hasOwnProperty.call(ctx.params, name)) {
      throw new SubstituteError(`unknown param reference \${params.${name}}`);
    }
    return ctx.params[name];
  }
  if (parts[0] === 'nodes' && parts.length === 4 && parts[2] === 'output') {
    const id = parts[1] as string;
    const name = parts[3] as string;
    const outs = ctx.nodeOutputs[id];
    if (outs === undefined || !Object.prototype.hasOwnProperty.call(outs, name)) {
      throw new MissingNodeOutputError(`unknown node output \${nodes.${id}.output.${name}}`);
    }
    return outs[name];
  }
  // `${nodes.<id>.status}` (#6 E3 T6) — the ADF `@activity().Status` fan-in/OR
  // handle. Its vocabulary is the TERMINAL set only.
  //
  // Both refusals below are plain `SubstituteError`s, NEVER
  // `MissingNodeOutputError`: `default()` catches that one, so routing through it
  // would let `${default(nodes.a.status, 'none')}` silently return "none" for a
  // real dispatch race or a typo'd node id — reporting a verdict the run never
  // reached. A status either IS settled or the expression is wrong.
  if (parts[0] === 'nodes' && parts.length === 3 && parts[2] === 'status') {
    const id = parts[1] as string;
    const status = ctx.nodeStatuses[id];
    if (status === undefined) {
      throw new SubstituteError(`\${nodes.${id}.status}: no node '${id}' in this run`);
    }
    if (!TERMINAL_NODE.has(status)) {
      throw new SubstituteError(
        `\${nodes.${id}.status}: node '${id}' has not settled here — a status is ` +
          `readable only once it is success/failure/skipped`,
      );
    }
    return status;
  }
  if (parts[0] === 'run' && parts.length === 2) {
    const field = parts[1] as string;
    if (!Object.prototype.hasOwnProperty.call(ctx.run, field)) {
      throw new SubstituteError(`unknown run field \${run.${field}}`);
    }
    return ctx.run[field];
  }
  throw new SubstituteError(`unresolvable reference \${${expr.source}}`);
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
 * `MissingNodeOutputError` itself — PRIVATE to this module: the catalog gets a
 * yes/no answer instead of an error class, so `functions.ts` never imports back.
 */
function evalIn(env: Env): EvalIn {
  return {
    eval: (e) => evalExpr(e, env),
    soft: (e) => {
      try {
        return { ok: true, value: evalExpr(e, env) };
      } catch (err) {
        if (err instanceof MissingNodeOutputError) return { ok: false };
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
// The rule needs BOTH halves — save-time (`validateWholeValue`, advisory: the
// canvas badge) and run-time (`wholeValueDefect`, binding: the reducer, since a
// git import or a direct POST never passes through save-time validation). Both
// read `defectOf` so the two halves can never word or judge the rule differently.

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
      if (typeof value === 'number' && !Number.isNaN(value)) return value;
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        return Number(value.trim());
      }
      throw new ParamResolveError(`param '${name}': expected number`);
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

  // Each producer's declared output names (req c), computed once. The SSOT is
  // the same `config.outputs` the reducer stores/validates against, so a name
  // static validation accepts is exactly one the run would keep at `succeeded`.
  const outputsById = new Map<string, Set<string> | null>();
  for (const node of doc.nodes) outputsById.set(node.id, declaredOutputNames(node));

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
 *  - a loop declares an `exitWhen` or a `maxRounds` (else it never terminates),
 *    and a stage carries no `exitWhen`;
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

  // Node-only forward reachability + the container index, for the back-edge
  // reset-body (no-progress) guard below — computed via the SSOT helpers so the
  // reducer and this validator agree on which nodes a bounce resets.
  const containerById = new Map<string, Container>(containers.map((c) => [c.id, c]));
  const nodeAdj = nodeForwardAdjacency(doc);
  const descendants = new Map<string, Set<string>>();
  for (const id of nodeIdList) descendants.set(id, forwardDescendants(id, nodeAdj));

  // Container children: existence + disjointness; loop/stage exit configuration.
  const childOwner = new Map<string, string>();
  for (const c of containers) {
    for (const ch of c.children) {
      if (!nodeIdSet.has(ch)) {
        errors.push(`container '${c.id}': child '${ch}' is not a node in this pipeline`);
      }
      const prev = childOwner.get(ch);
      if (prev !== undefined && prev !== c.id) {
        errors.push(
          `container '${c.id}': child '${ch}' already belongs to container '${prev}' (children must be disjoint)`,
        );
      } else {
        childOwner.set(ch, c.id);
      }
    }
    if (c.kind === 'loop' && c.exitWhen === undefined) {
      errors.push(
        `container '${c.id}': a loop needs an exitWhen ` +
          '(maxRounds is only the round cap, not the exit condition)',
      );
    }
    if (c.kind === 'stage' && c.exitWhen !== undefined) {
      errors.push(`container '${c.id}': exitWhen is only meaningful on a loop, not a stage`);
    }
    if (c.exitWhen !== undefined) validateExitWhen(c, declared, errors);
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
  // NB this is ADVISORY, not a gate: `validateDoc`'s only caller is the canvas
  // (`web/.../canvasDoc.ts`), which renders the result as a badge and does NOT
  // block Save, and the server never calls it at all (#444). The reducer's
  // diagnostic is what actually makes an inert branch edge observable at run
  // time. #4 A0/A1/A2 replaces this rule with the real one ("a branch edge's
  // source must declare that branch"), which needs the ActivityDefinition
  // contract.
  for (const e of doc.edges) {
    if (e.on !== 'branch') continue;
    errors.push(
      `edge '${e.id}': business 'branch' edges are not routable yet — the if/switch activities ` +
        `that emit a branch outcome land with #4 A0/A1/A2`,
    );
  }

  // The FORWARD graph (all edges minus `back:true`) must be a DAG — a forward
  // cycle deadlocks the walk (its nodes never become ready; `settle` emits no
  // command and never finishes → a silent hang).
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
function validateExitWhen(c: Container, declared: Map<string, Param>, errors: string[]): void {
  if (c.exitWhen === undefined) return;
  const where = `container.${c.id}.exitWhen`;
  const scope: ScanScope = {
    declared,
    guaranteed: new Set(c.children), // a child's output is in-scope for exit
    // Every child is SETTLED here by construction: the reducer only evaluates
    // `exitWhen` once every child is terminal (`stepContainers`), so unlike the
    // doc-level analysis this needs no conservatism — the gate is the reducer's
    // own precondition.
    //
    // AVAILABILITY only. It does NOT make a bare `${nodes.check.status}` a usable
    // exitWhen: the field needs a BOOLEAN, and a status resolves to the string
    // `'success'`, which `evalExitWhen` reads as not-true — the loop would burn
    // every round and report the misleading `capped`. The usable form is
    // `${equals(nodes.check.status, 'success')}`, which needs `equals` (E4); the
    // string-where-boolean-expected rejection is E6's type check, per E2's split
    // (E2 owns the MODE check, E6 the TYPE check). Refusing availability here
    // instead would misattribute a type defect to a scope rule.
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
   * Producer node id → its DECLARED output names (from `config.outputs`), or
   * `null` when it declares no contract. A `${nodes.X.output.NAME}` whose NAME
   * is absent from a non-`null` set can only fail at run time, so it is rejected
   * (req c). Absent from the map (or `undefined`) → no name-check for that id.
   * Populated by `validateRefs`; omitted elsewhere (e.g. `validateExitWhen`).
   */
  outputsById?: Map<string, Set<string> | null>;
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
    expr.args.forEach((a, i) =>
      checkExprStatic(
        a,
        scope,
        errors,
        where,
        i === spec.staticSoftArg,
        // `item` stays in scope for anything nested inside a lambda arg; a
        // SIBLING arg of the same call does not inherit it.
        itemInScope || lambdas.includes(i),
      ),
    );
    return;
  }

  // A reference. `segments` is the SSOT — never split `source` (a quoted index
  // `m['b.c']` is one segment but two dot-parts). A ref carrying an `[]` index
  // is refused REGARDLESS of `softOk`: E7 owns resolving it, and letting
  // `default()`'s soft path accept it would validate a doc clean today that
  // silently changes meaning when E7 lands.
  //
  // E7 NOTE: this returns before walking an index's OWN sub-expression, so
  // `${nodes.n.output.rows[params.tok]}` currently reports only the E7 refusal.
  // When E7 makes these resolvable it MUST recurse into each `index.expr`, or
  // the secret-param rule below gains a hole (a secret-typed `${params.tok}`
  // hidden inside an index would go unreported).
  const parts = fieldPath(expr);
  if (parts === null) {
    errors.push(`${where}: ${deferredToE7(expr.source).message}`);
    return;
  }
  // `${item}` (#6 E4) — legal ONLY inside a lambda arg. The ELEMENT'S OWN shape
  // is not checked here: the type vocabulary has no element type, so a misspelled
  // `${item.badField}` is a run-time throw, not an edit-time error (E4's recorded
  // decision — E6 + #2's `OutputSpec` own closing that gap).
  if (parts[0] === 'item') {
    if (!itemInScope) {
      errors.push(
        `${where}: \${${expr.source}} — 'item' is only bound inside a ` +
          'filter/map/count predicate',
      );
    }
    return;
  }
  if (parts[0] === 'params' && parts.length === 2) {
    const name = parts[1] as string;
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
  if (parts[0] === 'nodes' && parts.length === 4 && parts[2] === 'output') {
    const id = parts[1] as string;
    const name = parts[3] as string;
    // req (c): reject an output NAME the producer does not declare. A bare ref
    // to an absent output can only throw at run time (dispatch-prep fails), so
    // it is invalid regardless of dominance. EXCLUDED inside `default()`'s
    // first arg (`softOk`), where a missing node output is caught and the
    // fallback used — an unknown name resolves fine there, so rejecting it
    // would be a false reject. A producer with no declared contract (`null`)
    // has no enforceable names; an id absent from the map is not checked.
    const declaredNames = scope.outputsById?.get(id);
    if (!softOk && declaredNames != null && !declaredNames.has(name)) {
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
    // `MissingNodeOutputError` at runtime and fall back correctly (the arg is
    // evaluated as a whole before the absence check). Over-refusing here is
    // safe (never a false-accept); a pipeline author must reference the bare
    // node output as `default`'s first arg to satisfy the static checker.
    if (softOk && (scope.reachable.has(id) || scope.soft.has(id))) return;
    if (scope.reachable.has(id) || scope.soft.has(id)) {
      errors.push(
        `${where}: \${nodes.${id}.output.${parts[3]}} is not guaranteed here — ` +
          'wrap it in default() (it is reachable only on a failure/completion ' +
          'branch or a loop round, or does not dominate this node)',
      );
    } else {
      errors.push(
        `${where}: \${nodes.${id}.output.${parts[3]}} does not name an upstream ` +
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
  // `MissingNodeOutputError`, and `resolveRef` raises a plain `SubstituteError`
  // for an unsettled status, so relaxing the check inside `default()` would
  // accept a doc at save that still THROWS at run — a manufactured false-accept
  // with no escape hatch (same reasoning as the E7 refusal above).
  if (parts[0] === 'nodes' && parts.length === 3 && parts[2] === 'status') {
    const id = parts[1] as string;
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
  if (parts[0] === 'run' && parts.length === 2) {
    if (!(RUN_FIELDS as readonly string[]).includes(parts[1] as string)) {
      errors.push(
        `${where}: \${run.${parts[1]}} is not a known run field (${RUN_FIELDS.join(', ')})`,
      );
    }
    return;
  }
  errors.push(`${where}: unresolvable reference \${${expr.source}}`);
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
