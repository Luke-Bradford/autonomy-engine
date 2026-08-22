import { Link } from 'react-router';
import { describeDatasetAddress, TERMINAL_NODE } from '@autonomy-studio/shared';
import type { DatasetAddress } from '@autonomy-studio/shared';
import { nodeStatusLabel } from './nodeStatus';
import { runDetailPath, runLinkLabel } from './runPath';
import { formatNodeDuration } from './format';
import { costFigure, costSentence, readCost, tokenSummary, unsettledSentence } from './costReading';
import type { NodeActivity, NodeToolCall } from './runSummary';

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
 * most needs reading. Since #918 that fold reads an RS1 rerun's copied frontier
 * too — `run.reseeded` carries R1's stored outputs — and this panel names the
 * source run rather than passing them off as this run's work.
 *
 * READ-ONLY by design (U28): no cancel, no retry, and no NODE-level rerun. The
 * reason is per-control, and one of the three has since changed, so it is worth
 * stating precisely rather than as one blanket claim:
 *  - cancel and retry still have no engine primitive at all — the only
 *    cancellation in the tree is connector-level `AbortSignal` plumbing, there is
 *    no cancel command, route or event — so inventing either control here would
 *    cross the "no engine execution-semantics changes" boundary the UI epic draws.
 *  - rerun DOES now have a primitive (RS2), but it reruns a RUN, not a node:
 *    it resumes from the run's failure frontier. It therefore belongs to the
 *    parent page, which is where it lives, and there is still nothing a
 *    node-scoped rerun control could call.
 *
 * Deliberately NOT shown yet, each for a stated reason rather than an oversight:
 *  - the node's INPUT — no event captures the resolved config a node ran with,
 *    so there is nothing truthful to render (the authored template is in the
 *    doc, but that is the un-substituted text, not what executed) — #890;
 *  - prompt/completion — `activity.captured` holds only redacted SHAPE (message
 *    counts, char counts, content hashes) until L9b/F4 lands raw capture, and a
 *    sha256 on screen is not worth a section (#605).
 *
 * COST and TOOL CALLS were on that list and no longer are: #866 shipped both.
 * Neither needed new data — `activity.metered` already carried the money and
 * `activity.toolCalled` already carried `toolName`/`round`/`callId`/`isError` in
 * the clear (only args/result are reduced to chars+hash). What they needed was
 * the honesty work, because a per-node money figure misleads in ways a per-run
 * one does not: `costReading.ts` classifies WHICH reading is true of a node before
 * a dollar sign is drawn, so a run of unpriceable exchanges never renders as
 * `$0.00`, a subscription call's known zero never renders as a measurement gap,
 * and an `agent_cli` node's token sums never render as `0` when nobody counted.
 *
 * The per-attempt DURATION was on that list and no longer is: #867 shipped it.
 * Both objections that kept it off were answered rather than waived — the span
 * is per-ATTEMPT, so a retry hold falls between two spans instead of inside
 * one, and the engine-evaluated kinds that have no start event are rendered as
 * unmeasured rather than given a manufactured `0ms`. What is still deferred is
 * a LIVE counter for an attempt in flight, which needs a clock this page does
 * not have (#890).
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

      {/* #918 / RS6 — ABOVE the duration and the outputs, because it is what
          makes both of them readable: a copied node has no span and zero
          attempts, and its Outputs section holds another run's values. Without
          this sentence the panel presents R1's result as this run's work, and
          the "0 attempts" under a green badge reads as a rendering bug. */}
      {node.copiedFromRunId !== undefined && (
        <p className="page-hint">
          This node did not run in this run. The rerun reused its result from run{' '}
          <code>{node.copiedFromRunId}</code>, so the outputs below were computed there.
        </p>
      )}

      {/* #867 — the duration, and the one place there is room to say what it
          MEANS. The table's column can only carry the number.

          Both halves are load-bearing. "Wall clock" and "including any wait"
          keep it from being read as execution time — for a `wait`/`webhook`
          node the span IS the park, and an LLM node's `activity.captured`
          latency is a smaller, different number it must not be confused with.
          The em-dash case is the honest one: an `if`, a `switch`, a `fail`, a
          `filter` and a `call_pipeline` are started and settled by a SINGLE
          event, so nothing ever measured a span for them, and saying so beats
          printing a `0ms` nobody observed. */}
      <p className="page-hint">
        {/* A COLON, not a dash: the value is itself an em-dash whenever no span
            was measured, and "Duration — — wall clock…" is what a dash gave. */}
        Duration: <strong>{formatNodeDuration(node)}</strong> — wall clock for the latest attempt,
        from start to settle, including any wait it parked on and excluding time held between
        retries.{' '}
        {node.startedAtMs === undefined &&
          (node.copiedFromRunId !== undefined
            ? /* #918 — a copied node hits the `attempts === 0` arm exactly, and
                 "has not started" under a `success` badge and a full Outputs
                 section is a sentence that contradicts the rest of the panel.
                 It did start — in the run it was copied from, which is the one
                 place a span for it exists. */
              'This node was not executed in this run, so there is no span to measure here.'
            : /* #1008 — AHEAD of the `attempts === 0` arm, which a routed-around
                 node otherwise falls through to. The engine appends no event for
                 a node it routes around, so `attempts` is 0 for both cases and
                 only the status separates them — and "has not started" says the
                 wrong thing about this one, which did not fail to start but was
                 never going to run. The timeline on this same page has always
                 said `skipped` here (`untimedReason` in `attemptSpans.ts`), so
                 until this arm existed one page described one fact two ways.

                 BOTH halves of the test are load-bearing. `skipped` does not
                 imply "never ran": `abandonLiveChildren` flips a live child to
                 `skipped` on a container timeout without touching `attempts`,
                 and `reconcileNodeActivity` then clears the open span's start —
                 so such a row arrives here with no `startedAtMs`, a `skipped`
                 status and `attempts >= 1`. On status alone this arm would tell
                 the operator a node that was running when its container gave up
                 "was never going to run". With `attempts` in the test it falls
                 through to "No span was recorded for this attempt", which is
                 true of it, and `untimedReason` divides the same way.

                 The two chains stay SEPARATE, as `untimedReason`'s docblock
                 argues: it answers why the node contributed no span AT ALL to
                 the chart, this answers why the LATEST ATTEMPT has no duration,
                 and a node can have several measured spans and no current
                 duration or the reverse. Only the FACT is shared, never the
                 string — `untimedReason` returns a fragment for `name — reason`,
                 these arms are standalone sentences. */
              node.status === 'skipped' && node.attempts === 0
              ? 'This node was routed around, so it was never going to run and there is nothing to measure.'
              : node.attempts === 0
                ? 'This node has not started, so there is nothing to measure yet.'
                : 'No span was recorded for this attempt.')}
        {node.startedAtMs !== undefined &&
          node.endedAtMs === undefined &&
          'This attempt has not settled yet, so its span is not complete.'}
        {/* The corrupt-log case. `formatNodeDuration` renders it as unmeasured
            rather than clamping to `0ms`, and without this arm it would be the
            ONE em-dash on this panel with no sentence explaining it — which
            reads as a rendering bug rather than as the finding it is. */}
        {node.startedAtMs !== undefined &&
          node.endedAtMs !== undefined &&
          node.endedAtMs < node.startedAtMs &&
          'The recorded end precedes the start, so the log’s clock is inconsistent and no span can be stated.'}
      </p>

      {node.instanceId !== undefined && (
        <p className="page-hint">
          Showing the result recorded under <code>{node.instanceId}</code>. Results keyed{' '}
          <code>id@n</code> — how a parallel foreach writes its items — fold onto the one node you
          drew, most recent wins. So this is one of them, not all of them.
        </p>
      )}

      {node.datasetAddresses !== undefined && (
        <DataMovementSection addresses={node.datasetAddresses} />
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

      {/* #1231 / U20 — the drill DOWN. Placed between Failure and Outputs
          deliberately: a failed call node's failure came from the child, so the
          link is the next thing wanted; and it must sit above Outputs because a
          call node's outputs ARE the child's projection (`lower.ts` skips call
          nodes for exactly that reason), so the link explains the section under
          it rather than trailing after it. */}
      <ChildRuns node={node} />

      {node.outputValues !== undefined && (
        <section className="contract-section">
          <h4>Outputs</h4>
          {outputNames.length === 0 ? (
            /* #911 — a statement about the RECORDING, not about the contract.
               It used to read "This node declared no outputs.", which was safe
               only while `node.succeeded`/`call.returned` were the sole
               producers of an empty set: for a DECLARED contract `storeOutputs`
               always emits the declared keys, so empty really did imply no
               declaration. A pre-A16 `externalWait.completed` breaks that — its
               `outputs` field is `.optional()`, folds to `{}`, and would print
               "declared no outputs" for a webhook that declares `decision`.
               The empty set is evidence about what was recorded and nothing
               more, so it may only say that much. */
            <p className="page-hint">No output values were recorded.</p>
          ) : (
            /* `JSON.stringify` emits no spaces, so a long value is one
               unbreakable token; an agent node's `text` output is realistically
               tens of KB. The class wraps and scrolls it rather than letting it
               push the panel sideways. */
            <code className="node-detail-outputs">{JSON.stringify(node.outputValues)}</code>
          )}
        </section>
      )}

      {/* The `||` is DEFENCE, not a live path: the tool loop yields its `metered`
          event before its `toolCalled` ones in the same round, so tool calls today
          imply at least one billed exchange. It is kept — with the `none` reading
          behind it — so that a future producer of tool calls without metering
          renders "no billed exchange" rather than silently dropping the section,
          which would read as "this panel does not do cost". */}
      {(node.cost.responseCount > 0 || node.toolCalls.length > 0) && <CostSection node={node} />}

      {node.toolCalls.length > 0 && <ToolCallSection calls={node.toolCalls} />}

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

/**
 * #1231 (U20) — the runs this node spawned, and the way down into them.
 *
 * The parent could already SEE a call node park — #796 gave it `call.started`
 * and the node sits `waiting` for the whole time its child is in flight — but
 * there was nowhere to go from there. `childRunIds` had exactly one consumer,
 * `RunCostSummary`'s `ExcludedChildren`, which links the same ids while making a
 * claim about MONEY ("this figure excludes those runs"). That is a different
 * sentence, and a node panel must not carry it, which is why this is a second
 * site rather than a shared component: the two agree on the ids and on nothing
 * else, and the accessible names have to differ anyway (both render on this one
 * page, so two links named the bare run id would be ambiguous to any reader
 * addressing controls by name — a screen reader's and a test's alike).
 *
 * THE SOURCE IS THE FOLD, not `GET /api/runs?parentRunId=`, and for a NODE-scoped
 * section the query is not merely a weaker source — it cannot answer the
 * question. `RunSchema` carries `parentRunId` and no call-node id, so it can say
 * a run is a child of this RUN and never which node spawned it. The fold's own
 * docblock argues it is "more complete about rows and less truthful about spend"
 * than the query; for navigation that polarity inverts too, because
 * `call.returned` echoes a `childRunId` for a spawn `child.ts` REFUSED — a run
 * that never existed — and this array is filled only from `call.started`, which
 * is appended after the child's row. So it can never hold an id that 404s.
 *
 * NOT gated on `stream.replayComplete`, where the cost section deliberately is,
 * and the difference is what each surface CLAIMS. A truncated replay makes both
 * under-count; the cost section would then print a total that is wrong by an
 * unknown amount, which is the manufactured authority #473/F13a forbid, whereas
 * this one would show fewer links — a missing way down, not a false statement.
 * The panel takes no stream props, and the live park is precisely the moment an
 * operator wants the link, so waiting for replay would withhold it exactly then.
 */
function ChildRuns({ node }: { node: NodeActivity }) {
  if (node.childRunIds.length === 0) {
    /* The state a bare `length > 0` gate ships silent. The reducer parks the
       node on the `startChild` COMMAND and the announcement is appended only
       once the child's row exists, so `waiting` with no id is the normal gap
       during a spawn — and what a server that died in between leaves behind
       permanently (#1041's `pending` orphan). Rendering nothing here would say
       "no children" about a node that is parked on one. */
    if (node.status !== 'waiting') return null;
    return (
      <p className="page-hint">
        This node is parked on a child run that has not been announced yet. The engine parks it on
        the spawn command and records the child only once the child&apos;s own run row exists, so a
        moment of this is normal during a spawn. If it persists, the spawn did not complete and no
        child run was created.
      </p>
    );
  }
  return (
    <section className="contract-section" aria-label="Child runs">
      <h4>Child runs</h4>
      {/* Tense-neutral ON PURPOSE. `childRunIds` is append-only and never
          cleared, so this list outlives the park it was opened for and holds
          finished children as readily as live ones — and nothing on the row
          carries a child's STATUS. It may therefore never say "running": a
          `skipped` call node (a container timeout via `abandonLiveChildren`)
          can be holding a child that still is, and a `success` one is holding
          children that are not. The child's own page is the authority. */}
      <p className="page-hint">
        {node.childRunIds.length === 1 ? 'The run' : 'The runs'} this node spawned.{' '}
        {node.childRunIds.length === 1 ? 'It has' : 'Each has'} its own log, its own outputs and its
        own spend, so this node&apos;s duration and cost above are not{' '}
        {node.childRunIds.length === 1 ? 'its' : 'theirs'}.
        {node.childRunIds.length > 1 && (
          <>
            {' '}
            One node holds several because it ran several times: a back-edge loop round spawns an
            ADDITIONAL child rather than replacing the last, and a parallel foreach folds its item
            instances onto the one node you drew.
          </>
        )}
      </p>
      {/* A LIST, not comma-separated spans: the count is then announced, and
          each id is an item rather than a run-on sentence. `aria-label` carries
          the name because the visible text is the raw id and stays that way —
          it is what the event feed, the `${nodes.…}` expressions and the runs
          list are all keyed on, so naming the link must not cost the lookup. */}
      <ul className="plain-list">
        {node.childRunIds.map((id) => (
          <li key={id}>
            <Link to={runDetailPath(id)} aria-label={runLinkLabel('Child', id)}>
              <code>{id}</code>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * #866 slice 1 — what this node SPENT.
 *
 * The money figure is never rendered bare: `readCost` decides which of five
 * readings is true first, and each gets its own sentence, because the same
 * `totalCostEstimate: 0` means four different things depending on the counters
 * beside it (nothing ran · a known covered zero · nothing could be priced · a
 * genuinely free exchange).
 */
/**
 * #996 M6 (#1162, data-movement spec §2.1) — WHERE this node's dispatch actually
 * resolved to.
 *
 * §2.1's argument for recording the address at all is the reason it has to be
 * rendered: the node holds a dataset *ref*, and a dataset row is MUTABLE, so a
 * rerun pinned to the same `pipelineVersionId` writes wherever that dataset
 * points TODAY. "A run's own log cannot answer 'where did this data go', which
 * is the first question anyone asks." M6 slice B (#1149) made the answer
 * durable on `node.dispatched`; until this, reading it meant querying
 * `run_events` — which §2.1 names as the unacceptable state, not a workaround.
 *
 * PRESENCE-GATED on the fact, never on the activity type. This panel has no doc
 * and cannot ask what kind a node is (the same constraint the attempts docblock
 * works under), and it does not need to: every dispatch that resolved a dataset
 * recorded one, and nothing else did.
 *
 * The address is rendered by `describeDatasetAddress`, the shared renderer the
 * engine's own self-copy refusal already uses — so a refusal message and this
 * section cannot drift into two spellings of one address. Only `kind` is set in
 * `<code>`: the description supplies its own quoting, and wrapping it too would
 * double-decorate it.
 *
 * `storeIdentity` is deliberately NOT shown. It is a `dev:ino` comparison token
 * that exists so the self-copy gate survives a case-aliasing filesystem — it
 * identifies a store, it does not address one, and on screen it would read as
 * part of the path.
 *
 * NOT restated here: that a parallel foreach folds its items onto one row and
 * this is the last item's address. The panel already says exactly that, once,
 * above every section (`node.instanceId`), and a second copy beside this one
 * would be a second thing to keep true.
 */
function DataMovementSection({
  addresses,
}: {
  addresses: NonNullable<NodeActivity['datasetAddresses']>;
}) {
  const { source, sink } = addresses;
  /* A `query` dataset's `object` is `null` BY DESIGN — it is a SELECT over an
     arbitrary set of tables, and `address.ts` refuses to reduce that to one
     name rather than guess. `describeDatasetAddress` then renders the store
     alone, which unexplained reads as a truncated render rather than as the
     stated absence it is.

     GATED ON `null` ONLY, and NOT on the other single-value rendering — a
     `delimited` end, whose `object` EQUALS its store. The two look alike on
     screen and are opposite facts: a query names no object, while a file IS the
     object it names, so there is nothing absent to explain and a sentence there
     would invent a gap. If a third store kind ever collapses to one value, the
     question to answer is which of those two it is, not whether to widen this. */
  /* Name the ends rather than saying "that end": with two ends rendered and
     only one of them a query, an unattributed sentence leaves the reader to
     guess which row it explains — and guessing wrong is exactly the truncated
     -render misreading the sentence exists to prevent. */
  const unnamedEnds = [
    source.object === null ? 'source' : undefined,
    sink !== undefined && sink.object === null ? 'sink' : undefined,
  ].filter((end): end is string => end !== undefined);
  return (
    <section className="contract-section">
      <h4>Data movement</h4>
      <p className="page-hint">
        Where this dispatch resolved to. A node names a dataset, and a dataset can be edited after
        the version was minted — so this is where the data actually went, which a rerun may not
        repeat.
      </p>
      <dl className="run-meta">
        <dt>Source</dt>
        <dd>
          <AddressValue address={source} />
        </dd>
        {sink !== undefined && (
          <>
            <dt>Sink</dt>
            <dd>
              <AddressValue address={sink} />
            </dd>
          </>
        )}
      </dl>
      {unnamedEnds.length > 0 && (
        <p className="page-hint">
          A query names no single object in its store, so only the store is recorded for the{' '}
          {unnamedEnds.join(' and ')}.
        </p>
      )}
    </section>
  );
}

function AddressValue({ address }: { address: DatasetAddress }) {
  return (
    <>
      <code>{address.kind}</code> {describeDatasetAddress(address)}
    </>
  );
}

function CostSection({ node }: { node: NodeActivity }) {
  const reading = readCost(node.cost);
  const { cost } = node;
  return (
    <section className="contract-section">
      <h4>Cost &amp; usage</h4>
      <p>
        <strong>{costFigure(reading)}</strong>
      </p>
      <p className="page-hint">{costSentence(reading, 'node')}</p>

      {cost.models.length > 0 && (
        <dl className="run-meta">
          <dt>{cost.models.length === 1 ? 'Model' : 'Models'}</dt>
          <dd>
            {cost.models.map((m) => (
              <code key={m}>{m}</code>
            ))}
          </dd>
          <dt>Tokens</dt>
          <dd>
            {/* The load-bearing arm, and it answers PER SIDE. An `agent_cli`
                spend fact carries no counts at all; a provider that sent only
                `prompt_eval_count` carries one. Either way an unmeasured side
                must say so rather than print `0` — the same manufactured zero
                the Duration line refuses. */}
            {tokenSummary(cost)}
          </dd>
        </dl>
      )}

      {(reading.inputTokensPartial || reading.outputTokensPartial) && (
        <p className="page-hint">
          Not every exchange reported a count — {reading.inputReportedCount} of {cost.responseCount}{' '}
          reported input and {reading.outputReportedCount} of {cost.responseCount} reported output —
          so these sums are partial.
        </p>
      )}

      {reading.exchangesAreFloor && (
        <p className="page-hint">
          A CLI activity records one exchange per <em>invocation</em>, and the CLI does not report
          the model calls it makes internally — so this count is a floor, not a census.
        </p>
      )}

      {node.costSpansInstances && (
        /* M2 — worded about the KEY, not about "parallel items". An `id@n` key is
           how a parallel foreach writes its items, but a sequential doc may carry
           a literal `x@2` node id, and no reader may infer the one from the other
           (`instance-key.ts`). The scope claim is true either way. */
        <p className="page-hint">
          This total SUMS every result keyed <code>id@n</code> that folded onto this node — unlike
          the outputs above, which are one of them.
        </p>
      )}

      {!TERMINAL_NODE.has(node.status) && (
        /* The figure is a RUNNING total. Same objection the Duration section
           answers one block up ("this attempt has not settled yet"): on a live
           tail an in-flight node's spend-so-far otherwise reads with exactly the
           confidence of a settled one. */
        <p className="page-hint">{unsettledSentence(reading, 'node')}</p>
      )}
    </section>
  );
}

/**
 * #866 slice 2 — WHICH TOOLS the node's LLM loop ran.
 *
 * `round` alone does not identify a row: it restarts at 0 on every attempt, and
 * sibling parallel-foreach items run their own exchanges concurrently. So the
 * attempt and the instance are stamped on each call by the fold and rendered as
 * their own columns whenever more than one of either appears — rather than left
 * as a caveat under the table for the reader to apply themselves.
 *
 * Args and results are shown as SIZES. Their content is not in the log at all
 * (only chars + a hash), and the hash is a drift fingerprint, not something a
 * person reads — but the size is the one thing about an opaque payload that is
 * actionable.
 */
/**
 * The cap on RENDERED rows. `index.css` also bounds the list by height, and the
 * two are not redundant: the stylesheet stops the panel growing, this stops the
 * DOM growing — an agent loop's call count is unbounded, and #869 is the same
 * lesson from the other direction (a panel that serialised a whole payload into
 * the DOM). The list is truncated from the FRONT, keeping the most recent, and
 * says so; a silent subset would read as the whole history.
 */
const MAX_TOOL_ROWS = 100;

function ToolCallSection({ calls }: { calls: NodeToolCall[] }) {
  const shown = calls.length > MAX_TOOL_ROWS ? calls.slice(-MAX_TOOL_ROWS) : calls;
  const showAttempt = calls.some((c) => c.attempt !== calls[0]?.attempt);
  const showInstance = calls.some((c) => c.instanceId !== undefined);
  const errors = calls.filter((c) => c.isError).length;
  return (
    <section className="contract-section">
      <h4>Tool calls</h4>
      <p className="page-hint">
        {calls.length} call{calls.length === 1 ? '' : 's'}
        {errors > 0 && <>, {errors} of which returned an error to the model</>}.
      </p>
      <table className="node-tool-calls">
        <thead>
          <tr>
            {showAttempt && <th scope="col">Attempt</th>}
            {showInstance && <th scope="col">Item</th>}
            <th scope="col">Round</th>
            <th scope="col">Tool</th>
            <th scope="col">Args</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((call, i) => (
            <tr key={`${call.instanceId ?? ''}#${call.attempt}#${call.round}#${call.callId ?? i}`}>
              {showAttempt && <td>{call.attempt}</td>}
              {showInstance && <td>{call.instanceId}</td>}
              <td>{call.round}</td>
              <td>
                {/* A structurally nameless call is answered with an error
                    tool_result and never asserted — so it is named as nameless
                    rather than rendered as an empty cell, which reads as a
                    rendering fault. */}
                {call.toolName === '' ? <em>unnamed</em> : call.toolName}
                {call.isError && <span className="tool-call-error"> · error</span>}
              </td>
              <td>{call.argsChars} chars</td>
              <td>{call.resultChars} chars</td>
            </tr>
          ))}
        </tbody>
      </table>
      {calls.length > shown.length && (
        <p className="page-hint">
          … showing the most recent {shown.length} of {calls.length} calls.
        </p>
      )}
    </section>
  );
}
