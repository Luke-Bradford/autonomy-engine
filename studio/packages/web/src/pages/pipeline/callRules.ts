import type { CallConfig, Param } from '@autonomy-studio/shared';
import { listAllPipelineVersions } from '../../api/pipelines';
import { coerceDefaultInput, formatDefaultInput } from './paramRules';

/**
 * #425 — the call-node editor's pure half: its read model and its two write
 * paths, beside `CallPanel.tsx` the way `containerRules`/`paramRules` sit beside
 * the panels they serve.
 *
 * Every clobber hazard the panel has is decided HERE rather than in the JSX —
 * an expression mistaken for a dead id, a param key the newly-chosen target does
 * not declare, a blank that must mean "let the child decide" rather than "send
 * nothing" — so each is a function with a test rather than a branch inside a
 * render.
 */

/** One pickable target: a concrete version of a concrete pipeline. */
export type CallTarget = {
  pipelineId: string;
  pipelineName: string;
  versionId: string;
  version: number;
  params: Param[];
};

/**
 * Flatten every pipeline's versions into pickable targets.
 *
 * The load itself is `listAllPipelineVersions`, shared with the Triggers page's
 * binding dropdown, which asks the same question of the same two endpoints.
 * This function is only the projection into what the picker needs.
 */
export async function loadCallTargets(signal?: AbortSignal): Promise<CallTarget[]> {
  const all = await listAllPipelineVersions(signal);
  return all.map(({ pipeline, version }) => ({
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    versionId: version.id,
    version: version.version,
    params: version.params,
  }));
}

export type Mode = 'pick' | 'expression';

export type Seed = {
  mode: Mode;
  pipelineId: string;
  versionId: string;
  expression: string;
  wait: boolean;
  /** Raw text per param NAME — the union of the target's declared params and whatever the node already carries. */
  params: Record<string, string>;
  /** The whole `params` record as JSON, for a target this panel cannot resolve. */
  paramsJson: string;
};

/**
 * What the editor should display for a stored `call`, given the known targets.
 *
 * Exported for its own test: this is the whole of the panel's read model, and
 * every clobber hazard (an expression mistaken for a dead id, a param key the
 * new target does not declare) is decided here rather than in the JSX.
 */
export function seedCall(call: CallConfig | undefined, targets: readonly CallTarget[]): Seed {
  const stored = call?.pipelineVersionId ?? '';
  const match = targets.find((t) => t.versionId === stored);
  // A stored value that is not a known version is shown in the EXPRESSION field
  // whether it is a `${}` ref or the id of a deleted version. Both are literal
  // text the operator must be able to see and re-author; putting a dead id into
  // an empty picker instead would present the node as "no target chosen" and
  // lose the value on the first Apply. A brand-new node (no `call`) starts in
  // pick mode, which is the one this panel exists to make easy.
  const mode: Mode = stored === '' || match ? 'pick' : 'expression';
  return {
    mode,
    pipelineId: match?.pipelineId ?? '',
    versionId: match?.versionId ?? '',
    expression: match ? '' : stored,
    wait: call?.wait ?? false,
    params: seedParamText(call?.params ?? {}, match),
    paramsJson: Object.keys(call?.params ?? {}).length
      ? JSON.stringify(call?.params ?? {}, null, 2)
      : '',
  };
}

/**
 * Raw text per param name: every param the target DECLARES (so the operator is
 * told what the child expects instead of having to remember it), plus every key
 * the node already carries that the target does not declare.
 *
 * The union is the load-bearing half. Dropping an undeclared key would silently
 * discard an argument on the first Apply — including the whole argument list of
 * a node whose target was just re-pointed at a different pipeline, which is
 * exactly when an operator is least able to notice.
 */
function seedParamText(
  stored: Record<string, unknown>,
  target: CallTarget | undefined,
): Record<string, string> {
  return rowsFrom(stored, new Map((target?.params ?? []).map((p) => [p.name, p])));
}

/**
 * The row seeding itself, over a DECLARED map rather than a target.
 *
 * Split out because the mode switch needs the identical union — carrying a JSON
 * object back into typed rows is the same operation as seeding rows from a
 * stored call, and two spellings of it would be two answers about whether an
 * undeclared key survives.
 */
export function rowsFrom(
  stored: Record<string, unknown>,
  declared: ReadonlyMap<string, Param>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of declared.keys()) out[name] = '';
  for (const [k, v] of Object.entries(stored)) out[k] = formatDefaultInput(v);
  return out;
}

