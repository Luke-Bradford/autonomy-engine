// ---------------------------------------------------------------------------
// U21 — rewriting `${nodes.<id>…}` references when nodes are COPIED.
//
// Copying ONE node is safe without this: its refs name nodes OUTSIDE the copied
// set, those still exist, and the copy pointing at the same upstream is what an
// author means. The moment MORE THAN ONE node is copied together, a ref BETWEEN
// members of the copied set has to be remapped to the new id, or the copy
// silently keeps reading the ORIGINAL — a wrong doc that validates, saves, and
// runs. Duplicate-selection, paste and (later) container duplication all need
// exactly this, so it lives here once rather than in the canvas store.
//
// WHY A CHARACTER SCANNER AND NOT THE AST. `parseExpr` gives an exact structure
// but no source offsets, and the AST is deliberately one-way (`Expr.ref.source`
// is documented as an opaque diagnostic string, and there is no printer) — so an
// AST-driven rewrite would mean threading offsets through a grammar read by
// `substitute`, `checkExprStatic`, `inferExprType` and `availableRefs`, in
// service of a canvas gesture. It also would not work where it is most needed:
// `parseExpr` THROWS on a malformed body, and a mid-edit canvas config is
// routinely malformed (that is what the validation badge is for), so the
// AST route must fall back to "leave unchanged" on exactly the strings most at
// risk — which is this scanner's behaviour anyway.
//
// This is the THIRD scanner over this grammar, and that is a choice, not an
// accident. The other two are `findRefEnd`/`parseRefAt` here in `expr.ts` (the
// grammar itself, which cannot locate a sub-path in a raw body) and the textual
// gloss in the web `containerRules.ts` (deliberately tolerant, display-only, and
// documented as such). This one is held to the grammar by a property test in
// `nodeRefs.test.ts`: parse before and after, and the structures must be
// identical except at the node-id position.
//
// It shares the ONE quoting rule (`isQuote`/`quotedSpanEnd`) and the ONE `${}`
// boundary scan (`scanTemplateRefs`) with everything else in `expr.ts`, so it
// cannot drift on where a string literal or a ref begins and ends.
//
// #1600 C8b — it also renames an OUTPUT read from one node
// (`renameNodeOutputRefs`), for a retired type whose replacement renames an
// output. That is not a fourth scanner: both rewrites run on the one body walk
// (`walkBody`) and differ only in what they do at a matched `nodes.<id>`, and
// the rename has its own grammar property test beside the id one.
// ---------------------------------------------------------------------------

import { isQuote, quotedSpanEnd, scanTemplateRefs } from './expr.js';
import { MAX_CONFIG_DEPTH } from './params.js';

/** The namespace a node reference is rooted at — `${nodes.<id>.output.x}`. */
const NS = 'nodes';

/**
 * `$${` masked so the boundary scan cannot see the `${` inside it, WITHOUT
 * changing any offset (same length, three chars).
 *
 * Deliberately NOT `protectEscapes`/`restoreEscapes`: that pair is the
 * SUBSTITUTION round trip, where an escape RESOLVES — `restoreEscapes` yields a
 * literal `${`, not the `$${` it started from. Correct when producing a
 * substituted value; silently un-escaping when the job is to hand back a string
 * that is byte-identical wherever nothing matched.
 *
 * The mask char is NUL, which no authored config carries; a string that somehow
 * does contain one is returned unrewritten rather than risking an unmask that
 * invents a `$${` the author never wrote.
 */
const MASK_CHAR = '\u0000';
const MASK_OPEN = `$$${MASK_CHAR}`;
const ESCAPED_OPEN = '$${';

/**
 * A char that ends a reference PATH inside a raw expression body. The grammar's
 * own `readField` stops only at `.`/`[`/`]` because it is handed a path already
 * split out of the body; scanning a raw body has to stop at the expression
 * syntax around it too (`add(nodes.a.output.x, 1)`).
 *
 * This charset is NOT how the id is recognised — see `matchMappedId`, which
 * matches map keys literally so an id containing any of these characters can
 * never be half-read. The set only decides where a path ENDS, which matters for
 * the "the id is followed by a delimiter" check.
 */
