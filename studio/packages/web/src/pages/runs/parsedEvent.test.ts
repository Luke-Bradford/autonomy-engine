import { describe, expect, it, vi } from 'vitest';
import {
  EngineEventSchema,
  type EngineDoc,
  type EngineEvent,
  type RunEvent,
} from '@autonomy-studio/shared';
import { projectRun } from './runProjection';
import { deriveNodeActivity, deriveRunLifecycle } from './runSummary';
import { parseEngineEvent } from './parsedEvent';

let seq = 0;
/** The durable envelope shape the log/stream carry — see `runSummary.test.ts`. */
function envelope(event: EngineEvent): RunEvent {
  return {
    id: `evt_${seq}`,
    runId: event.runId,
    seq: seq++,
    type: event.type,
    payload: event,
    ts: seq,
  };
}

const doc: EngineDoc = {
  nodes: [{ id: 'a', type: 'noop', name: 'A', config: {} }],
  edges: [],
  containers: [],
  params: [],
} as unknown as EngineDoc;

const log = (n: number): RunEvent[] => [
  envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} }),
  ...Array.from({ length: n - 1 }, () =>
    envelope({ type: 'node.dispatched', runId: 'run_1', nodeId: 'a' } as EngineEvent),
  ),
];

/**
 * #849 — the run page walked the whole log three times per appended event, and
 * every walk re-validated every row through Zod. That is quadratic in the log's
 * length, and Zod validation is the dominant cost in each walk — so a live run
 * got slower to WATCH the longer it ran.
 *
 * These count `safeParse` CALLS rather than timing anything: the defect is a
 * call count, so timing would only be a flakier way of asking the same question.
 */
describe('parseEngineEvent', () => {
  it('validates a given envelope exactly once, however often it is asked', () => {
    const rows = log(4);
    const spy = vi.spyOn(EngineEventSchema, 'safeParse');

    const first = rows.map((r) => parseEngineEvent(r));
    const second = rows.map((r) => parseEngineEvent(r));

    expect(spy).toHaveBeenCalledTimes(rows.length);
    /* Not merely cached — the SAME instance, which is what lets the walks share
       a materialisation. If this ever has to become a copy, the memo's docblock
       invariant (nothing mutates a parsed event) is what changed. */
    expect(second).toEqual(first);
    second.forEach((e, i) => expect(e).toBe(first[i]));
  });

  it('caches the REFUSAL too, so a malformed row is not re-validated per walk', () => {
    const bad: RunEvent = {
      id: 'evt_bad',
      runId: 'run_1',
      seq: 999,
      type: 'run.started',
      payload: { type: 'nonsense' },
      ts: 1,
    };
    const spy = vi.spyOn(EngineEventSchema, 'safeParse');

    expect(parseEngineEvent(bad)).toBeNull();
    expect(parseEngineEvent(bad)).toBeNull();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is shared ACROSS the page three walks, not re-paid by each', () => {
    const rows = log(5);
    /* Warm nothing first: this is the cold path a real append takes, where all
       three walks re-run over a log whose rows are mostly unchanged. */
    const spy = vi.spyOn(EngineEventSchema, 'safeParse');

    projectRun(doc, rows);
    deriveNodeActivity(rows);
    deriveRunLifecycle(rows);

    /* Before the memo this was 3 × rows.length. The point of the ticket is that
       the multiplier is the one that grows with the number of walks AND with the
       log, so pinning `rows.length` pins the whole shape. */
    expect(spy).toHaveBeenCalledTimes(rows.length);
  });
});
