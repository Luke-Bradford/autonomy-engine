import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { describeDatasetAddress, SECURE_REDACTED, TERMINAL_NODE } from '@autonomy-studio/shared';
import type { DatasetAddress, DispatchInput, RunStatus } from '@autonomy-studio/shared';
import { nodeStatusLabel, nodeStatusPillClass, nodeStoppedByCancel } from './nodeStatus';
import { runDetailPath, runLinkLabel } from './runPath';
import { formatOutputValue, jsonText, liveSpanStart, prettyStoredJson } from './format';
import { NodeDuration } from './NodeDuration';
import { costFigure, costSentence, readCost, tokenSummary, unsettledSentence } from './costReading';
import type { NodeActivity, NodeToolCall } from './runSummary';
import { SecureMarkerHint } from './SecureMarkerHint';
import { CaptureSection } from './CaptureSection';
import { CappedValue } from './CappedValue';
import { PanelTabs } from '../pipeline/PanelTabs';
import { downloadTextFile } from '../../api/download';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { formatTimeOfDay, zoneLabel } from '../../lib/displayTime';
import type { StreamedLine } from './attemptActivity';
import { defaultDrawerTab, drawerFileStem, type DrawerTab } from './drawerTab';

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
 * three times, and this reuses the page's fold).
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
 * reason is per-control, and two of the three have since changed, so it is worth
 * stating precisely rather than as one blanket claim:
 *  - cancel DOES now have a primitive (the CX epic, #1320), but it cancels a
 *    RUN: `POST /api/runs/:id/cancel`. There is no per-node cancel in the engine
 *    (the cancel spec deliberately has none), so the control lives on the parent
 *    page (CX4), beside rerun.
 *  - retry still has no engine primitive — a node's retries are its policy's,
 *    applied by the reducer — so inventing a retry control here would cross the
 *    "no engine execution-semantics changes" boundary the UI epic draws.
 *  - rerun DOES now have a primitive (RS2), but it reruns a RUN, not a node:
 *    it resumes from the run's failure frontier. It therefore belongs to the
 *    parent page, which is where it lives, and there is still nothing a
 *    node-scoped rerun control could call.
 *
 * Every drill-in item the U24 row names is now shown. The ones this list once
 * deferred, each for a stated reason, have since shipped:
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
 * INPUT was on that list and no longer is: #890 records the config each
 * dispatch ran with, after `${}` substitution, on `node.dispatched`
 * (`InputSection`), with the connection and dataset parameters it applied
 * beside it. A node the executor never dispatches — a control activity,
 * a pipeline call, a node a rerun copied — and an `llm_call` not on
 * `capture: 'full'` still have none, and get no section rather than an
 * invented one.
 *
 * PROMPT/COMPLETION was on that list and no longer is: #605 (L9b) shipped it
 * for a node whose `capture` setting is `full` (`CaptureSection`). A default
 * (metadata) node still shows nothing, on purpose: its capture is lengths and
 * content hashes, and a sha256 on screen is not worth a section.
 *
 * The per-attempt DURATION was on that list and no longer is: #867 shipped it.
 * Both objections that kept it off were answered rather than waived — the span
 * is per-ATTEMPT, so a retry hold falls between two spans instead of inside
 * one, and the engine-evaluated kinds that have no start event are rendered as
 * unmeasured rather than given a manufactured `0ms`. What is still deferred is
 * a LIVE counter for an attempt in flight, which needs a clock this page does
 * not have (#890).
 *
 * #1484 OR35 M2 laid it out as ADF does: the record's identity, status, duration
 * and child runs on top, then four tabs — Input, Output, Error, Logs. Each JSON
 * block is indented and offers Copy and Download of the whole value. The tab
 * opens on the error when one is recorded and on the output otherwise, until
 * the operator picks one; the run page then keeps that pick from row to row.
 */
/** The panel's DOM id. */
const PANEL_ID = 'node-activity-panel';

/**
 * `name` is what the graph and the activity runs call this node — the
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
  runStatus,
  live,
  onClose,
  run,
  tab,
  onTab,
  fileStem,
}: {
  node: NodeActivity;
  name: string | null;
  /** The run's status, for the one node word that depends on it (CX4). */
  runStatus: RunStatus;
  /** #890 — whether the page would hear this node settle, so its Duration may count up. */
  live: boolean;
  onClose: () => void;
  /**
   * #1484 OR35 M2 — set when the panel shows ONE activity run (the run drawer)
   * rather than the node's latest: which attempt, which item or round, and why
   * it was skipped. `node` is then that attempt's record (`activityOfRow`).
   */
  run?: {
    attempt: number | null;
    iteration: string;
    skipWhy: ReactNode;
    /** Everything this attempt streamed (`attemptOutputLines`), for Logs. */
    lines?: readonly StreamedLine[];
  };
  /**
   * #1484 OR35 M2 — the tab, when the host holds the choice (the run page does,
   * so stepping from row to row keeps the operator's tab). `null` is "not chosen
   * yet": `defaultDrawerTab`. Without `onTab` the panel holds it itself.
   */
  tab?: DrawerTab | null;
  onTab?: (tab: DrawerTab) => void;
  /** What a downloaded block's file name starts with; the node's name else. */
  fileStem?: string;
}) {
  const [ownTab, setOwnTab] = useState<DrawerTab | null>(null);
  const chosen = onTab === undefined ? ownTab : (tab ?? null);
  const stem = fileStem ?? drawerFileStem([name ?? node.nodeId]);
  const lines = run?.lines;
  return (
    <aside
      id={PANEL_ID}
      className="property-panel node-detail-panel"
      aria-label={`Node ${name ?? node.nodeId}`}
      {...(run === undefined ? {} : { tabIndex: -1, 'data-drawer-focus': true })}
    >
      {/* `.page-header` is the existing title-plus-action row. The sibling
          property panels have no action in their heading, so none of them uses
          it; this one needs a Close beside the title rather than a new rule. */}
      <div className="panel-heading-row">
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
        <span className={nodeStatusPillClass(node.status, runStatus)}>
          {nodeStatusLabel(node.status, runStatus)}
        </span>{' '}
        {run === undefined ? (
          <>
            {node.attempts} attempt{node.attempts === 1 ? '' : 's'}
          </>
        ) : (
          /* One attempt's record counts one attempt, so the panel names WHICH
             one instead, and where it ran. */
          [run.attempt === null ? '' : `attempt ${run.attempt}`, run.iteration]
            .filter((part) => part !== '')
            .join(' · ')
        )}
        {run?.skipWhy}
      </p>

      {/* #918 / RS6 — ABOVE the duration and the outputs, because it is what
          makes both of them readable: a copied node has no span and zero
          attempts, and its Outputs section holds another run's values. Without
          this sentence the panel presents R1's result as this run's work, and
          the "0 attempts" under a green badge reads as a rendering bug. */}
      {node.copiedFromRunId !== undefined && (
        <p className="page-hint">
          This node did not run in this run. The rerun reused its result from run{' '}
          <code>{node.copiedFromRunId}</code>, so its outputs were computed there.
          {/* RS4 — a copied call node did not start a child either; say which
              child it is standing on, and give the way down to it. Worded to
              stay true in two cases: after a rerun OF a rerun the child's parent
              is an EARLIER run than the one named above, so the sentence never
              says whose child it is; and a `wait: false` child may still be
              running, so nothing here speaks of it as finished. */}
          {node.copiedChildRunId !== undefined && (
            <>
              {' '}
              The child run behind that result is{' '}
              <Link
                to={runDetailPath(node.copiedChildRunId)}
                aria-label={runLinkLabel('Reused child', node.copiedChildRunId)}
              >
                <code>{node.copiedChildRunId}</code>
              </Link>
              , and this rerun did not start another.
            </>
          )}
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
        Duration:{' '}
        <strong>
          <NodeDuration node={node} live={live} />
        </strong>{' '}
        — wall clock for {run === undefined ? 'the latest' : 'this'} attempt, from start to settle,
        including any wait it parked on and excluding time held between retries.{' '}
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
              : node.attempts === 0 && nodeStoppedByCancel(node.status, runStatus)
                ? /* CX4 (#1320) — not "yet": the run ended, and this node never will start. */
                  'The run was cancelled before this node started, so there is nothing to measure.'
                : node.attempts === 0
                  ? 'This node has not started, so there is nothing to measure yet.'
                  : 'No span was recorded for this attempt.')}
        {node.startedAtMs !== undefined &&
          node.endedAtMs === undefined &&
          (nodeStoppedByCancel(node.status, runStatus)
            ? /* #1329 — the started counterpart of the CX4 arm above: the run
                 ended, so this attempt never will settle. */
              'The run was cancelled while this attempt was live, so its span never closed.'
            : live && liveSpanStart(node) !== undefined
              ? /* #890 — the figure above is COUNTING, and "not complete" beside
                   a number that rises every second reads as a contradiction. */
                'This attempt has not settled yet, so the figure counts up from its start while this page is connected.'
              : 'This attempt has not settled yet, so its span is not complete.')}
        {/* The corrupt-log case. `formatNodeDuration` renders it as unmeasured
            rather than clamping to `0ms`, and without this arm it would be the
            ONE em-dash on this panel with no sentence explaining it — which
            reads as a rendering bug rather than as the finding it is. */}
        {node.startedAtMs !== undefined &&
          node.endedAtMs !== undefined &&
          node.endedAtMs < node.startedAtMs &&
          'The recorded end precedes the start, so the log’s clock is inconsistent and no span can be stated.'}
      </p>

      {/* One activity run is already one item's record, so the fold's
          most-recent-wins caveat does not apply to it. */}
      {run === undefined && node.instanceId !== undefined && (
        <p className="page-hint">
          Showing the result recorded under <code>{node.instanceId}</code>. Results keyed{' '}
          <code>id@n</code> — how a parallel foreach writes its items — fold onto the one node you
          drew, most recent wins. So this is one of them, not all of them.
        </p>
      )}

      {/* #1231 / U20 — the drill DOWN, ABOVE the tabs. A failed call node's
          failure came from the child, so the link is the next thing wanted
          whichever tab is open: under Output it would hide exactly when the
          drawer opens on Error. */}
      <ChildRuns node={node} />

      {/* #1484 OR35 M2 — ADF's four tabs. Every panel stays mounted (see
          `PanelTabs`), so a disclosure opened on Output survives a look at
          Input. */}
      <PanelTabs<DrawerTab>
        label="Activity run details"
        selected={chosen ?? defaultDrawerTab(node)}
        onSelect={onTab ?? setOwnTab}
        tabs={[
          {
            key: 'input',
            label: 'Input',
            content:
              node.input !== undefined || node.params !== undefined ? (
                /* Keyed like Outputs, below, and for the same reason: its
                   blocks are `CappedValue` disclosures too. */
                <InputSection
                  key={`${node.nodeId}#${node.instanceId ?? ''}`}
                  input={node.input}
                  params={node.params}
                  instanceId={node.inputInstanceId}
                  stem={stem}
                />
              ) : (
                <p className="page-hint">No input was recorded for this activity run.</p>
              ),
          },
          { key: 'output', label: 'Output', content: <OutputTab node={node} stem={stem} /> },
          {
            key: 'error',
            label: 'Error',
            content: <ErrorTab node={node} attempt={run?.attempt ?? null} />,
          },
          {
            key: 'logs',
            label: 'Logs',
            content: (
              <>
                <section className="contract-section">
                  <h4>Streamed output</h4>
                  <p>
                    {node.outputs} event{node.outputs === 1 ? '' : 's'}
                    {/* #1299 — the value only for the CURRENT attempt (`lastOutput` is
                        cleared on dispatch); the name alone otherwise, as before. */}
                    {node.lastOutput !== undefined ? (
                      <>
                        {' '}
                        (latest: {node.lastOutput.name} = {formatOutputValue(node.lastOutput.value)}
                        )
                      </>
                    ) : (
                      node.lastOutputName !== undefined && <> (latest: {node.lastOutputName})</>
                    )}
                  </p>
                  {/* A secure node's stream is redacted name AND value (`redactSecureEvent`). */}
                  <SecureMarkerHint
                    values={[node.lastOutputName, node.lastOutput?.name, node.lastOutput?.value]}
                  />
                </section>
                {lines !== undefined && lines.length > 0 && (
                  <StreamedLines lines={lines} stem={stem} />
                )}
              </>
            ),
          },
        ]}
      />
    </aside>
  );
}

