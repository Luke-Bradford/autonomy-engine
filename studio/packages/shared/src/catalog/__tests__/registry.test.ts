import { describe, expect, it } from 'vitest';
import { catalog, getActivity } from '../registry.js';

describe('activity catalog', () => {
  it('exposes the MVP activity types', () => {
    expect([...catalog.keys()].sort()).toEqual(['agent_task', 'http_request', 'llm_call']);
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
  it('every MVP activity is connector-dispatched (kind: execution)', () => {
    // Pins the claim F9a's spec block makes: no CONTROL entry exists yet, so
    // the executor's control guard is unreachable through the shipped catalog
    // and F9a's production behaviour delta is zero. The first control activity
    // arrives with #4's A-series (if/switch/wait/…) and lands here.
    for (const entry of catalog.values()) {
      expect(entry.kind).toBe('execution');
    }
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
