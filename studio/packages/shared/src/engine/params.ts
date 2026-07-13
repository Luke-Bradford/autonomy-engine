import type {
  Container,
  Edge,
  Node,
  Param,
  PipelineVersion,
  SubstitutionContext,
} from './types.js';
import { ParamResolveError, SubstituteError } from './types.js';

// ---------------------------------------------------------------------------
// The `${...}` parameter language (ported from lib/pipeline.py's S3.1 resolver).
//
// A hand-rolled parser + evaluator over a CLOSED grammar. There is NO `eval`
// and NO `new Function` anywhere: `${__import__(...)}` is simply an unknown
// function reference that RAISES. The security-critical property is INERTNESS —
// substitution scans a string ONCE and never rescans a replacement, so a
// resolved value that itself contains `${...}` is emitted literally (the
// no-injection guarantee). See `substitute`.
// ---------------------------------------------------------------------------

/** Closed field set readable via `${run.<field>}`. SSOT — extend here only. */
export const RUN_FIELDS = ['id', 'pipelineVersionId', 'triggerId', 'parentRunId'] as const;

/** Sentinel used to protect a `$${` literal escape during a substitution pass. */
const ESC = '\x00AE_DOLLAR_BRACE\x00';

/** A function call: `name(args)`. Dotall so a nested call may span the args. */
const CALL_RE = /^([a-z_]+)\((.*)\)$/s;
const INT_RE = /^-?\d+$/;

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

// --- the closed pure-function allowlist (SSOT: one entry per fn) -------------

interface FnSpec {
  /** Applies to already-resolved args. Never performs I/O; must be pure. */
  impl: (args: unknown[]) => unknown;
  minArgs: number;
  /** `null` = variadic (no upper bound). */
  maxArgs: number | null;
}

/**
 * Extend the language by adding ONE entry here. `default` is listed for its
 * arity/allowlist metadata (the static checker + arity guard read it) but is
 * evaluated specially in `evalExpr` because it is lazy (its first arg may be an
 * absent node output). Adding a fn is a single edit — the parser, evaluator and
 * validator all read this map.
 */
const ALLOWED_FUNCS: Record<string, FnSpec> = {
  default: {
    impl: (a) => (isAbsent(a[0]) ? a[1] : a[0]),
    minArgs: 2,
    maxArgs: 2,
  },
  concat: {
    impl: (a) => a.map(toStr).join(''),
    minArgs: 1,
    maxArgs: null,
  },
  slug: {
    impl: (a) => slug(a[0]),
    minArgs: 1,
    maxArgs: 1,
  },
};

/** A value `default()` treats as "missing" and replaces with its fallback. */
function isAbsent(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === false;
}

function slug(v: unknown): string {
  const s = toStr(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'x';
}

/** Coerce a resolved value to a string (embedded-ref + concat semantics). */
function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

// --- the parser (grammar SSOT shared by evaluator + static validator) -------

type Expr =
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'ref'; path: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number };

/**
 * Top-level `${...}` body: a function call or a dotted reference (never a bare
 * literal — mirrors the prototype, where `${5}` is an unresolvable ref). Throws
 * `SubstituteError` on unbalanced quotes/parens inside a call's args.
 */
function parseExpr(bodyRaw: string): Expr {
  const body = bodyRaw.trim();
  const m = CALL_RE.exec(body);
  if (m) {
    const name = m[1] as string;
    const args = splitArgs(m[2] as string).map(parseArg);
    return { kind: 'call', name, args };
  }
  return { kind: 'ref', path: body };
}

/** One function argument: a string literal, int literal, nested call, or ref. */
function parseArg(tokRaw: string): Expr {
  const tok = tokRaw.trim();
  if (tok.length >= 2 && tok[0] === tok[tok.length - 1] && (tok[0] === "'" || tok[0] === '"')) {
    return { kind: 'str', value: tok.slice(1, -1) };
  }
  if (CALL_RE.test(tok)) return parseExpr(tok);
  if (INT_RE.test(tok)) return { kind: 'num', value: Number(tok) };
  return { kind: 'ref', path: tok };
}

/**
 * Top-level comma split honoring quotes and nested parens — a hand tokenizer,
 * so arbitrary code can never execute. Throws on unbalanced quotes/parens.
 */
