import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { RunStatus } from '@autonomy-studio/shared';
import { NodeActivityPanel } from '../runs/NodeActivityPanel';
import { runNodeOverlay } from '../runs/runFlow';
import { runDetailPath } from '../runs/runPath';
import {
  deriveNodeActivity,
  deriveRunLifecycle,
  reconcileNodeActivity,
  runLifecycleView,
  streamStillLive,
} from '../runs/runSummary';
import { useRunProjection } from '../runs/useRunProjection';
import { useRunStream } from '../runs/useRunStream';
import { activityLabels } from './activityLabel';
import { EditorRunContext, type EditorRun, type EditorRunView } from './editorRunContext';

/**
 * Streams the run the editor started and hands it to everything below.
 *
 * Its OWN component rather than a hook inside `PipelineCanvas`: every frame
 * re-renders whoever holds the stream, and here that is this provider and the
 * context's readers, not the whole editor with its drafts. `children` arrive
 * already built, so a frame does not rebuild them.
 *
 * The stream lives one level further down, in `EditorRunStream`, KEYED BY RUN.
 * `useRunStream` resets its log in an effect, i.e. one commit AFTER the run id
 * changes, so a hook held here would project the previous run's log onto the
 * next run's version for a frame. A fresh mount starts from an empty log, and a
 * view is only provided for the run it was folded from.
 */
export function EditorRunProvider({
  run,
  children,
}: {
  run: EditorRun | null;
  children: ReactNode;
}) {
  const [view, setView] = useState<EditorRunView | null>(null);
  const value = run !== null && view?.runId === run.runId ? view : null;
  return (
    <EditorRunContext.Provider value={value}>
      {run !== null && <EditorRunStream key={run.runId} run={run} onView={setView} />}
      {children}
    </EditorRunContext.Provider>
  );
}

/**
 * Folds the run's log exactly as the run page does — one projection, the fold
 * reconciled against it, the same lifecycle and liveness rules — so a node
 * cannot read one way on the canvas and another on "Open run". Renders nothing.
 */
function EditorRunStream({
  run,
  onView,
}: {
  run: EditorRun;
  onView: (view: EditorRunView) => void;
}) {
  const stream = useRunStream(run.runId);
  const doc = run.version;
  const projection = useRunProjection(doc, stream);
  const folded = useMemo(() => deriveNodeActivity(stream.events), [stream.events]);
  const nodes = useMemo(
    () => (projection.ready ? reconcileNodeActivity(folded, projection.state) : folded),
    [folded, projection],
  );
  const lifecycle = useMemo(() => deriveRunLifecycle(stream.events), [stream.events]);
  const status: RunStatus = runLifecycleView(lifecycle, projection)?.status ?? 'pending';
  const live = streamStillLive(stream.phase, status);
  const names = useMemo(() => activityLabels(doc.nodes), [doc]);

  const view = useMemo((): EditorRunView => {
    const activity = new Map(nodes.map((n) => [n.nodeId, n]));
    return {
      runId: run.runId,
      overlay: runNodeOverlay(doc, projection.ready ? projection.state : null, activity),
      nodes,
      status,
      live,
      nameOf: (id) => names.get(id) ?? null,
    };
  }, [run.runId, doc, nodes, projection, status, live, names]);

  useEffect(() => {
    onView(view);
  }, [view, onView]);
  return null;
}

/**
 * The selected node's part in the editor's run — its status, attempts, inputs
 * and outputs, streamed — drawn by the run page's own drill-in panel, plus the
 * way to the whole run.
 *
 * Nothing when there is no run, when the node has no row in it (a node the
 * draft added since, or one the run has not reached), or when the draft has
 * re-typed the node since — the canvas's chip declines the same case. Close
 * hides it; the caller keys it by run and node, so selecting the node again,
 * or the next run, brings it back.
 */
export function EditorRunDrawer({ nodeId, type }: { nodeId: string | null; type: string | null }) {
  const run = useContext(EditorRunContext);
  const [closed, setClosed] = useState(false);
  if (run === null || nodeId === null || closed) return null;
  const entry = run.overlay.get(nodeId);
  if (entry !== undefined && entry.type !== type) return null;
  const node = run.nodes.find((n) => n.nodeId === nodeId);
  if (node === undefined) return null;
  return (
    <div>
      <NodeActivityPanel
        node={node}
        name={run.nameOf(nodeId)}
        runStatus={run.status}
        live={run.live}
        onClose={() => setClosed(true)}
      />
      <p className="page-hint">
        <Link to={runDetailPath(run.runId)}>Open full run</Link>
      </p>
    </div>
  );
}