function endsPath(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === '.' ||
    ch === '[' ||
    ch === ']' ||
    ch === ',' ||
    ch === ')' ||
    ch === '(' ||
    ch === '}' ||
    isQuote(ch) ||
    /\s/.test(ch)
  );
}

/**
 * Is `s[i..]` the namespace token `nodes`, at the START of a path?
 *
 * Both boundaries have to be checked, and checking only the trailing one is a
 * silent-corruption bug rather than a near miss: `${nodes.a.output.childnodes.a}`
 * has the substring `nodes` inside the FIELD `childnodes`, followed by a `.`, so
 * a trailing-only test reads `childnodes.a` as a second node reference and
 * rewrites an id that is not one.
 *
 * The leading rule comes from the grammar, which has no infix operators
 * (`parseExprAt` is call / ref / string / number / bool and nothing else). A
 * path can therefore begin in exactly four places: the start of the body, after
 * whitespace, after a `,` or `(` in an argument list, or after a `[` opening an
 * index — an index body is its own expression, so `${a[nodes.x.output.i]}` is a
 * genuine namespace. Everything else (a `.`, a `]`, a `)`, a quote, any field
 * character) means this `nodes` is part of something larger.
 */
function atNamespace(s: string, i: number): boolean {
  if (!s.startsWith(NS, i)) return false;
  // The namespace is a whole token: `nodesX` is a different name entirely.
  if (s[i + NS.length] !== '.') return false;
  const prev = s[i - 1];
  if (prev === undefined) return true;
  return prev === ',' || prev === '(' || prev === '[' || /\s/.test(prev);
}

/**
 * The longest map key that occurs literally at `s[i..]` and is followed by a
 * path delimiter, or `null`.
 *
 * Matching keys LITERALLY (rather than reading a token and looking it up) is
 * what makes this safe for the ids actually in play: `newLocalId` mints
 * `n_<uuid>`, which contains hyphens, and an id from an imported doc may contain
 * anything the grammar's permissive field charset allows. Longest-first so a key
 * that is a prefix of another (`n_1` vs `n_1-extra`) cannot shadow it.
 */
function matchMappedId(s: string, i: number, idMap: ReadonlyMap<string, string>): string | null {
  let best: string | null = null;
  for (const oldId of idMap.keys()) {
    if (oldId.length === 0) continue;
    if (best !== null && oldId.length <= best.length) continue;
    if (!s.startsWith(oldId, i)) continue;
    if (!endsPath(s[i + oldId.length])) continue;
    best = oldId;
  }
  return best;
}

/**
 * What a `walkBody` visitor does at one `nodes.<id>` of a mapped id: splice
 * `text` over `[from, to)` (or leave the body as is) and carry on at `resume`,
 * or give up on the whole body.
 */
type Visit = { splice?: { from: number; to: number; text: string }; resume: number } | 'refuse';

/**
 * The ONE walk of a `${}` body, shared by the id rewriter (`remapBody`) and the
 * output renamer (`renameOutputsInBody`), so they cannot disagree on where a
 * reference is: quoted literals are skipped, and `visit` is called at each
 * `nodes.<id>` whose id is a key of `idMap`, with the offset just past the id.
 *
 * An unterminated quote leaves what follows structurally unknowable, so the
 * walk stops there: `onUnterminated` says whether the body so far stands
 * (`'stop'`) or the whole body is refused. Returns the body unchanged (the same
 * string) when nothing was spliced, `undefined` when refused.
 */
function walkBody(
  body: string,
  idMap: ReadonlyMap<string, string>,
  visit: (id: string, idStart: number, idEnd: number) => Visit,
  onUnterminated: (at: number) => 'stop' | 'refuse',
): string | undefined {
  let out = '';
  let cut = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (isQuote(ch)) {
      const close = quotedSpanEnd(body, i);
      if (close === -1) {
        if (onUnterminated(i) === 'refuse') return undefined;
        break;
      }
      i = close + 1;
      continue;
    }
    if (!atNamespace(body, i)) {
      i += 1;
      continue;
    }
    const idStart = i + NS.length + 1;
    const id = matchMappedId(body, idStart, idMap);
    if (id === null) {
      i = idStart;
      continue;
    }
    const step = visit(id, idStart, idStart + id.length);
    if (step === 'refuse') return undefined;
    if (step.splice !== undefined) {
      out += body.slice(cut, step.splice.from) + step.splice.text;
      cut = step.splice.to;
    }
    i = step.resume;
  }
  return cut === 0 ? body : out + body.slice(cut);
}