/**
 * Are two seeds the same, FIELD-WISE?
 *
 * Deliberately not `JSON.stringify(a) === JSON.stringify(b)`. `containerRules`
 * records why: `sameContainerConfig` replaced exactly that comparison, because
 * it makes "did anything change?" depend on the key order whichever module
 * happened to build the object in. Here that answer decides whether an
 * in-progress edit is DISCARDED and re-seeded, so a spurious inequality is a
 * clobber — the same failure the container panel's `sameSeededInputs` exists to
 * prevent, and this is its counterpart.
 */
export function sameSeed(a: Seed, b: Seed): boolean {
  return (
    a.mode === b.mode &&
    a.pipelineId === b.pipelineId &&
    a.versionId === b.versionId &&
    a.expression === b.expression &&
    a.wait === b.wait &&
    a.paramsJson === b.paramsJson &&
    sameText(a.params, b.params)
  );
}

function sameText(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => k in b && a[k] === b[k]);
}

/**
 * The keys a stored call carries as an explicit `''`.
 *
 * Computed from the STORED blob rather than tracked as draft state, because it
 * is a fact about what is persisted and must not drift as the operator types.
 */
export function storedBlankKeys(call: CallConfig | undefined): Set<string> {
  return new Set(
    Object.entries(call?.params ?? {})
      .filter(([, v]) => v === '')
      .map(([k]) => k),
  );
}

/**
 * Is this raw text a `${}` expression, to be stored verbatim rather than coerced?
 *
 * WHOLE-SPAN only: `foo-${params.x}` is treated as a literal and coerced against
 * the declared type, so it fits a `string` param and is rejected for a `number`.
 * That is deliberate and narrow — a whole-span ref is the form that needs to
 * escape coercion (its VALUE has the declared type; its text does not), while an
 * interpolated string is already a string. It is not parity with the config
 * surface's interpolation, and this panel makes no claim that it is.
 */
function isExpressionText(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('${') && t.endsWith('}');
}

type ParamsParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Typed argument values from the rows, using the SAME coercion the params
 * editor uses for a declaration's default (`coerceDefaultInput`) — one answer
 * about what `42` means in a `number` field, not two that happen to agree.
 *
 * BLANK omits the key rather than sending an empty value, so the child's own
 * default applies. That is the only way to say "let the child decide" here, and
 * it is what `coerceDefaultInput`'s blank case already means.
 *
 * EXCEPT for a key the node already carries as an explicit `''` (`storedBlank`).
 * `formatDefaultInput` renders that as a blank row, which is indistinguishable
 * on screen from "nothing entered" — so without this the argument would be
 * dropped merely by opening the node, editing some OTHER field and pressing
 * Apply, silently and with nothing on screen having said so. That is the same
 * class of loss as the mode-switch discard `switchMode` exists to prevent, so it
 * gets the same answer: a value the operator never touched survives. Clearing a
 * row that held a NON-blank value still omits the key, which is how "let the
 * child decide" is said.
 *
 * A `${}` value is stored VERBATIM whatever the declared type, because it is
 * resolved at dispatch and the text is not the value: coercing `${params.n}`
 * against a `number` param would reject the one form the schema documents.
 */
export function buildParams(
  text: Record<string, string>,
  declared: ReadonlyMap<string, Param>,
  storedBlank: ReadonlySet<string> = new Set(),
): ParamsParse {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(text)) {
    if (isExpressionText(raw)) {
      out[name] = raw.trim();
      continue;
    }
    if (raw === '' && storedBlank.has(name)) {
      out[name] = '';
      continue;
    }
    // An undeclared key has no type to coerce against, so it is carried as the
    // text it is — the alternative is guessing a type for a value this version
    // never asked for.
    const decl = declared.get(name);
    if (!decl) {
      if (raw.trim() !== '') out[name] = raw;
      continue;
    }
    const parsed = coerceDefaultInput(decl.type, raw);
    if (!parsed.ok) return { ok: false, error: `${name}: ${parsed.error}` };
    if (parsed.has) out[name] = parsed.value;
  }
  return { ok: true, value: out };
}

/** The unresolved-target fallback: the whole record, as JSON. Blank means none. */
export function parseJsonParams(raw: string): ParamsParse {
  const text = raw.trim();
  if (text === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Parameters: expected valid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Parameters: expected a JSON object.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