function splitArgs(s: string): string[] {
  const args: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      depth += 1;
      buf += ch;
    } else if (ch === ')') {
      depth -= 1;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (quote !== null || depth !== 0) {
    throw new SubstituteError('malformed expression: unbalanced quotes/parens');
  }
  const tail = buf.trim();
  if (tail || args.length) args.push(tail);
  return args;
}

// --- the evaluator ----------------------------------------------------------

function resolveRef(path: string, ctx: SubstitutionContext): unknown {
  const parts = path.split('.');
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
  if (parts[0] === 'run' && parts.length === 2) {
    const field = parts[1] as string;
    if (!Object.prototype.hasOwnProperty.call(ctx.run, field)) {
      throw new SubstituteError(`unknown run field \${run.${field}}`);
    }
    return ctx.run[field];
  }
  throw new SubstituteError(`unresolvable reference \${${path}}`);
}

function evalExpr(expr: Expr, ctx: SubstitutionContext): unknown {
  switch (expr.kind) {
    case 'str':
      return expr.value;
    case 'num':
      return expr.value;
    case 'ref':
      return resolveRef(expr.path, ctx);
    case 'call': {
      if (expr.name === 'default') {
        if (expr.args.length !== 2) {
          throw new SubstituteError(
            `function 'default' arity: expected 2, got ${expr.args.length}`,
          );
        }
        let first: unknown;
        try {
          first = evalExpr(expr.args[0] as Expr, ctx);
        } catch (err) {
          if (err instanceof MissingNodeOutputError) {
            return evalExpr(expr.args[1] as Expr, ctx);
          }
          throw err;
        }
        return isAbsent(first) ? evalExpr(expr.args[1] as Expr, ctx) : first;
      }
      const spec = ALLOWED_FUNCS[expr.name];
      if (spec === undefined) {
        throw new SubstituteError(`unknown function '${expr.name}' (allowed: ${allowedFnNames()})`);
      }
      checkArity(expr.name, spec, expr.args.length);
      const args = expr.args.map((a) => evalExpr(a, ctx));
      try {
        return spec.impl(args);
      } catch (err) {
        if (err instanceof SubstituteError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new SubstituteError(`function '${expr.name}' failed: ${msg}`);
      }
    }
  }
}

function allowedFnNames(): string {
  return Object.keys(ALLOWED_FUNCS).sort().join(', ');
}

function checkArity(name: string, spec: FnSpec, got: number): void {
  if (got < spec.minArgs || (spec.maxArgs !== null && got > spec.maxArgs)) {
    const expected = spec.maxArgs === spec.minArgs ? `${spec.minArgs}` : `${spec.minArgs}+`;
    throw new SubstituteError(`function '${name}' arity: expected ${expected}, got ${got}`);
  }
}

// --- the `${...}` boundary scanner (SSOT shared by substitute + validateRefs) -

/** One located `${...}` reference: `s[start..start+1] === '${'`, `s[end] === '}'`. */
interface RefMatch {
  start: number;
  end: number;
  body: string;
}

/**
 * Find the index of the `}` that closes a `${` body starting at `bodyStart`
 * (the index right after the opening `${`), or `-1` if none closes before the
 * end of `s`. The closer is the first `}` that is NOT inside a quoted string
 * literal (quote rule mirrors `splitArgs`: a quote is closed by the next
 * occurrence of the SAME quote character, no backslash escaping). An unquoted
 * `}` cannot legally appear elsewhere in an expression body — refs don't nest
 * and expressions have no bare braces — so a `}` inside a string arg (e.g.
 * `default(params.a, "b}c")`) is skipped by the quote tracking, while a
 * premature/stray unquoted `}` just yields a body that `parseExpr` rejects with
 * a clear error (fail-loud). Deliberately NO paren/brace depth counter: a
 * single shared counter desynced on unbalanced parens (`${foo(a))}`) and could
 * swallow past the real boundary; the closer is purely the first unquoted `}`.
 */
function findRefEnd(s: string, bodyStart: number): number {
  let quote: string | null = null;
  for (let i = bodyStart; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '}') {
      return i;
    }
  }
  return -1;
}

