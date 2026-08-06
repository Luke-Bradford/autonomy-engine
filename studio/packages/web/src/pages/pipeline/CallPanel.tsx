import { useEffect, useMemo, useState } from 'react';
import type { CallConfig, Param, PipelineVersion } from '@autonomy-studio/shared';
import { listPipelines, listPipelineVersions } from '../../api/pipelines';
import { coerceDefaultInput, formatDefaultInput } from './paramRules';
import type { createCanvasStore } from './canvasStore';

/**
 * #425 — the call-node editor: the authoring surface for `Node.call`.
 *
 * The last of #425's four gaps. Containers (U6d/U23), back-edges (U6e) and the
 * pipeline's own params/outputs (U16) all became authorable; a `call_pipeline`
 * node stayed API-only, so "this pipeline runs that pipeline" — the one
 * composition primitive the engine has — could not be built on the canvas at
 * all. `NodePanel` showed a read-only stub naming this ticket.
 *
 * ## Why it is not the generic config form
 *
 * `execute_pipeline`'s settings live in `Node.call`, not `Node.config`
 * (`isStructuralCallActivity`, the catalog's structural-call exception). The
 * schema→form engine (`deriveConfigFields`) authors `node.config`, so pointing
 * it at `CallConfigSchema` would produce a form whose every apply fails
 * validation against a field it cannot see. Hence a dedicated panel, in its own
 * file, on the `ContainerPanel` precedent.
 *
 * ## One draft, one Apply, one undo entry
 *
 * Target, `wait` and every param edit land as a SINGLE `updateNodeCall` write.
 * Applying the controls independently would be three history entries for one
 * intent, and worse: the declared params on offer are a property OF the chosen
 * target, so a target written before its params were re-entered would leave a
 * node holding the previous target's argument list.
 *
 * ## The load window is the hazard
 *
 * Whether a stored `pipelineVersionId` is a pickable version or a `${}`
 * expression can only be answered once the version list has arrived. Deciding
 * it earlier would read "not in the list" for a perfectly good literal id and
 * silently flip the panel into expression mode. So this component renders a
 * loading state and mounts the editor only once the targets are known — the
 * seed is then computed once, from complete information, and nothing is written
 * to the store until the operator presses Apply.
 *
 * ## Known limitation (stated, not silently shipped)
 *
 * `validateRefs` walks `node.config`/`connectionId`/`connectionParams` and does
 * NOT scan `node.call`, so a `${}` written into a target or a param value gets
 * none of the save-time existence/type checking the rest of the config surface
 * gets — it fails at dispatch instead. `validateCallGraph`'s self-call and
 * depth guard (`maxCallDepth`, default 3) likewise only walks LITERAL targets.
 * The expression control says so on screen rather than implying parity.
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
 * N+1 requests (one per pipeline), which is what `TriggersPage` already does
 * for its binding picker at the same scale. Loading them ALL up front — rather
 * than fetching versions when a pipeline is chosen — is what lets the panel
 * answer "is this stored id a known version?" in one shot, with no second
 * in-flight window in which the answer changes.
 */
export async function loadCallTargets(signal?: AbortSignal): Promise<CallTarget[]> {
  const pipelines = await listPipelines(signal);
  const perPipeline = await Promise.all(
    pipelines.map(async (p) => {
      const versions: PipelineVersion[] = await listPipelineVersions(p.id, signal);
      return versions.map((v) => ({
        pipelineId: p.id,
        pipelineName: p.name,
        versionId: v.id,
        version: v.version,
        params: v.params,
      }));
    }),
  );
  return perPipeline.flat();
}

type Mode = 'pick' | 'expression';

type Seed = {
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
function seedParamText(stored: Record<string, unknown>, target: CallTarget | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of target?.params ?? []) out[p.name] = '';
  for (const [k, v] of Object.entries(stored)) out[k] = formatDefaultInput(v);
  return out;
}

/** Is this raw text a `${}` expression, to be stored verbatim rather than coerced? */
function isExpressionText(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('${') && t.endsWith('}');
}

export function CallPanel({
  store,
  nodeId,
  call,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
  call: CallConfig | undefined;
}) {
  const [targets, setTargets] = useState<CallTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadCallTargets(controller.signal)
      .then((t) => setTargets(t))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, []);

  // The heading is OUTSIDE the branch on purpose: it names the section, and a
  // section that appears only once a fetch resolves reads as a panel that is
  // missing rather than one that is loading.
  return (
    <section className="call-panel">
      <h4>Call target</h4>
      {loadError !== null ? (
        // Fail LOUD. A silent empty picker would read as "there are no
        // pipelines", which is a different and much more alarming fact.
        <p className="form-error">Could not load pipelines: {loadError}</p>
      ) : targets === null ? (
        <p className="page-hint">Loading pipelines…</p>
      ) : (
        <CallEditor store={store} nodeId={nodeId} call={call} targets={targets} />
      )}
    </section>
  );
}

