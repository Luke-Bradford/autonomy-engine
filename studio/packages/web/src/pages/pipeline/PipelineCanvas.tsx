import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  getActivity,
  isStructuralCallActivity,
  type ConnectionPublic,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { createPipelineVersion, latestVersion, listPipelineVersions } from '../../api/pipelines';
import { listConnections } from '../../api/connections';
import { ActivityToolbox } from './ActivityToolbox';
import { createCanvasStore } from './canvasStore';
import { canSave, toVersionBody, validateCanvas } from './canvasDoc';
import {
  branchOptionsFor,
  conditionOf,
  decodeConditionValue,
  edgeLabel,
  encodeCondition,
  OPERATIONAL_CONDITIONS,
  takenConditions,
  type EdgeCondition,
} from './edgeCondition';
import { FlowCanvas } from './FlowCanvas';

interface PipelineCanvasProps {
  pipelineId: string;
  pipelineName: string;
  onBack: () => void;
}

/**
 * The authoring canvas for one pipeline: loads the latest immutable version
 * into a working store, renders the React Flow editor with a palette and a
 * property panel, and saves the working graph as a NEW immutable version.
 */
export function PipelineCanvas({ pipelineId, pipelineName, onBack }: PipelineCanvasProps) {
  const store = useState(() => createCanvasStore())[0];
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Initial load: the promise-callback form keeps setState off the synchronous
  // effect body (React's `set-state-in-effect` guidance). The parent keys this
  // component by pipeline id, so a different pipeline remounts it fresh — no
  // in-place pipelineId change to reset for.
  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([listPipelineVersions(pipelineId, ctrl.signal), listConnections(ctrl.signal)])
      .then(([versions, conns]) => {
        store.getState().loadVersion(latestVersion(versions));
        setConnections(conns);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [pipelineId, store]);

  const loaded = useStore(store, (s) => s.loaded);
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const dirty = useStore(store, (s) => s.dirty);

  // `loaded` STAYS in the dep list alongside `containers` (#746): it still feeds
  // `params`, which containers moving into the store does not change.
  const issues = useMemo(
    () => validateCanvas(nodes, edges, containers, loaded?.params ?? []),
    [nodes, edges, containers, loaded],
  );

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    // Snapshot the exact graph being saved. Store mutations always produce new
    // array references, so reference-equality tells us whether the operator
    // edited during the in-flight POST.
    const savedNodes = store.getState().nodes;
    const savedEdges = store.getState().edges;
    // #746 — containers ride along in the snapshot and the race check below.
    // Redundant TODAY, stated plainly rather than dressed up as a fix: EVERY
    // writer of `containers` (`deleteNode` and `loadVersion`) also writes
    // `nodes`, so the node check already implies this one. It is here so the
    // first U6d mutator that touches membership WITHOUT touching nodes cannot
    // slip past the race check silently.
    const savedContainers = store.getState().containers;
    try {
      const created = await createPipelineVersion(
        pipelineId,
        toVersionBody(store.getState().loaded, savedNodes, savedEdges, savedContainers),
      );
      const s = store.getState();
      if (s.nodes === savedNodes && s.edges === savedEdges && s.containers === savedContainers) {
        // Nothing changed during the request: rebase fully onto the new
        // immutable version (clears `dirty`, and the next save carries THIS
        // version's params/outputs).
        s.loadVersion(created);
      } else {
        // The operator kept editing while the save was in flight — keep their
        // edits (and `dirty`), but point `loaded` at the new version so the
        // next save carries forward from it.
        s.rebaseLoaded(created);
      }
      setSaveMsg(`Saved v${created.version}.`);
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [pipelineId, store]);

  return (
    <section aria-labelledby="canvas-heading" className="canvas-page">
      <div className="page-header">
        <h2 id="canvas-heading">{pipelineName}</h2>
        <div className="form-actions">
          <button type="button" onClick={onBack}>
            ← Back to pipelines
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSave({ saving, ready, issues })}
          >
            {saving ? 'Saving…' : 'Save version'}
          </button>
        </div>
      </div>

      {saveMsg && <p className="notice">{saveMsg}</p>}
      {loadError && <p className="error" role="alert">{`Could not load pipeline: ${loadError}`}</p>}

      {issues.length > 0 && (
        <div className="badge-list" role="status">
          {/* #444: this used to say "you can still save … a run will refuse an
              invalid graph". Both halves were wrong — nothing refused a save,
              and no run refused the doc either. The server now refuses it on
              save, so the copy states what actually happens, and no more: the
              graph on screen is an editable draft, so anything about immutable
              stored versions would just read as "yours is unfixable". */}
          <strong>{issues.length} validation issue(s)</strong> — fix these to save.
          <ul>
            {issues.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {ready && (
        <div className="canvas-grid">
          {/* The toolbox is OUTSIDE the provider; the canvas reads the drop
              position via `useReactFlow` on its own side of the drag. */}
          <ActivityToolbox store={store} />
          <div className="canvas-wrap">
            <ReactFlowProvider>
              <FlowCanvas store={store} />
            </ReactFlowProvider>
          </div>
          <PropertyPanel store={store} connections={connections} />
        </div>
      )}

      {dirty && <p className="page-hint">Unsaved changes — click “Save version” to persist.</p>}
    </section>
  );
}

/** Edits the currently-selected node or edge; empty when nothing is selected. */
function PropertyPanel({
  store,
  connections,
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
}) {
  const selected = useStore(store, (s) => s.selected);
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);

  if (!selected) {
    return (
      <aside className="property-panel" aria-label="Properties">
        <h3>Properties</h3>
        <p className="page-hint">Select a node or an edge to edit it.</p>
      </aside>
    );
  }

  if (selected.kind === 'edge') {
    const edge = edges.find((e) => e.id === selected.id);
    if (!edge) return <EmptyPanel />;
    return <EdgePanel store={store} edge={edge} nodes={nodes} edges={edges} />;
  }

  const node = nodes.find((n) => n.id === selected.id);
  if (!node) return <EmptyPanel />;
  return (
    <NodePanel
      key={node.id}
      store={store}
      connections={connections}
      nodeId={node.id}
      nodeType={node.type}
      config={node.config}
      connectionId={node.connectionId}
    />
  );
}

function EmptyPanel() {
  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>Properties</h3>
    </aside>
  );
}

/**
 * Editor for one edge's CONDITION (U6a) — the picker that replaced the pinned
 * three-value dropdown.
 *
 * It offers the four operational outcomes (`skipped` included: the engine has
 * routed it since #1 F1 and nothing ever refused it — only the canvas pin
 * stopped it being authorable) plus one option per business branch the edge's
 * SOURCE node declares. The branch list is `declaredBranchesOf`, the same SSOT
 * `validatePipelineDoc` reads, so every option offered is one a save accepts.
 *
 * Exported so the option rules can be tested without mounting the page and its
 * whole API surface — the same reason `NodePanel` is exported.
 */
export function EdgePanel({
  store,
  edge,
  nodes,
  edges,
}: {
  store: ReturnType<typeof createCanvasStore>;
  edge: Edge;
  nodes: Node[];
  edges: Edge[];
}) {
  const current = conditionOf(edge);
  const currentValue = encodeCondition(current);
  const branches = branchOptionsFor(nodes.find((n) => n.id === edge.from));

  const offered = [
    ...OPERATIONAL_CONDITIONS.map((on) => encodeCondition({ on })),
    ...(branches ?? []).map((branch) => encodeCondition({ on: 'branch', branch })),
  ];

  /**
   * Conditions ALREADY taken by another edge between the same two nodes.
   *
   * `updateEdgeCondition` refuses such a retype (it would mint a duplicate),
   * and a refusal the operator cannot see is a control that silently does
   * nothing: they pick `failure`, React re-renders from the unchanged store,
   * and the select snaps back with no explanation. Showing the option DISABLED
   * says the same "no" before the click, and says why.
   */
  const taken = takenConditions(edges, edge);

  /**
   * A `<select>` whose `value` matches no `<option>` renders the FIRST option
   * instead — a silent lie about what is persisted. Reachable without leaving
   * the canvas: `declaredBranchesOf` reads a `switch`'s `config.cases` LIVE, so
   * editing that config in the node panel can un-declare a branch an existing
   * edge still uses. (Also reachable via an API/git-imported doc.) The value is
   * shown as a DISABLED option so the panel states the truth and refuses to
   * re-select it; `validateCanvas` is already badging the doc as unsavable.
   */
  const orphaned = !offered.includes(currentValue);

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>Edge</h3>
      <label>
        Fires on
        <select
          value={currentValue}
          onChange={(e) => {
            const next = decodeConditionValue(e.target.value);
            if (next) store.getState().updateEdgeCondition(edge.id, next);
          }}
        >
          {orphaned && (
            <option value={currentValue} disabled>
              {edgeLabel(edge)} — not offered by this source
            </option>
          )}
          <optgroup label="Outcome">
            {OPERATIONAL_CONDITIONS.map((on) => (
              <ConditionOption key={on} condition={{ on }} label={on} taken={taken} />
            ))}
          </optgroup>
          {branches !== null && (
            <optgroup label="Branch">
              {branches.map((branch) => (
                <ConditionOption
                  key={branch}
                  condition={{ on: 'branch', branch }}
                  label={branch}
                  taken={taken}
                />
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <button type="button" onClick={() => store.getState().deleteEdge(edge.id)}>
        Delete edge
      </button>
    </aside>
  );
}

/** One condition option, disabled (with the reason) when another edge holds it. */
function ConditionOption({
  condition,
  label,
  taken,
}: {
  condition: EdgeCondition;
  label: string;
  taken: ReadonlySet<string>;
}) {
  const value = encodeCondition(condition);
  const isTaken = taken.has(value);
  return (
    <option value={value} disabled={isTaken}>
      {isTaken ? `${label} — already used by another edge` : label}
    </option>
  );
}

/**
 * Editor for one activity node. Config is edited as JSON (minus the internal
 * `outputs` contract, which `lowerPipelineNodes` seeds — on creation AND on load
 * since #526 — and which this slice does not surface);
 * Apply parses the JSON and validates it against the activity's `configSchema`
 * before committing, so an invalid blob never reaches the store. The connection
 * dropdown is filtered to the kinds this activity accepts.
 */
export function NodePanel({
  store,
  connections,
  nodeId,
  nodeType,
  config,
  connectionId,
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  connectionId: string | undefined;
}) {
  const entry = getActivity(nodeType);
  // Edit config WITHOUT the internal `outputs` contract.
  const { outputs, ...editable } = config;
  const [text, setText] = useState(() => JSON.stringify(editable, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Kinds this activity accepts, PLUS whatever is currently bound — so a node
  // bound to an off-kind connection (e.g. loaded from an older doc) still shows
  // its real binding instead of silently reading as "— none —".
  const eligible = entry
    ? connections.filter((c) => entry.connectionKinds.includes(c.kind) || c.id === connectionId)
    : connections;

  function apply() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Config is not valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Config must be a JSON object.');
      return;
    }
    if (entry) {
      const check = entry.configSchema.safeParse(parsed);
      if (!check.success) {
        setError(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        return;
      }
    }
    setError(null);
    // Preserve the seeded `outputs` contract, which is edited elsewhere.
    store.getState().updateNodeConfig(nodeId, { ...(parsed as Record<string, unknown>), outputs });
  }

  // A structural-call activity (`execute_pipeline`) stores its settings in
  // `node.call`, not `node.config`, so this generic `node.config` editor cannot
  // author it — validating the edited blob against `entry.configSchema`
  // (`CallConfigSchema`) would always fail (`pipelineVersionId` lives in
  // `node.call`, unseen here). Such a node cannot be created via the canvas (the
  // palette hides it, `addNode` refuses it), but one authored via the API can be
  // LOADED, so show a read-only stub rather than an un-appliable form. Dedicated
  // call-node authoring is #425. (The hooks above run unconditionally — this
  // early return only skips the editor JSX.)
  if (isStructuralCallActivity(nodeType)) {
    return (
      <aside className="property-panel" aria-label="Properties">
        <h3>{entry?.title ?? nodeType}</h3>
        <p className="page-hint">This activity is configured via the call-node editor (#425).</p>
      </aside>
    );
  }

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{entry?.title ?? nodeType}</h3>
      {entry && entry.connectionKinds.length > 0 && (
        <label>
          Connection
          <select
            value={connectionId ?? ''}
            onChange={(e) =>
              store.getState().setNodeConnection(nodeId, e.target.value || undefined)
            }
          >
            <option value="">— none —</option>
            {eligible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Config (JSON)
        <textarea
          value={text}
          rows={10}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={apply}>
          Apply config
        </button>
        <button type="button" onClick={() => store.getState().deleteNode(nodeId)}>
          Delete node
        </button>
      </div>
    </aside>
  );
}
