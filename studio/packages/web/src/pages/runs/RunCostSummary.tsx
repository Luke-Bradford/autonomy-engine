import { Link } from 'react-router';
import type { NodeCost } from '@autonomy-studio/shared';
import {
  childSpend,
  costFigure,
  costSentence,
  readCost,
  reusedSpend,
  tokenSummary,
  unsettledSentence,
} from './costReading';
import { runDetailPath } from './runPath';

/**
 * U27 slice 1 (#930) — what the WHOLE RUN spent.
 *
 * #866 landed per-NODE cost in the drill-in, and there it stopped: answering
 * "what did this run cost?" meant opening every node and adding up by hand. This
 * is the run-level total, and it is deliberately built out of the SAME reading
 * the node panel uses (`costReading.ts`), so the two surfaces cannot tell an
 * operator different things about the same money.
 *
 * THREE things it refuses to do, each of which is the whole reason it exists
 * rather than being a `formatUsd(sum)` in the header:
 *
 *  1. It does not print a figure folded from a PARTIAL log. `useRunStream` is
 *     replay-then-tail, and its own docblock notes that `phase:'closed'` can
 *     arrive MID-REPLAY (an orderly shutdown, a proxy close, the server's own
 *     send-failure path) leaving the log permanently truncated with no error
 *     shown. A node table under-rendering a row in that window is bad; "$4.12"
 *     presented as a run total over half a log is the manufactured authority
 *     #473/F13a forbid. So the figure is gated on `replayComplete`, and a
 *     stream that closed before replay finished SAYS the log is incomplete.
 *  2. It does not present an in-flight total as a settled one — same objection
 *     the node panel answers, and it bites harder here because the run header
 *     right above it is the thing saying the run is still going.
 *  3. It does not let a RERUN read as cheap. A rerun-from-failed copies its
 *     frontier and the new run's log carries no metered event for any copied
 *     node, so its total is INCREMENTAL: the spend of what it re-executed. See
 *     `reusedSpend`.
 *
 * Rendered UNCONDITIONALLY on the run page, unlike the node panel's section
 * (which is gated on there being something to say, because a drill-in is a thing
 * you opened deliberately). A run page that silently omits its cost section is
 * indistinguishable from an app that has no cost surface at all — and the
 * all-copied rerun, where `responseCount` is 0 and the reuse caveat is the entire
 * point, is exactly the case a `responseCount > 0` gate would have hidden.
 *
 * KNOWN SCOPE BOUNDARY, and #932 is the ticket that stopped it being a silent
 * one: a `call_pipeline` child runs under its OWN run id, so its spend is in the
 * child's log and not the parent's. This total therefore excludes child-run
 * spend — as does `GET /api/runs/:id/cost` — so it is a property of the run model
 * rather than of this projection, and folding the child's log in here would fix
 * one surface while leaving the other wrong.
 *
 * This docblock previously called that LATENT, "P3b has not landed the
 * child-spawn seam". #796 landed it, and the boundary went live without a word
 * changing on screen: the total quietly began omitting real money. So the
 * exclusion is now RENDERED (`childSpend`), with every child linked — the same
 * refusal as the three above, applied to a figure whose missing part the operator
 * otherwise has no way to find. The sentence is deliberately not a census:
 * children nest, and a rerun that copied a succeeded call node announces none of
 * its own while the original's children still hold spend.
 */
