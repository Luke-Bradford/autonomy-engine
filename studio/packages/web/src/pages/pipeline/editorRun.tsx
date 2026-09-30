import { useContext, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { TERMINAL_RUN_ROW_STATUS, type RunStatus } from '@autonomy-studio/shared';
import { NodeActivityPanel } from '../runs/NodeActivityPanel';
import { runNodeOverlay } from '../runs/runFlow';
import { runDetailPath } from '../runs/runPath';
import {
  deriveNodeActivity,
  deriveRunLifecycle,
  reconcileNodeActivity,
  runLifecycleView,
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
 * Folds the log exactly as the run page does — one projection, the fold
 * reconciled against it, the same lifecycle precedence — so a node cannot read
 * one way on the canvas and another on "Open run".
 */
export function EditorRunProvider({
  run,
  children,
}: {
  run: EditorRun | null;
  children: ReactNode;
}) {
  const stream = useRunStream(run?.runId ?? null);
  const doc = run?.version ?? null;
  const projection = useRunProjection(doc, stream);
  const folded = useMemo(() => deriveNodeActivity(stream.events), [stream.events]);
  const nodes = useMemo(
    () => (projection.ready ? reconcileNodeActivity(folded, projection.state) : folded),
    [folded, projection],
  );
  const lifecycle = useMemo(() => deriveRunLifecycle(stream.events), [stream.events]);
  const status: RunStatus = runLifecycleView(lifecycle, projection)?.status ?? 'pending';
  const live = stream.phase === 'live' && !TERMINAL_RUN_ROW_STATUS.has(status);
  const names = useMemo(() => (doc === null ? null : activityLabels(doc.nodes)), [doc]);

  const value = useMemo((): EditorRunView | null => {
    if (run === null || doc === null) return null;
    const activity = new Map(nodes.map((n) => [n.nodeId, n]));
    return {
      runId: run.runId,
      overlay: runNodeOverlay(doc, projection.ready ? projection.state : null, activity),
      nodes,
      status,
      live,
      nameOf: (id) => names?.get(id) ?? null,
    };
  }, [run, doc, nodes, projection, status, live, names]);

  return <EditorRunContext.Provider value={value}>{children}</EditorRunContext.Provider>;
}

/**
 * The selected node's part in the editor's run — its status, attempts, inputs
 * and outputs, streamed — drawn by the run page's own drill-in panel, plus the
 * way to the whole run.
 *
 * Nothing when there is no run, or the node has no row in it (a node the draft
 * added since, or one the run has not reached and the engine has no opinion on
 * yet). Close hides it for THAT node; selecting another brings it back.
 */
export function EditorRunDrawer({ nodeId }: { nodeId: string | null }) {
  const run = useContext(EditorRunContext);
  const [closed, setClosed] = useState<string | null>(null);
  if (run === null || nodeId === null || closed === nodeId) return null;
  const node = run.nodes.find((n) => n.nodeId === nodeId);
  if (node === undefined) return null;
  return (
    <div className="editor-run-drawer">
      <NodeActivityPanel
        node={node}
        name={run.nameOf(nodeId)}
        runStatus={run.status}
        live={run.live}
        onClose={() => setClosed(nodeId)}
      />
      <p className="page-hint">
        <Link to={runDetailPath(run.runId)}>Open full run</Link>
      </p>
    </div>
  );
}