/**
 * Rewrite every `nodes.<id>` in ONE `${}` body, skipping quoted string literals
 * so an id that appears inside a literal is never touched. Returns the body
 * unchanged when nothing matched.
 */
function remapBody(body: string, idMap: ReadonlyMap<string, string>, seen?: Set<string>): string {
  // An unterminated quote: stop rewriting rather than guess. The save gate
  // reports the real defect.
  return walkBody(
    body,
    idMap,
    (id, idStart, idEnd) => {
      seen?.add(id);
      return { splice: { from: idStart, to: idEnd, text: idMap.get(id) as string }, resume: idEnd };
    },
    () => 'stop',
  ) as string;
}

/**
 * Rewrite every `${nodes.<id>…}` reference in `s` whose id is a key of `idMap`.
 *
 * Text OUTSIDE a `${}` span is never touched, `$${` escapes survive the round
 * trip, and an UNTERMINATED `${` yields `s` unchanged: `scanTemplateRefs` stops
 * at the open brace and reports only the refs before it, so splicing its matches
 * without that check would silently TRUNCATE the tail (its own docblock demands
 * the check). Leaving it alone hands an intact string to the save gate, which is
 * the thing that reports the defect.
 */
export function remapNodeRefsInString(s: string, idMap: ReadonlyMap<string, string>): string {
  if (idMap.size === 0 || !s.includes('${') || s.includes(MASK_CHAR)) return s;
  const scanned = s.split(ESCAPED_OPEN).join(MASK_OPEN);
  const { matches, unterminatedAt } = scanTemplateRefs(scanned);
  if (unterminatedAt !== null || matches.length === 0) return s;

  // Right-to-left, so an earlier match's offsets survive a later splice.
  let out = scanned;
  for (let k = matches.length - 1; k >= 0; k -= 1) {
    const m = matches[k] as { start: number; end: number; body: string };
    const body = remapBody(m.body, idMap);
    if (body === m.body) continue;
    out = `${out.slice(0, m.start + 2)}${body}${out.slice(m.end)}`;
  }
  return out === scanned ? s : out.split(MASK_OPEN).join(ESCAPED_OPEN);
}

/**
 * `remapNodeRefsInString` over every string leaf of a config tree, returning a
 * fresh structure (the input is never mutated).
 *
 * The walk is bounded by `MAX_CONFIG_DEPTH`, the same cap `scan` and
 * `walkConfigForMarkers` hold it to (#537), and for the same reason: a
 * pathologically nested config must not reach a raw `RangeError`. Over the cap
 * the subtree is returned AS IS rather than throwing — this is a rewriter, and
 * an un-remapped ref is a defect the save gate names, where a thrown stack
 * overflow out of a keypress is not something the canvas can report at all.
 *
 * It walks EVERYTHING, deliberately including the deferred-eval subtrees that
 * `validateRefs`'s generic scan must skip (`llm_call.tools`, a `filter`
 * predicate). Those carry `${nodes.<id>}` references too, and remapping is
 * scope-independent: it only ever touches an id that is being copied, so there
 * is no scope in which the answer differs. Object KEYS are structural and are
 * left alone — only values are rewritten.
 */
