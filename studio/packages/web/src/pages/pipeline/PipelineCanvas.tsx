import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  EdgeOnSchema,
  catalog,
  getActivity,
  type ConnectionPublic,
  type EdgeOn,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { createPipelineVersion, listPipelineVersions } from '../../api/pipelines';
import { listConnections } from '../../api/connections';
import { createCanvasStore } from './canvasStore';
import { toVersionBody, validateCanvas } from './canvasDoc';
import { FlowCanvas } from './FlowCanvas';

/** Pick the highest-numbered version, or null when a pipeline has none yet. */
function latestVersion(versions: PipelineVersion[]): PipelineVersion | null {
  return versions.reduce<PipelineVersion | null>(
    (best, v) => (best === null || v.version > best.version ? v : best),
    null,
  );
}

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
  const dirty = useStore(store, (s) => s.dirty);

  const issues = useMemo(
    () => validateCanvas(nodes, edges, loaded?.containers ?? [], loaded?.params ?? []),
    [nodes, edges, loaded],
  );

  const onSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const created = await createPipelineVersion(
        pipelineId,
        toVersionBody(store.getState().loaded, store.getState().nodes, store.getState().edges),
      );
      // Rebase the canvas onto the new immutable version: clears `dirty` and
      // makes the next save carry THIS version's params/outputs/containers.
      store.getState().loadVersion(created);
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
          <button type="button" onClick={() => void onSave()} disabled={saving || !ready}>
            {saving ? 'Saving…' : 'Save version'}
          </button>
        </div>
      </div>

      {saveMsg && <p className="notice">{saveMsg}</p>}
      {loadError && <p className="error" role="alert">{`Could not load pipeline: ${loadError}`}</p>}

      {issues.length > 0 && (
        <div className="badge-list" role="status">
          <strong>{issues.length} validation issue(s)</strong> — you can still save (versions are
          immutable); a run will refuse an invalid graph.
          <ul>
            {issues.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {ready && (
        <div className="canvas-grid">
          <Palette store={store} />
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

/** The add-a-node palette: one button per catalog activity. */
function Palette({ store }: { store: ReturnType<typeof createCanvasStore> }) {
  const entries = [...catalog.values()];
  return (
    <aside className="palette" aria-label="Activity palette">
      <h3>Add activity</h3>
      {entries.map((entry) => (
        <button key={entry.type} type="button" onClick={() => store.getState().addNode(entry.type)}>
          + {entry.title}
        </button>
      ))}
    </aside>
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
    return (
      <aside className="property-panel" aria-label="Properties">
        <h3>Edge</h3>
        <label>
          Fires on
          <select
            value={edge.on}
            onChange={(e) => store.getState().updateEdgeOn(edge.id, e.target.value as EdgeOn)}
          >
            {EdgeOnSchema.options.map((on) => (
              <option key={on} value={on}>
                {on}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => store.getState().deleteEdge(edge.id)}>
          Delete edge
        </button>
      </aside>
    );
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
 * Editor for one activity node. Config is edited as JSON (minus the internal
 * `outputs` contract, which the palette seeds and this slice does not surface);
 * Apply parses the JSON and validates it against the activity's `configSchema`
 * before committing, so an invalid blob never reaches the store. The connection
 * dropdown is filtered to the kinds this activity accepts.
 */
function NodePanel({
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

  const eligible = entry
    ? connections.filter((c) => entry.connectionKinds.includes(c.kind))
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
