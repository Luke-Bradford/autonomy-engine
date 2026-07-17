import { describe, expect, it } from 'vitest';
import { catalog, getActivity, isStructuralCallActivity } from '../registry.js';
import { EXECUTE_PIPELINE_ACTIVITY_TYPE } from '../types.js';

describe('activity catalog', () => {
  it('exposes the MVP activity types', () => {
    // `if` (#4 A1) is the first CONTROL activity, `switch` (#4 A2) the second,
    // `fail` (#4 A7) the third, `filter` (#4 A8) the fourth, `wait` (#4 A5+A6) the
    // fifth (and first DURABLE control activity) — all engine-evaluated, catalogued
    // so the palette/executor-guard/version know them. `execute_pipeline` (#4 A9)
    // surfaces the pre-existing structural `Node.call` mechanism as a first-class
    // catalog TYPE (its config rides `node.call`, not `node.config`).
    expect([...catalog.keys()].sort()).toEqual([
      'agent_task',
      'execute_pipeline',
      'fail',
      'filter',
      'http_request',
      'if',
      'llm_call',
      'switch',
      'wait',
    ]);
  });

  it('getActivity returns an entry for a known type and undefined for an unknown one', () => {
    expect(getActivity('http_request')?.type).toBe('http_request');
    expect(getActivity('nope')).toBeUndefined();
  });

  it('every MVP activity is non-idempotent (fail-safe crash-recovery default)', () => {
    // The reconciler FREEZES a non-idempotent in-flight node; a real activity
    // that regressed to idempotent:true would be silently re-run on resume.
    for (const entry of catalog.values()) {
      expect(entry.idempotent).toBe(false);
    }
  });

  it('http_request needs an http connection and declares its outputs', () => {
    const http = getActivity('http_request')!;
    expect(http.connectionKinds).toEqual(['http']);
    expect(http.outputs.map((o) => o.name).sort()).toEqual(['body', 'headers', 'status']);
  });

  it('http_request declares `secretHeaders` as its secret SINK (item 7 / S4)', () => {
    // The FIRST real activity to open a sink — `validateRefs` accepts a
    // `{$secret}` marker within `secretHeaders` and refuses it anywhere else.
    expect(getActivity('http_request')!.secretSinkFields).toEqual(['secretHeaders']);
  });

  it('http_request is the ONLY activity in the whole catalog with a secret sink (fail-closed elsewhere)', () => {
    // Assert across the full catalog, not a named subset, so a future activity
    // that silently gains a sink is caught here rather than slipping through.
    const withSink = [...catalog.values()]
      .filter((entry) => entry.secretSinkFields !== undefined)
      .map((entry) => entry.type);
    expect(withSink).toEqual(['http_request']);
  });

  it('llm_call binds any of the three LLM connection kinds', () => {
    expect(getActivity('llm_call')!.connectionKinds).toEqual([
      'anthropic_api',
      'openai_api',
      'ollama',
    ]);
  });

  it('an activity configSchema validates its settings blob', () => {
    const http = getActivity('http_request')!;
    expect(http.configSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
    // Missing the required `url`.
    expect(http.configSchema.safeParse({ method: 'GET' }).success).toBe(false);
  });
});

// --- F9a: the ActivityDefinition contract (#1 D6) ---------------------------

describe('activity definition contract (#1 D6)', () => {
  it('splits execution (connector-dispatched) from control (engine-evaluated)', () => {
    // Since #4 A1 the catalog has BOTH: `if`/`switch` are the `control` entries
    // (the executor's `CONTROL_NOT_DISPATCHABLE` guard is now reachable),
    // everything else is `execution`. An execution activity binds >=1 connection;
    // a control activity binds NONE (it never touches a connector).
    for (const type of ['if', 'switch', 'fail']) {
      expect(getActivity(type)!.kind).toBe('control');
      expect(getActivity(type)!.connectionKinds).toEqual([]);
      expect(getActivity(type)!.outputs).toEqual([]);
    }
    for (const entry of catalog.values()) {
      if (entry.kind === 'control') continue;
      expect(entry.kind).toBe('execution');
    }
  });

  it('switch is a control activity exposing an on/cases configSchema for the palette (#4 A2)', () => {
    const sw = getActivity('switch')!;
    expect(sw.category).toBe('control');
    expect(
      sw.configSchema.safeParse({ on: '${nodes.c.output.t}', cases: ['a', 'b'] }).success,
    ).toBe(true);
    // Missing the required `on`.
    expect(sw.configSchema.safeParse({ cases: ['a'] }).success).toBe(false);
  });

  it('fail is a control activity exposing a message configSchema for the palette (#4 A7)', () => {
    const fail = getActivity('fail')!;
    expect(fail.category).toBe('control');
    expect(fail.configSchema.safeParse({ message: 'rejected the input' }).success).toBe(true);
    // Missing / empty message is refused by the palette schema.
    expect(fail.configSchema.safeParse({}).success).toBe(false);
    expect(fail.configSchema.safeParse({ message: '' }).success).toBe(false);
  });

  it('execute_pipeline is a control activity typing the Node.call blob for the palette (#4 A9)', () => {
    const ep = getActivity(EXECUTE_PIPELINE_ACTIVITY_TYPE)!;
    expect(ep.kind).toBe('control');
    expect(ep.category).toBe('control');
    // A call node binds NO connection (it spawns a child run, never a connector)
    // and its outputs come from the CHILD projection, never a catalog template —
    // so it seeds no `outputs` (see `lowerNodeOutputs`, which skips call nodes).
    expect(ep.connectionKinds).toEqual([]);
    expect(ep.outputs).toEqual([]);
    expect(ep.idempotent).toBe(false);
    // configSchema mirrors the `CallConfigSchema` (`node.call`) — it types the CALL
    // blob, not `node.config` (the structural-call exception). A valid call parses;
    // a missing `pipelineVersionId` is refused.
    expect(ep.configSchema.safeParse({ pipelineVersionId: 'v1', params: {} }).success).toBe(true);
    expect(ep.configSchema.safeParse({ params: {} }).success).toBe(false);
  });

  it('execute_pipeline is the only structural-call activity (config rides node.call, #4 A9/#425)', () => {
    // The palette/inspector author `node.config`; a structural-call activity's
    // settings live in `node.call`, so the generic palette excludes it (call-node
    // authoring is #425). Asserted across the full catalog so a future entry that
    // silently becomes a structural-call type is caught here.
    const structural = [...catalog.values()]
      .map((e) => e.type)
      .filter((t) => isStructuralCallActivity(t));
    expect(structural).toEqual([EXECUTE_PIPELINE_ACTIVITY_TYPE]);
    expect(isStructuralCallActivity('if')).toBe(false);
    expect(isStructuralCallActivity('http_request')).toBe(false);
  });

  it('categorises the MVP set per spec #4 (agent_task is an AI activity, not its own class)', () => {
    expect(getActivity('http_request')!.category).toBe('general');
    expect(getActivity('llm_call')!.category).toBe('ai');
    // Spec #4 lists `agent_task` under "Execution — AI (Spec #2)" alongside
    // `llm_call` — an external CLI agent is an AI activity, not a third class.
    expect(getActivity('agent_task')!.category).toBe('ai');
  });
});

// A `kind`/`category` SHAPE test is deliberately absent: both are typed fields
// on literal entries, so TS strict already rejects an unknown value at compile
// time and the runtime assertion could never fire. The rule "an EXECUTION
// activity declares >=1 connectionKind" is deliberately NOT pinned either — it
// holds for today's catalog but is NOT a law: `executor.ts` reserves execution +
// no connection as the future built-in-runner slot (and tests it fails cleanly
// as `no_executor`), so asserting it would trip the first ticket to use it.
