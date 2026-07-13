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