/**
 * #1484 OR35 M2 — the Output tab: what this activity run produced. The data it
 * moved, a variable it wrote, its declared outputs, and an LLM node's cost, tool
 * calls and captures. Outputs and a variable write are JSON blocks with Copy and
 * Download; tool calls and captures are not JSON and get neither.
 */
function OutputTab({ node, stem }: { node: NodeActivity; stem: string }) {
  const hasCost = node.cost.responseCount > 0 || node.toolCalls.length > 0;
  const empty =
    node.datasetAddresses === undefined &&
    node.variableWrite === undefined &&
    node.outputValues === undefined &&
    !hasCost &&
    node.captures.length === 0;
  if (empty) return <p className="page-hint">No output was recorded for this activity run.</p>;
  return (
    <>
      {node.datasetAddresses !== undefined && (
        <DataMovementSection addresses={node.datasetAddresses} instanceId={node.inputInstanceId} />
      )}

      {/* KEYED on the node's identity, which is load-bearing rather than tidy.
          A host can swap this panel IN PLACE when a different node is shown
          rather than remount it (the editor's run drawer does). So without a
          key, an Outputs section expanded on node A would carry `expanded` into
          node B and put B's whole un-requested payload into the DOM: the very
          thing the cap exists to prevent, reintroduced by the control that
          relieves it. A foreach folds every item onto ONE `nodeId`, so
          `instanceId` is part of the identity too. The Input tab's section is
          keyed the same way. */}
      {/* #844 V7 — before Outputs, which for a writer only says that nothing
          was recorded: the write IS this node's result. Keyed like Outputs for
          the same reason, since both hold a `CappedValue` disclosure. */}
      {node.variableWrite !== undefined && (
        <VariableWriteSection
          key={`${node.nodeId}#${node.instanceId ?? ''}`}
          write={node.variableWrite}
          stem={stem}
        />
      )}

      <OutputsSection key={`${node.nodeId}#${node.instanceId ?? ''}`} node={node} stem={stem} />

      {/* The `||` is DEFENCE, not a live path: the tool loop yields its `metered`
          event before its `toolCalled` ones in the same round, so tool calls today
          imply at least one billed exchange. It is kept — with the `none` reading
          behind it — so that a future producer of tool calls without metering
          renders "no billed exchange" rather than silently dropping the section,
          which would read as "this panel does not do cost". */}
      {hasCost && <CostSection node={node} />}

      {node.toolCalls.length > 0 && <ToolCallSection calls={node.toolCalls} />}

      {node.captures.length > 0 && <CaptureSection captures={node.captures} />}
    </>
  );
}

