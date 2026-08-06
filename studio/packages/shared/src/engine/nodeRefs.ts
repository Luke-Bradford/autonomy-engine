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
 * Rewrite every `nodes.<id>` in ONE `${}` body, skipping quoted string literals
 * so an id that appears inside a literal is never touched. Returns the body
 * unchanged when nothing matched.
 */
function remapBody(body: string, idMap: ReadonlyMap<string, string>): string {
  let out = '';
  let cut = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (isQuote(ch)) {
      const close = quotedSpanEnd(body, i);
      // An unterminated quote: nothing after it is structurally knowable, so stop
      // rewriting rather than guess. The save gate reports the real defect.
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (!atNamespace(body, i)) {
      i += 1;
      continue;
    }
    const idStart = i + NS.length + 1;
    const oldId = matchMappedId(body, idStart, idMap);
    if (oldId === null) {
      i = idStart;
      continue;
    }
    out += body.slice(cut, idStart) + (idMap.get(oldId) as string);
    cut = idStart + oldId.length;
    i = cut;
  }
  return cut === 0 ? body : out + body.slice(cut);
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