export function remapNodeRefs<T>(value: T, idMap: ReadonlyMap<string, string>): T {
  // The walk itself is the clone — it rebuilds every array and object it meets,
  // so an empty map still yields a fresh structure and callers need no second
  // copy. (`structuredClone` is not reachable here: `shared` compiles without
  // the DOM lib, and the input is parsed JSON regardless.)
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return remapNodeRefsInString(v, idMap);
    if (depth > MAX_CONFIG_DEPTH) return v;
    if (Array.isArray(v)) return v.map((child) => walk(child, depth + 1));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(child, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}

/**
 * #935 — which of `ids` a config tree READS through a `${nodes.<id>…}` reference.
 *
 * The same body scanner (`remapBody`, run with an identity map and a record of
 * what matched) as `remapNodeRefs`, rather than a fourth reader of the grammar:
 * "which node ids does this reference" and "rewrite these node ids" have to
 * agree on what a reference IS. So quoted literals, prose and `$${` escapes are
 * excluded, and deferred-eval subtrees are included.
 *
 * It does NOT share `remapNodeRefs`'s bail-outs, and that is the point of having
 * its own walk and string step. A rewriter may leave a string it cannot safely
 * round-trip untouched — one holding the NUL mask char, or with an unterminated
 * `${` — because an unrewritten string is reported by the save gate. This answer
 * is a GUARD: a paste is refused on it, so a string skipped here is a read that
 * silently passes. The mask only has to be reversible when output is produced,
 * and nothing is produced here; an unterminated span still yields every span
 * before it. Nor does it stop at `MAX_CONFIG_DEPTH`: that cap is counted from
 * wherever the save gate starts (a node's config, a param bag), and a caller
 * handing in a whole node would start the count levels higher, so a ref the gate
 * accepts could sit past the cutoff unread. The walk is ITERATIVE instead, so no
 * depth can overflow the stack, and every string leaf is read.
 */
export function referencedNodeIds(value: unknown, ids: Iterable<string>): string[] {
  const identity = new Map<string, string>();
  for (const id of ids) identity.set(id, id);
  const seen = new Set<string>();
  if (identity.size === 0) return [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const v = pending.pop();
    if (typeof v === 'string') {
      if (!v.includes('${')) continue;
      const { matches } = scanTemplateRefs(v.split(ESCAPED_OPEN).join(MASK_OPEN));
      for (const m of matches) remapBody(m.body, identity, seen);
    } else if (Array.isArray(v)) {
      for (const child of v) pending.push(child);
    } else if (v !== null && typeof v === 'object') {
      for (const child of Object.values(v as Record<string, unknown>)) pending.push(child);
    }
  }
  return [...seen];
}

/**
 * #1600 C8b — rename the OUTPUT NAMES read from ONE node:
 * `${nodes.<id>.output.<old>…}` → `${nodes.<id>.output.<new>…}`, for each
 * `old → new` in `renames`, across every string leaf of `value`.
 *
 * A retired type whose replacement renames an output (List directory's
 * `entries` is Get metadata's `childItems`) is lowered only if every read of it
 * can be rewritten (`retired.ts`, "faithful or not at all"). So this is a
 * rewriter AND a guard, and it answers `undefined` where it cannot be sure:
 * - the node is read as anything but `.output.<field>` or `.status` (a bare
 *   `.output`, an indexed `.output[…]`), so which output it means is unknown;
 * - a string names `nodes.<id>` but cannot be scanned (an unterminated `${` or
 *   quote, or the NUL mask char), so a read may hide in it;
 * - a subtree past `MAX_CONFIG_DEPTH` names `nodes.<id>`. Counted from where the
 *   caller starts, which may be above a config, so a deep config the save gate
 *   accepts can be refused here. That is the safe side: the node stays as is.
 *
 * The same scanner pieces as `remapBody` (the namespace and id matching, the
 * one quoting rule, the escape mask), so a read this sees is one the copy
 * rewriter sees. Copy-on-write: an unchanged subtree is returned by reference.
 */
export function renameNodeOutputRefs<T>(
  value: T,
  id: string,
  renames: ReadonlyMap<string, string>,
): T | undefined {
  const idMap = new Map([[id, id]]);
  const token = `${NS}.${id}`;
  const REFUSED = Symbol('refused');
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return renameOutputsInString(v, token, idMap, renames) ?? REFUSED;
    if (v === null || typeof v !== 'object') return v;
    if (depth > MAX_CONFIG_DEPTH) return namesAnywhere(v, token) ? REFUSED : v;
    if (Array.isArray(v)) {
      let changed = false;
      const out: unknown[] = [];
      for (const child of v) {
        const next = walk(child, depth + 1);
        if (next === REFUSED) return REFUSED;
        changed ||= next !== child;
        out.push(next);
      }
      return changed ? out : v;
    }
    let changed = false;
    const out: [string, unknown][] = [];
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const next = walk(child, depth + 1);
      if (next === REFUSED) return REFUSED;
      changed ||= next !== child;
      out.push([k, next]);
    }
    // `fromEntries` defines each key as an own property, so a parsed doc's own
    // `__proto__` key stays a key rather than becoming the prototype.
    return changed ? Object.fromEntries(out) : v;
  };
  const result = walk(value, 0);
  return result === REFUSED ? undefined : (result as T);
}

