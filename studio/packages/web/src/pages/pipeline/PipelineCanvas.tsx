import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ContainerKindSchema,
  getActivity,
  isStructuralCallActivity,
  type Container,
  type ConnectionPublic,
  type ContainerKind,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { createPipelineVersion, latestVersion, listPipelineVersions } from '../../api/pipelines';
import { listConnections } from '../../api/connections';
import { ActivityToolbox } from './ActivityToolbox';
import {
  assignContainerChild,
  buildContainer,
  containersWithNew,
  createCanvasStore,
} from './canvasStore';
import { consequenceMessage, containerEditConsequence, containerLabels } from './containerRules';
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
    // Still redundant today, but no longer for the reason first written here,
    // and the update is the point: that comment said EVERY writer of
    // `containers` also writes `nodes`, and named the two that then existed
    // (`deleteNode`, `loadVersion`). #748's `deleteContainer` is the third, and
    // it does NOT write `nodes` — the case the line was added in anticipation of
    // has arrived. What keeps it redundant now is `edges`: `deleteContainer`
    // filters that array unconditionally, so it always hands back a fresh
    // reference and the edge check catches the race first. A future
    // container-ONLY mutator would leave this the only check standing, which is
    // why it stays.
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
 * U6d — the selected activity's container membership, and the one gesture that
 * CREATES a container.
 *
 * Membership lives on the container (`children: string[]`), but disjointness
 * makes it a per-NODE fact, which is why one `<select>` on the node is the whole
 * control: picking a container joins it, picking `— none —` leaves, and "New
 * container" is the same act against a container that does not exist yet. There
 * is no multi-select to group N nodes at once (U21), and no drop target to drag
 * one in (U23) — a derived box only HINTS at enclosure until React Flow
 * `parentId` subflows make it authoritative.
 *
 * A container is created around the SELECTED node rather than empty, which is
 * what keeps a `loop`/`foreach` past its one-child rule the moment it exists.
 */
function ContainerSection({
  store,
  nodeId,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
}) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const loaded = useStore(store, (s) => s.loaded);
  const params = loaded?.params ?? [];

  const [kind, setKind] = useState<ContainerKind>('stage');
  const [exitWhen, setExitWhen] = useState('');
  const [items, setItems] = useState('');
  const [maxRounds, setMaxRounds] = useState('');
  const [error, setError] = useState<string | null>(null);

  const labels = containerLabels(containers);
  const ownerId = containers.find((c) => c.children.includes(nodeId))?.id ?? '';

  /**
   * Apply an edit once the operator has seen what it costs.
   *
   * ONE evaluation, at the moment of the click, against live state — the
   * consequence is never stored, so it cannot go stale the way a frozen
   * `role="alert"` does (`FlowCanvas` documents that failure). `window.confirm`
   * is the canvas's existing confirmation route (`confirmDeleteContainer`,
   * and every list page).
   */
  function withConfirmation(
    nextContainers: Container[],
    recovery: string,
    apply: () => void,
  ): boolean {
    const message = consequenceMessage(
      containerEditConsequence({ nodes, edges, containers, params }, nextContainers),
      nodes,
      edges,
      nextContainers,
      recovery,
    );
    if (message !== null && !window.confirm(message)) return false;
    apply();
    return true;
  }

  function changeOwner(value: string) {
    const target = value === '' ? null : value;
    setError(null);
    withConfirmation(
      assignContainerChild(containers, nodeId, target),
      'You can undo it by setting the activity back to — none —.',
      () => store.getState().setNodeContainer(nodeId, target),
    );
  }

  function create() {
    const trimmedRounds = maxRounds.trim();
    const built = buildContainer(kind, nodeId, {
      ...(kind === 'loop' ? { exitWhen: exitWhen.trim() } : {}),
      ...(kind === 'foreach' ? { items: items.trim() } : {}),
      // An empty numeric input is ABSENT, not zero — `Number('')` is 0, which
      // `ContainerSchema` rejects as non-positive and which no canvas check
      // would have caught before the server's zod parse 400'd the save.
      ...(kind === 'loop' && trimmedRounds !== '' ? { maxRounds: Number(trimmedRounds) } : {}),
    });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setError(null);
    const applied = withConfirmation(
      containersWithNew(containers, built.container),
      // NOT "set it back to — none —": emptying a freshly-made loop leaves a
      // worse doc than the one being escaped (see `consequenceMessage`).
      'You can undo it with the ✕ on the container box.',
      () => store.getState().createContainer(built.container),
    );
    if (applied) {
      setExitWhen('');
      setItems('');
      setMaxRounds('');
    }
  }

  // A loop with no exit condition and a foreach with no items are docs
  // `validateDoc` refuses outright, so the form cannot offer to author one.
  const canCreate =
    kind === 'loop' ? exitWhen.trim() !== '' : kind === 'foreach' ? items.trim() !== '' : true;

  // A fragment, not a wrapper: `.property-panel` is already the flex column
  // these controls want, so a `<div>` here would need its own rule saying the
  // same thing — two declarations that have to agree about one rhythm.
  return (
    <>
      <label>
        Container
        <select
          value={ownerId}
          aria-label="Container membership"
          onChange={(e) => changeOwner(e.target.value)}
        >
          <option value="">— none —</option>
          {containers.map((c) => (
            <option key={c.id} value={c.id}>
              {labels.get(c.id)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="container-create">
        <legend>New container</legend>
        <label>
          Kind
          <select
            value={kind}
            aria-label="New container kind"
            onChange={(e) => {
              const parsed = ContainerKindSchema.safeParse(e.target.value);
              if (parsed.success) setKind(parsed.data);
            }}
          >
            {ContainerKindSchema.options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {kind === 'loop' && (
          <>
            <label>
              Exit when
              <input
                value={exitWhen}
                spellCheck={false}
                placeholder="${equals(nodes.x.output.status, 200)}"
                onChange={(e) => setExitWhen(e.target.value)}
              />
            </label>
            <label>
              Max rounds (optional)
              <input
                value={maxRounds}
                inputMode="numeric"
                onChange={(e) => setMaxRounds(e.target.value)}
              />
            </label>
          </>
        )}
        {kind === 'foreach' && (
          <label>
            Items
            <input
              value={items}
              spellCheck={false}
              placeholder="${run.params.rows}"
              onChange={(e) => setItems(e.target.value)}
            />
          </label>
        )}
        <button type="button" disabled={!canCreate} onClick={create}>
          Create container
        </button>
      </fieldset>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Editor for one activity node. Config is edited as JSON (minus the internal
 * `outputs` contract, which `lowerPipelineNodes` seeds — on creation AND on load
 * since #526 — and which this slice does not surface);
 * Apply parses the JSON and validates it against the activity's `configSchema`
 * before committing, so an invalid blob never reaches the store. The connection
 * dropdown is filtered to the kinds this activity accepts. Container membership
 * (U6d) is `ContainerSection` above.
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
        {/* Rendered in the STUB too, not just in the editor below. Membership is
            orthogonal to `node.config`, so this early return must not swallow it:
            a container is exactly the construct an IMPORTED doc puts a call node
            in, and this is the only panel such a node ever gets. */}
        <ContainerSection store={store} nodeId={nodeId} />
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
      <ContainerSection store={store} nodeId={nodeId} />
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