/**
 * #1484 OR35 M2 — the Error tab: the error verbatim (its line breaks kept), its
 * class and code, and which attempt it was.
 */
function ErrorTab({ node, attempt }: { node: NodeActivity; attempt: number | null }) {
  if (node.status !== 'failure' && node.error === undefined) {
    return <p className="page-hint">This activity run did not fail.</p>;
  }
  return (
    <section className="contract-section">
      <h4>Failure</h4>
      {/* Gated on the STATUS, not on the message: a `call.returned` whose
          child RAN and failed sets the row red with no message of its own
          (only a refused spawn carries a `reason`, #796), and gating on
          `error` hid the whole section for it. */}
      {node.error === undefined ? (
        <p className="page-hint">
          No message was recorded — this node reports another run&apos;s outcome.
        </p>
      ) : (
        <pre className="node-error-text">{node.error}</pre>
      )}
      {node.failureKind === undefined && (
        /* Not a gap — `externalWait.expired` fails a node straight off its
           expiry alarm, with no `node.failed` to classify it. Say so rather
           than leave the section looking truncated, and never guess a kind:
           how the reducer treats an expired wait is the reducer's fact. */
        <p className="page-hint">This failure was recorded without a machine-readable class.</p>
      )}
      {(node.failureKind !== undefined || attempt !== null) && (
        <dl className="run-meta">
          {node.failureKind !== undefined && (
            <>
              <dt>Kind</dt>
              <dd>
                <code>{node.failureKind}</code>
              </dd>
            </>
          )}
          {node.failureCode !== undefined && (
            <>
              <dt>Code</dt>
              <dd>
                <code>{node.failureCode}</code>
              </dd>
            </>
          )}
          {attempt !== null && (
            <>
              <dt>Attempt</dt>
              <dd>{attempt}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/**
 * The most lines the Logs tab renders. A copy streams a progress line per batch
 * with no bound, so the list keeps the most RECENT and says what it cut — the
 * `MAX_TOOL_ROWS` rule. The download holds every line.
 */
const MAX_LOG_ROWS = 200;

/**
 * #1484 OR35 M2 — the Logs tab's lines: everything this attempt streamed, to
 * the millisecond in the display zone, and all of it as NDJSON on Download.
 * A secure node's lines arrive redacted from the server (`redactSecureEvent`),
 * so what is shown and saved is what the log holds.
 */
function StreamedLines({ lines, stem }: { lines: readonly StreamedLine[]; stem: string }) {
  const zone = useDisplayTimeZone();
  const shown = lines.slice(-MAX_LOG_ROWS);
  return (
    <section className="contract-section">
      <div className="capped-value-actions">
        <button
          type="button"
          onClick={() =>
            downloadTextFile(
              `${stem}-logs.ndjson`,
              lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
              'application/x-ndjson',
            )
          }
        >
          Download {lines.length} line{lines.length === 1 ? '' : 's'}
        </button>
      </div>
      {lines.length > shown.length && (
        <p className="page-hint">
          … showing the most recent {shown.length} of {lines.length} lines.
        </p>
      )}
      {/* The scroll is on a wrapper so the table keeps its table semantics. */}
      <div className="node-logs">
        <table aria-label="Streamed lines">
          <thead>
            <tr>
              <th scope="col">Time ({zoneLabel(shown[0]!.ts, zone)})</th>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.seq}>
                <td>{formatTimeOfDay(l.ts, zone, 'ms')}</td>
                <td>
                  <code>{l.name}</code>
                </td>
                <td>
                  <code>{formatOutputValue(l.value)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SecureMarkerHint values={shown.flatMap((l) => [l.name, l.value])} />
    </section>
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
        own spend, so this node&apos;s duration and cost are not{' '}
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
 * A parallel foreach folds its items onto one row, and each item can resolve a
 * different address (#1340), so the section names WHICH item's dispatch this
 * is — `inputInstanceId`, the same label `InputSection` shows. The hint above
 * every section (`node.instanceId`) cannot do it alone: it is stamped by
 * terminal events only, so while no item has settled it says nothing.
 */
function DataMovementSection({
  addresses,
  instanceId,
}: {
  addresses: NonNullable<NodeActivity['datasetAddresses']>;
  instanceId: string | undefined;
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
      {instanceId !== undefined && (
        <p className="page-hint">
          The address of <code>{instanceId}</code>: the item whose result is shown, or else the one
          dispatched most recently.
        </p>
      )}
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
 * #890 — the input the node's most recent dispatch ran with: its config after
 * `${}` substitution, as the run log stored it. A `{$secret}` field shows its
 * marker (the secret's NAME), because that is what the node was configured
 * with; the value was resolved after this was recorded.
 *
 * The server stores at most `DISPATCH_INPUT_MAX_CHARS` (4k units,
 * `MAX_OUTPUT_CHARS`'s size). Indenting it (#1484 M2) can take it past
 * `CappedValue`'s cap, and then the same disclosure as Outputs reveals the rest
 * of the STORED text. What a cut withholds is not in the log at all, and the
 * hint says so; a cut text is shown as stored, unindented, since it no longer
 * parses.
 *
 * The PARAMETERS the dispatch applied over its connection's and datasets'
 * stored settings (`node.dispatched.params`) sit under their own heading: the
 * config alone does not show them, and they are recorded, cut and withheld on
 * the same terms. A dispatch that bound none has no Parameters heading.
 */
function InputSection({
  input,
  params,
  instanceId,
  stem,
}: {
  input: DispatchInput | undefined;
  params: DispatchInput | undefined;
  instanceId: string | undefined;
  stem: string;
}) {
  return (
    <section className="contract-section">
      <h4>Input</h4>
      {instanceId !== undefined && (
        <p className="page-hint">
          The input of <code>{instanceId}</code>: the item whose result is shown, or else the one
          dispatched most recently.
        </p>
      )}
      {input !== undefined ? (
        <RecordedText record={input} id={INPUT_CONFIG_ID} file={`${stem}-input`} what="input" />
      ) : (
        // Only a config JSON cannot represent gets here: everything else that
        // withholds the config withholds the parameters too.
        <p className="page-hint">This dispatch&rsquo;s config was not recorded.</p>
      )}
      {params !== undefined && (
        <>
          <h5>Parameters</h5>
          <p className="page-hint">
            The connection and dataset parameters this dispatch applied over their stored settings.
          </p>
          <RecordedText
            record={params}
            id={INPUT_PARAMS_ID}
            file={`${stem}-parameters`}
            what="parameters"
          />
        </>
      )}
    </section>
  );
}

const INPUT_CONFIG_ID = 'node-detail-input-config';
const INPUT_PARAMS_ID = 'node-detail-input-params';

/**
 * One `DispatchInput` as stored: the text, a cut hint, or the secure withholding.
 *
 * Indented when it parses, as stored when it does not — which is what a text
 * the run log cut short does. A cut one downloads as `…-truncated.txt`, so the
 * file never passes for the whole config. A withheld one offers neither copy
 * nor download: there is nothing behind the marker to hand over.
 */
function RecordedText({
  record,
  id,
  file,
  what,
}: {
  record: DispatchInput;
  id: string;
  file: string;
  what: string;
}) {
  if (record.text === SECURE_REDACTED) {
    return (
      <p className="page-hint">
        <code>{SECURE_REDACTED}</code> — withheld from the run log: this node&rsquo;s run policy has
        Secure input or Secure output set ({record.chars} characters).
      </p>
    );
  }
  const pretty = record.truncated === true ? null : prettyStoredJson(record.text);
  return (
    <>
      <CappedValue
        id={id}
        text={pretty ?? record.text}
        what={what}
        download={
          record.truncated === true
            ? `${file}-truncated.txt`
            : pretty === null
              ? `${file}.txt`
              : `${file}.json`
        }
      />
      {record.truncated === true && (
        <p className="page-hint">
          … the run log stored the first {record.text.length} of {record.chars} characters.
        </p>
      )}
    </>
  );
}

/** The element the disclosure toggle owns, named so it can be `aria-controls`. */
const OUTPUTS_ID = 'node-detail-output-values';

const VARIABLE_WRITE_ID = 'node-detail-variable-write';

/**
 * #844 V7 (spec V-D9) — what a `set_variable`/`append_variable` node wrote,
 * from its own event. An `append` shows the ELEMENT it added, not the array:
 * the array is the run's, and the run page's Variables section shows it.
 */
function VariableWriteSection({
  write,
  stem,
}: {
  write: NonNullable<NodeActivity['variableWrite']>;
  stem: string;
}) {
  return (
    <section className="contract-section">
      <h4>Variable write</h4>
      <p>
        {write.op === 'set' ? (
          <>
            Set <code>{write.name}</code> to:
          </>
        ) : (
          <>
            Appended to <code>{write.name}</code>:
          </>
        )}
      </p>
      <CappedValue
        id={VARIABLE_WRITE_ID}
        text={jsonText(write.value, 2)}
        what="variable write"
        download={`${stem}-variable-write.json`}
      />
    </section>
  );
}

function OutputsSection({ node, stem }: { node: NodeActivity; stem: string }) {
  if (node.outputValues === undefined) return null;
  const names = Object.keys(node.outputValues);
  return (
    <section className="contract-section">
      <h4>Outputs</h4>
      {names.length === 0 ? (
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
        /* Indented (#1484 M2), but one value can still be one long unbroken
           token; `.node-detail-outputs` wraps and scrolls it rather than letting
           it push the panel sideways. */
        <CappedValue
          id={OUTPUTS_ID}
          text={jsonText(node.outputValues, 2)}
          what="outputs"
          download={`${stem}-output.json`}
        />
      )}
      <SecureMarkerHint values={Object.values(node.outputValues)} />
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