/**
 * Does any string leaf of `v` contain `token`? Iterative, so no depth can
 * overflow it, and on the leaves themselves rather than a JSON encoding, which
 * would escape an id's quote or backslash out of reach.
 */
function namesAnywhere(v: unknown, token: string): boolean {
  const pending: unknown[] = [v];
  while (pending.length > 0) {
    const x = pending.pop();
    if (typeof x === 'string') {
      if (x.includes(token)) return true;
    } else if (Array.isArray(x)) {
      pending.push(...x);
    } else if (x !== null && typeof x === 'object') {
      pending.push(...Object.values(x as Record<string, unknown>));
    }
  }
  return false;
}

/** `renameNodeOutputRefs` on one string: the renamed string, or `undefined` when unsure. */
function renameOutputsInString(
  s: string,
  token: string,
  idMap: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
): string | undefined {
  // Cannot read the node at all: nothing to rename and nothing to doubt.
  if (!s.includes(token)) return s;
  if (s.includes(MASK_CHAR)) return undefined;
  const scanned = s.split(ESCAPED_OPEN).join(MASK_OPEN);
  const { matches, unterminatedAt } = scanTemplateRefs(scanned);
  if (unterminatedAt !== null) return undefined;
  let out = scanned;
  for (let k = matches.length - 1; k >= 0; k -= 1) {
    const m = matches[k] as { start: number; end: number; body: string };
    const body = renameOutputsInBody(m.body, token, idMap, renames);
    if (body === undefined) return undefined;
    if (body === m.body) continue;
    out = `${out.slice(0, m.start + 2)}${body}${out.slice(m.end)}`;
  }
  return out === scanned ? s : out.split(MASK_OPEN).join(ESCAPED_OPEN);
}

const OUTPUT_SEGMENT = '.output.';
const STATUS_SEGMENT = '.status';

/**
 * One `${}` body of `renameOutputsInString`, on `walkBody`. At `nodes.<id>`: a
 * `.status` read is left alone, `.output.<field>` has its field renamed when it
 * is one of `renames`, and anything else is refused.
 *
 * The field ends where the grammar's would only if what follows is a path
 * delimiter. `readField` reads up to `.`/`[`/`]`, so `output.entries x` is the
 * one field `entries x`: whitespace followed by more field text is refused
 * rather than read as `entries`.
 */
function renameOutputsInBody(
  body: string,
  token: string,
  idMap: ReadonlyMap<string, string>,
  renames: ReadonlyMap<string, string>,
): string | undefined {
  return walkBody(
    body,
    idMap,
    (_id, _idStart, p) => {
      if (body.startsWith(STATUS_SEGMENT, p) && endsPath(body[p + STATUS_SEGMENT.length])) {
        return { resume: p + STATUS_SEGMENT.length };
      }
      if (!body.startsWith(OUTPUT_SEGMENT, p)) return 'refuse';
      const fieldStart = p + OUTPUT_SEGMENT.length;
      let fieldEnd = fieldStart;
      while (fieldEnd < body.length && !endsPath(body[fieldEnd])) fieldEnd += 1;
      if (fieldEnd === fieldStart) return 'refuse';
      let next = fieldEnd;
      while (next < body.length && /\s/.test(body[next] as string)) next += 1;
      if (next > fieldEnd && !endsPath(body[next])) return 'refuse';
      const renamed = renames.get(body.slice(fieldStart, fieldEnd));
      return renamed === undefined
        ? { resume: fieldEnd }
        : { splice: { from: fieldStart, to: fieldEnd, text: renamed }, resume: fieldEnd };
    },
    // Where the literal ends is unknowable, so a read after it cannot be ruled out.
    (at) => (body.includes(token, at) ? 'refuse' : 'stop'),
  );
}