/**
 * Scan `s` left-to-right for every `${...}` reference using `findRefEnd` for
 * each body's boundary. `s` must already have `$${` escapes sentinel-protected
 * by the caller, so a literal `${` never survives into this scan. Matches are
 * non-overlapping (scanning resumes right after each match's closing `}`).
 *
 * `unterminatedAt` is the index of a `${` with no matching top-level `}`
 * before the end of `s`, or `null` if every opener closed. Scanning stops at
 * the first unterminated opener — by construction nothing valid can follow
 * inside a body that never found its close (there is, definitionally, no
 * further unquoted `}` anywhere after it in `s`).
 */
function scanTemplateRefs(s: string): { matches: RefMatch[]; unterminatedAt: number | null } {
  const matches: RefMatch[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('${', i);
    if (open === -1) break;
    const end = findRefEnd(s, open + 2);
    if (end === -1) return { matches, unterminatedAt: open };
    matches.push({ start: open, end, body: s.slice(open + 2, end) });
    i = end + 1;
  }
  return { matches, unterminatedAt: null };
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

  // Protect the `$${` escape, then scan for every `${...}` boundary. An
  // unterminated opener (no matching top-level `}`) is a typo — RAISE (never
  // leave it as a silent literal).
  const protectedStr = value.split('$${').join(ESC);
  const { matches, unterminatedAt } = scanTemplateRefs(protectedStr);
  if (unterminatedAt !== null) {
    throw new SubstituteError(
      `unterminated \${...} reference in ${JSON.stringify(value)} ` +
        '(write $${ for a literal ${)',
    );
  }

  if (
    matches.length === 1 &&
    matches[0]!.start === 0 &&
    matches[0]!.end === protectedStr.length - 1
  ) {
    // Whole-string ref → preserve the resolved value's native type.
    const out = evalExpr(parseExpr(matches[0]!.body), ctx);
    return typeof out === 'string' ? out.split(ESC).join('${') : out;
  }

  // Embedded ref(s) → coerce each to string. Walking the ORIGINAL (protected)
  // string once and splicing in each match's resolved value keeps this pass
  // inherently inert — a resolved value is never itself rescanned.
  let result = '';
  let cursor = 0;
  for (const m of matches) {
    result += protectedStr.slice(cursor, m.start);
    result += toStr(evalExpr(parseExpr(m.body), ctx));
    cursor = m.end + 1;
  }
  result += protectedStr.slice(cursor);
  return result.split(ESC).join('${');
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
export function validateRefs(doc: Pick<PipelineVersion, 'params' | 'nodes' | 'edges'>): string[] {
  const errors: string[] = [];
  const declared = new Map<string, Param>();
  for (const p of doc.params) declared.set(p.name, p);

  const graph = computeGraph(doc);

  for (const node of doc.nodes) {
    const guaranteed = graph.guaranteed.get(node.id) ?? new Set<string>();
    const reachable = graph.reachable.get(node.id) ?? new Set<string>();
    const soft = graph.soft.get(node.id) ?? new Set<string>();
    scan(`nodes.${node.id}.config`, node.config, { declared, guaranteed, reachable, soft }, errors);
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
    reachable: new Set<string>(),
    soft: new Set<string>(),
  };
  // Reuse the shared scanner so exitWhen agrees with the `${}` runtime grammar.
  scan(where, c.exitWhen, scope, errors);
  if (!c.exitWhen.split('$${').join(ESC).includes('${')) {
    errors.push(`${where}: exitWhen must be a \${...} expression over child outputs`);
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

/** The literal (non-`${}`) call targets of a set of nodes. */
function literalCallTargets(nodes: Pick<Node, 'call'>[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.call === undefined) continue;
    const pv = n.call.pipelineVersionId;
    if (!pv.includes('${')) out.push(pv); // dynamic ids can't be resolved statically
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
  /** Node ids that MAY run before this one on some path (forward-reachable). */
  reachable: Set<string>;
  /** Back-edge-visible sibling node ids — readable only inside `default()`. */
  soft: Set<string>;
}

function scan(where: string, value: unknown, scope: ScanScope, errors: string[]): void {
  if (typeof value === 'string') {
    const protectedStr = value.split('$${').join(ESC);
    if (!protectedStr.includes('${')) return;
    // Same boundary scanner as `substitute` (quote/paren/brace-aware), so the
    // runtime and static-validation paths agree on where a `${...}` body ends.
    const { matches, unterminatedAt } = scanTemplateRefs(protectedStr);
    if (unterminatedAt !== null) {
      errors.push(`${where}: unterminated \${ reference`);
    }
    for (const m of matches) {
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

/** Parse an expr for static checking; a malformed body yields a null-ish ref. */
function parseExprSafe(body: string, where: string, errors: string[]): Expr {
  try {
    return parseExpr(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${where}: ${msg}`);
    return { kind: 'ref', path: '' };
  }
}

/**
 * Static-check ONE parsed expression. Mirrors `evalExpr`'s grammar exactly — if
 * this accepts, resolution can only fail on run-time-only facts. `softOk` is
 * true only inside `default()`'s first argument (the one place a back-edge or
 * non-dominating node output may be read).
 */
function checkExprStatic(
  expr: Expr,
  scope: ScanScope,
  errors: string[],
  where: string,
  softOk: boolean,
): void {
  if (expr.kind === 'str' || expr.kind === 'num') return;
  if (expr.kind === 'call') {
    if (expr.name === 'default') {
      if (expr.args.length !== 2) {
        errors.push(`${where}: function 'default' arity: expected 2, got ${expr.args.length}`);
      }
      expr.args.forEach((a, i) => checkExprStatic(a, scope, errors, where, i === 0));
      return;
    }
    const spec = ALLOWED_FUNCS[expr.name];
    if (spec === undefined) {
      errors.push(`${where}: unknown function '${expr.name}' (allowed: ${allowedFnNames()})`);
      return;
    }
    if (
      expr.args.length < spec.minArgs ||
      (spec.maxArgs !== null && expr.args.length > spec.maxArgs)
    ) {
      const expected = spec.maxArgs === spec.minArgs ? `${spec.minArgs}` : `${spec.minArgs}+`;
      errors.push(
        `${where}: function '${expr.name}' arity: expected ${expected}, got ${expr.args.length}`,
      );
    }
    // Function args never inherit `default`'s laziness.
    expr.args.forEach((a) => checkExprStatic(a, scope, errors, where, false));
    return;
  }

  // A dotted reference.
  const parts = expr.path.split('.');
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
  if (parts[0] === 'run' && parts.length === 2) {
    if (!(RUN_FIELDS as readonly string[]).includes(parts[1] as string)) {
      errors.push(
        `${where}: \${run.${parts[1]}} is not a known run field (${RUN_FIELDS.join(', ')})`,
      );
    }
    return;
  }
  errors.push(`${where}: unresolvable reference \${${expr.path}}`);
}

// --- the graph / dominance helper -------------------------------------------

interface Graph {
  /** nodeId → node ids whose SUCCESS is guaranteed on every path to it. */
  guaranteed: Map<string, Set<string>>;
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
function computeGraph(doc: Pick<PipelineVersion, 'nodes' | 'edges'>): Graph {
  const nodeIds = doc.nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);
  const forward = effectiveEdges(doc).filter(
    (e) => !e.back && idSet.has(e.from) && idSet.has(e.to),
  );
  const back = doc.edges.filter((e) => e.back && idSet.has(e.from) && idSet.has(e.to));

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

  // guaranteed[R] via a topological pass (Kahn). The forward graph is a DAG
  // (back-edges removed); any node stranded in a residual cycle keeps the safe
  // empty set (which refuses unconditional refs).
  const guaranteed = new Map<string, Set<string>>();
  const indegWork = new Map(indeg);
  const queue = nodeIds.filter((id) => (indegWork.get(id) ?? 0) === 0);
  for (const id of nodeIds) if (!queue.includes(id)) guaranteed.set(id, new Set());
  for (const id of queue) guaranteed.set(id, new Set());

  while (queue.length) {
    const id = queue.shift() as string;
    const incoming = preds.get(id)!;
    if (incoming.length > 0) {
      let acc: Set<string> | null = null;
      for (const { from, on } of incoming) {
        const base = new Set(guaranteed.get(from) ?? new Set<string>());
        if (on === 'success') base.add(from);
        // failure/completion: `from` ran but did not necessarily succeed → its
        // outputs are NOT guaranteed; only what was guaranteed before it is.
        acc = acc === null ? base : intersect(acc, base);
      }
      guaranteed.set(id, acc ?? new Set());
    }
    for (const e of forward) {
      if (e.from !== id) continue;
      const d = (indegWork.get(e.to) ?? 0) - 1;
      indegWork.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }

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

  return { guaranteed, reachable, soft };
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
