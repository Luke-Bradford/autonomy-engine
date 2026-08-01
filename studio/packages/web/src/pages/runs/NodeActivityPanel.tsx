import { nodeStatusLabel } from './nodeStatus';
import type { NodeActivity } from './runSummary';

/**
 * U24 (slice 1) — the per-node drill-in on the run monitor.
 *
 * Until this existed the Monitor could tell you a node had failed and nothing
 * more: the node table's one Detail column held the raw message, and a node's
 * declared outputs — the thing every downstream `${nodes.x.output.y}` reads —
 * were not shown anywhere at all. So "run it and see truthful results" stopped
 * at "it went red".
 *
 * Everything here is folded from the run's event log by `deriveNodeActivity`, so
 * a finished run's history and a live run's frames render identically, and the
 * panel adds no fourth walk over the log (see #849 — the page already folds it
 * three times, and this reuses the fold the node table already ran).
 *
 * The declared outputs are ALSO in the reducer's own `RunState.outputs`, which
 * `projectRun` folds on this same page — and where the two disagree the engine
 * is right. The doc-free fold is used anyway because it is the one that renders
 * when the pipeline version will not resolve, which is exactly when a failed run
 * most needs reading. Cost of that choice, stated rather than hidden: an RS1
 * rerun-from-failed seeds its copied frontier through `run.reseeded`, which this
 * fold ignores, so a copied node shows no outputs here.
 *
 * READ-ONLY by design (U28): no cancel, no rerun, no retry. Those are
 * control-plane WRITES with no engine primitive behind them today, and inventing
 * a control here would cross the "no engine execution-semantics changes"
 * boundary the UI epic draws.
 *
 * Deliberately NOT shown yet, each for a stated reason rather than an oversight:
 *  - the node's INPUT — no event captures the resolved config a node ran with,
 *    so there is nothing truthful to render (the authored template is in the
 *    doc, but that is the un-substituted text, not what executed);
 *  - per-node cost/tokens — `activity.metered` carries them and
 *    `computeRunCost` already folds them, but that is its own slice;
 *  - prompt/completion — `activity.captured` holds only redacted SHAPE (message
 *    counts, char counts, content hashes) until L9b/F4 lands raw capture, and a
 *    sha256 on screen is not worth a section;
 *  - tool calls — `activity.toolCalled` carries `toolName`, `round`, `callId`
 *    and `isError` IN THE CLEAR (only args/result are chars+hash), so "which
 *    tools ran, in which exchange, which errored" is renderable today. It is
 *    deferred as its own slice, NOT because the data is missing;
 *  - a per-attempt DURATION — the envelope timestamps would give a span that
 *    silently includes retry holds and park idle, and six engine-evaluated
 *    activity kinds have no dispatch event to start it from. A wrong number is
 *    worse than no number.
 */
/** The panel's DOM id, so the table's disclosure button can `aria-controls` it. */
export const PANEL_ID = 'node-activity-panel';

/**
 * `name` is what the graph and the node table call this node — the
 * `activityLabels` ordinal, e.g. `HTTP Request 1` (#882). It is `null`, and only
 * `null`, when the bound doc does not name this node: the pipeline version will
 * not resolve, or the run carries a row the doc no longer has. The panel then
 * falls back to the raw id, which is what it showed before this and is the one
 * thing still true about the node — never an invented placeholder.
 *
 * The RAW ID is rendered either way. It is what the `${nodes.<id>.output.…}`
 * expressions in the doc and the ids in the run's event feed are keyed on, so
 * naming the node without it would close one lookup by breaking another.
 */
export function NodeActivityPanel({
  node,
  name,
  onClose,
}: {
  node: NodeActivity;
  name: string | null;
  onClose: () => void;
}) {
  const outputNames = node.outputValues === undefined ? [] : Object.keys(node.outputValues);
  return (
    <aside
      id={PANEL_ID}
      className="property-panel node-detail-panel"
      aria-label={`Node ${name ?? node.nodeId}`}
    >
      {/* `.page-header` is the existing title-plus-action row. The sibling
          property panels have no action in their heading, so none of them uses
          it; this one needs a Close beside the title rather than a new rule. */}
      <div className="page-header">
        <h3>
          Node {name ?? <code>{node.nodeId}</code>}
          {name !== null && <code className="node-id">{node.nodeId}</code>}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <p>
        {/* U25 — one status vocabulary for the whole Monitor: the same word
            the table and the graph show, sourced from `nodeStatus.ts`. */}
        <span className={`node-status node-status-${node.status}`}>
          {nodeStatusLabel(node.status)}
        </span>{' '}
        {node.attempts} attempt{node.attempts === 1 ? '' : 's'}
      </p>

      {node.instanceId !== undefined && (
        <p className="page-hint">
          Showing the result recorded under <code>{node.instanceId}</code>. Results keyed{' '}
          <code>id@n</code> — how a parallel foreach writes its items — fold onto the one node you
          drew, most recent wins. So this is one of them, not all of them.
        </p>
      )}

      {node.status === 'failure' && (
        <section className="contract-section">
          <h4>Failure</h4>
          {/* Gated on the STATUS, not on the message: a `call.returned` with a
              failing child sets the row red and carries no message of its own,
              and gating on `error` hid the whole section for it. */}
          {node.error === undefined ? (
            <p className="page-hint">
              No message was recorded — this node reports another run&apos;s outcome.
            </p>
          ) : (
            <p>{node.error}</p>
          )}
          {node.failureKind === undefined ? (
            /* Not a gap — `externalWait.expired` fails a node straight off its
               expiry alarm, with no `node.failed` to classify it. Say so rather
               than leave the section looking truncated, and never guess a kind:
               how the reducer treats an expired wait is the reducer's fact. */
            <p className="page-hint">This failure was recorded without a machine-readable class.</p>
          ) : (
            <dl className="run-meta">
              <dt>Kind</dt>
              <dd>
                <code>{node.failureKind}</code>
              </dd>
              {node.failureCode !== undefined && (
                <>
                  <dt>Code</dt>
                  <dd>
                    <code>{node.failureCode}</code>
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>
      )}

      {node.outputValues !== undefined && (
        <section className="contract-section">
          <h4>Outputs</h4>
          {outputNames.length === 0 ? (
            <p className="page-hint">This node declared no outputs.</p>
          ) : (
            /* `JSON.stringify` emits no spaces, so a long value is one
               unbreakable token; an agent node's `text` output is realistically
               tens of KB. The class wraps and scrolls it rather than letting it
               push the panel sideways. */
            <code className="node-detail-outputs">{JSON.stringify(node.outputValues)}</code>
          )}
        </section>
      )}

      <section className="contract-section">
        <h4>Streamed output</h4>
        <p>
          {node.outputs} event{node.outputs === 1 ? '' : 's'}
          {node.lastOutputName !== undefined && <> (latest: {node.lastOutputName})</>}
        </p>
      </section>
    </aside>
  );
}
