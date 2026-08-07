import { useEffect, useMemo, useState } from 'react';
import type { CallConfig } from '@autonomy-studio/shared';
import {
  buildParams,
  loadCallTargets,
  parseJsonParams,
  rowsFrom,
  sameSeed,
  seedCall,
  storedBlankKeys,
  type CallTarget,
  type Mode,
  type Seed,
} from './callRules';
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
 * #953 widened WHEN this panel is reached: the inspector now routes on
 * `authorsCallBlob`, not on `isStructuralCallActivity` alone, so a legacy node
 * carrying `Node.call` under a different `type` (an imported or API-seeded
 * `call_pipeline`) gets this editor too. The reasoning above is unchanged and
 * applies harder to that case — such a type is not catalogued at all, so the
 * generic form derived no fields and the blob was simply uneditable.
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
      .then((t) => {
        if (controller.signal.aborted) return;
        setTargets(t);
      })
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
    <section className="contract-section">
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
  if (!sameSeed(syncedSeed, seeded)) {
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
  /** Keys the STORED call carries as an explicit `''` — see `buildParams`. */
  const storedBlank = useMemo(() => storedBlankKeys(call), [call]);
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

  /**
   * Switch target mode, CARRYING the arguments across.
   *
   * The two params editors hold the same fact in two shapes — typed rows when
   * the target resolves to a listable version, a JSON object when it does not —
   * and `apply` reads whichever the current mode owns. Toggling the mode without
   * reconciling them therefore SILENTLY DISCARDED whatever the operator had
   * entered in the other one: type three arguments into the rows, switch to
   * Expression to write a dynamic target, press Apply, and the arguments are
   * gone with nothing on screen having said so.
   *
   * So a switch translates. When the source cannot be represented — a row that
   * is not a legal value for its declared type, or a JSON box that does not
   * parse — the switch is REFUSED with that reason rather than completed lossily.
   * That is not a trap: the offending text stays visible and editable in the
   * mode the operator is already in, so fixing it (or clearing it) is the way
   * through.
   */
  function switchMode(next: Mode) {
    if (next === draft.mode) return;
    if (next === 'expression') {
      const built = buildParams(draft.params, declared, storedBlank);
      if (!built.ok) {
        setError(built.error);
        return;
      }
      const json = Object.keys(built.value).length ? JSON.stringify(built.value, null, 2) : '';
      setError(null);
      setDraft((d) => ({ ...d, mode: next, paramsJson: json }));
      return;
    }
    const parsed = parseJsonParams(draft.paramsJson);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setDraft((d) => ({ ...d, mode: next, params: rowsFrom(parsed.value, declared) }));
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

    const params =
      draft.mode === 'expression' || !chosen
        ? parseJsonParams(draft.paramsJson)
        : buildParams(draft.params, declared, storedBlank);
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
      <fieldset className="call-mode">
        <legend>Target</legend>
        <label>
          <input
            type="radio"
            name={`call-mode-${nodeId}`}
            checked={draft.mode === 'pick'}
            onChange={() => switchMode('pick')}
          />
          Pick a version
        </label>
        <label>
          <input
            type="radio"
            name={`call-mode-${nodeId}`}
            checked={draft.mode === 'expression'}
            onChange={() => switchMode('expression')}
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

      <label className="contract-check">
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
                      <span className="page-hint">
                        not declared by this version — will be sent anyway
                      </span>
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