function CallEditor({
  store,
  nodeId,
  call,
  targets,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
  call: CallConfig | undefined;
  targets: CallTarget[];
}) {
  const seeded = useMemo(() => seedCall(call, targets), [call, targets]);
  const [draft, setDraft] = useState<Seed>(seeded);
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-seed when the STORED call changes, keyed on the seed itself rather than
   * on the `call` object's identity — `ContainerPanel`'s rule, for its reason.
   * An undo replaces `node.call` without remounting this panel, so a form that
   * never re-seeded would go on showing the value that was just undone; keying
   * on identity instead would discard an in-progress edit every time some other
   * action mints a new node object.
   */
  const [syncedSeed, setSyncedSeed] = useState(seeded);
  if (JSON.stringify(syncedSeed) !== JSON.stringify(seeded)) {
    setSyncedSeed(seeded);
    setDraft(seeded);
    setError(null);
  }

  const pipelines = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of targets) byId.set(t.pipelineId, t.pipelineName);
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [targets]);
  const versions = useMemo(
    () => targets.filter((t) => t.pipelineId === draft.pipelineId),
    [targets, draft.pipelineId],
  );
  const chosen = useMemo(
    () => targets.find((t) => t.versionId === draft.versionId),
    [targets, draft.versionId],
  );
  /**
   * The param rows follow the DRAFT target, not the stored one, so re-pointing
   * the picker immediately shows what the new child declares. Undeclared keys
   * the node already carries stay on the list (flagged) rather than vanishing.
   */
  const declared = useMemo(() => new Map((chosen?.params ?? []).map((p) => [p.name, p])), [chosen]);
  const rows = useMemo(() => {
    const names = new Set([...declared.keys(), ...Object.keys(draft.params)]);
    return [...names].sort();
  }, [declared, draft.params]);

  function setPipeline(pipelineId: string) {
    // Choosing a pipeline clears the version: a version id from the previous
    // pipeline is not a legal target of this one, and leaving it selected would
    // show a coherent-looking pair that names two different pipelines.
    setDraft((d) => ({ ...d, pipelineId, versionId: '' }));
  }

  function apply() {
    const target = draft.mode === 'expression' ? draft.expression.trim() : draft.versionId;
    if (target === '') {
      setError(
        draft.mode === 'expression'
          ? 'Enter an expression or a version id.'
          : 'Choose a pipeline and a version.',
      );
      return;
    }

    const params = draft.mode === 'expression' || !chosen ? parseJsonParams(draft.paramsJson) : buildParams(draft.params, declared);
    if (!params.ok) {
      setError(params.error);
      return;
    }

    setError(null);
    const next: CallConfig = { pipelineVersionId: target, params: params.value };
    // `wait` is absent-or-present, not nullable: writing `wait: false` would
    // persist a choice the operator never made, and the schema's own default is
    // the honest representation of "not specified".
    if (draft.wait) next.wait = true;
    store.getState().updateNodeCall(nodeId, next);
  }

  return (
    <>
      <fieldset className="radio-group">
        <legend>Target</legend>
        <label>
          <input
            type="radio"
            name={`call-mode-${nodeId}`}
            checked={draft.mode === 'pick'}
            onChange={() => setDraft((d) => ({ ...d, mode: 'pick' }))}
          />
          Pick a version
        </label>
        <label>
          <input
            type="radio"
            name={`call-mode-${nodeId}`}
            checked={draft.mode === 'expression'}
            onChange={() => setDraft((d) => ({ ...d, mode: 'expression' }))}
          />
          Expression
        </label>
      </fieldset>

      {draft.mode === 'pick' ? (
        <>
          <label>
            Pipeline
            <select value={draft.pipelineId} onChange={(e) => setPipeline(e.target.value)}>
              <option value="">— choose —</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <select
              value={draft.versionId}
              onChange={(e) => setDraft((d) => ({ ...d, versionId: e.target.value }))}
              disabled={draft.pipelineId === ''}
            >
              <option value="">— choose —</option>
              {versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <label>
          Version id or expression
          <input
            value={draft.expression}
            onChange={(e) => setDraft((d) => ({ ...d, expression: e.target.value }))}
            placeholder="${params.target}"
          />
          <span className="page-hint">
            A <code>{'${}'}</code> target is resolved when the node dispatches. It is not checked
            when you save, and the self-call and call-depth guards only see literal targets.
          </span>
        </label>
      )}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.wait}
          onChange={(e) => setDraft((d) => ({ ...d, wait: e.target.checked }))}
        />
        Wait for the child run to finish
      </label>

      <h4>Parameters</h4>
      {draft.mode === 'pick' && !chosen ? (
        // Pick mode with nothing chosen yet: the arguments are a property OF the
        // target, so there is nothing honest to offer — and offering the JSON
        // fallback here would invite an operator to hand-write a record this
        // panel is about to be able to type for them.
        <p className="page-hint">Choose a version to see the parameters it declares.</p>
      ) : draft.mode === 'pick' && chosen ? (
        rows.length === 0 ? (
          <p className="page-hint">This pipeline version declares no parameters.</p>
        ) : (
          <ul className="call-params">
            {rows.map((name) => {
              const decl = declared.get(name);
              return (
                <li key={name}>
                  <label>
                    {name}
                    {decl ? (
                      <span className="page-hint">
                        {decl.type}
                        {decl.required ? ' · required' : ''}
                      </span>
                    ) : (
                      <span className="page-hint">not declared by this version — will be sent anyway</span>
                    )}
                    <input
                      value={draft.params[name] ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, params: { ...d.params, [name]: e.target.value } }))
                      }
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <label>
          Parameters (JSON object)
          <textarea
            value={draft.paramsJson}
            onChange={(e) => setDraft((d) => ({ ...d, paramsJson: e.target.value }))}
            rows={4}
            placeholder="{}"
          />
          <span className="page-hint">
            The target is not a version this workspace can list, so its declared parameters are
            unknown — enter the arguments directly.
          </span>
        </label>
      )}

      {error !== null && <p className="form-error">{error}</p>}
      <button type="button" onClick={apply}>
        Apply call
      </button>
    </>
  );
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
 * A `${}` value is stored VERBATIM whatever the declared type, because it is
 * resolved at dispatch and the text is not the value: coercing `${params.n}`
 * against a `number` param would reject the one form the schema documents.
 */
export function buildParams(
  text: Record<string, string>,
  declared: ReadonlyMap<string, Param>,
): ParamsParse {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(text)) {
    if (isExpressionText(raw)) {
      out[name] = raw.trim();
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