export function RunCostSummary({
  usage,
  nodes,
  settled,
  replayComplete,
  logTruncated,
}: {
  /** The whole run's folded usage — `computeRunUsage(stream.events)`. */
  usage: NodeCost;
  /** The reconciled node rows, read ONLY for what this total leaves out: the
   * nodes the run reused rather than re-executed, and the child runs it spawned. */
  nodes: readonly {
    copiedFromRunId?: string | undefined;
    childRunIds?: readonly string[] | undefined;
  }[];
  /** Whether the run has reached a terminal status. */
  settled: boolean;
  /** Whether the stream finished replaying the durable log. */
  replayComplete: boolean;
  /** Whether the stream ENDED without ever completing the replay. */
  logTruncated: boolean;
}) {
  const reused = reusedSpend(nodes);
  const children = childSpend(nodes);

  return (
    <section aria-labelledby="run-cost-heading">
      <h3 id="run-cost-heading">Cost &amp; usage</h3>
      {replayComplete ? (
        <>
          <SettledFigure usage={usage} settled={settled} />
          {/* INSIDE the replay gate, unlike the reuse caveat below, and the
              difference is not stylistic. `run.reseeded` is written into a new
              run's empty log in one transaction, so it is present from the first
              replay frame and a partial log cannot hide it. `call.started` lands
              arbitrarily late, so on a truncated replay this list under-counts or
              is absent — which would read as "no children". There is no figure to
              qualify when the gate is closed anyway: the branch below says the
              total cannot be computed at all, and qualifying a number that is not
              on screen is the thing `showsAnAmount` exists to stop. */}
          {children !== null && <ExcludedChildren childRunIds={children.childRunIds} />}
        </>
      ) : (
        <p className="page-hint">
          {logTruncated
            ? /* The load-bearing case. The stream is gone AND the log was never
                 fully read, so any figure would be a floor of unknown depth
                 wearing the confidence of a total. Say what is missing instead. */
              'The event stream ended before the whole log was read, so this run’s spend cannot be totalled. Reload to try again.'
            : 'Reading the run log…'}
        </p>
      )}

      {/* Rendered OUTSIDE the replay gate, deliberately: what the run reused is a
          fact about its lineage, not about how much of the log has arrived, and
          it is the one statement an all-copied rerun has to make. */}
      {reused !== null && (
        <p className="page-hint">
          {reused.reusedNodeCount} node{reused.reusedNodeCount === 1 ? ' was' : 's were'} REUSED
          from run{' '}
          <Link to={runDetailPath(reused.sourceRunId)} title={reused.sourceRunId}>
            <code>{reused.sourceRunId}</code>
          </Link>{' '}
          rather than re-executed, and a copied node bills nothing. So this is what the rerun spent,
          not what the result cost — the original spend stays on that run{' '}
          {/* #932 — the trailing "and on any sub-pipelines it called" is not
              padding. A succeeded call node is copied by `reseedFrontier` like
              any other, and a copied node re-executes nothing, so THIS run
              announces no child and the caveat above says nothing at all. The
              spend those children hold is real and sits two hops away. */}
          and on any sub-pipelines it called.
        </p>
      )}
    </section>
  );
}

/**
 * #932 — the child runs this total leaves out, and how to reach them.
 *
 * "and anything they called in turn" is doing real work in this sentence, not
 * hedging. A listed child may have spawned children of its own (`MAX_CALL_DEPTH`
 * allows a chain), so the money missing from this figure is the sum of a whole
 * SUBTREE, not of the runs named here. Ending the sentence at the links would send
 * an operator to two pages, add them up, and let them believe they had the total.
 */
function ExcludedChildren({ childRunIds }: { childRunIds: readonly string[] }) {
  const many = childRunIds.length > 1;
  return (
    <p className="page-hint">
      This run called {childRunIds.length} sub-pipeline{many ? 's' : ''}, and{' '}
      {many ? 'each one ran' : 'it ran'} as its own run that billed its own spend. So this figure is
      what THIS run spent — it excludes {many ? 'those runs' : 'that run'}, and anything{' '}
      {many ? 'they' : 'it'} called in turn:{' '}
      {childRunIds.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <Link to={runDetailPath(id)} title={id}>
            <code>{id}</code>
          </Link>
        </span>
      ))}
      .
    </p>
  );
}

function SettledFigure({ usage, settled }: { usage: NodeCost; settled: boolean }) {
  const reading = readCost(usage);
  return (
    <>
      <p>
        <strong>{costFigure(reading)}</strong>
      </p>
      <p className="page-hint">{costSentence(reading, 'run')}</p>

      {usage.models.length > 0 && (
        <dl className="run-meta">
          <dt>{usage.models.length === 1 ? 'Model' : 'Models'}</dt>
          <dd>
            {usage.models.map((m) => (
              <code key={m}>{m}</code>
            ))}
          </dd>
          <dt>Tokens</dt>
          <dd>{tokenSummary(reading, usage)}</dd>
        </dl>
      )}

      {(reading.inputTokensPartial || reading.outputTokensPartial) && (
        <p className="page-hint">
          Not every exchange reported a count — {reading.inputReportedCount} of{' '}
          {reading.exchangeCount} reported input and {reading.outputReportedCount} of{' '}
          {reading.exchangeCount} reported output — so these sums are partial.
        </p>
      )}

      {reading.exchangesAreFloor && (
        <p className="page-hint">
          A CLI activity records one exchange per <em>invocation</em>, and the CLI does not report
          the model calls it makes internally — so this count is a floor, not a census.
        </p>
      )}

      {!settled && <p className="page-hint">{unsettledSentence(reading, 'run')}</p>}
    </>
  );
}
