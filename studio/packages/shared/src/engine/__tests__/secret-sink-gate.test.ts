import { describe, expect, it } from 'vitest';
import type { Node, PipelineVersion } from '../types.js';
import { scanSecretSinks, validateRefs } from '../params.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(type: string, config: Record<string, unknown>): Node {
  seq += 1;
  return { id: `n${seq}`, type, config, position: { x: seq, y: 0 } };
}

function doc(nodes: Node[]): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params: [], nodes, edges: [], containers: [] };
}

/** Collect errors from a direct `scanSecretSinks` call with an explicit sink allow-list. */
function scan(config: Record<string, unknown>, sinkFields: readonly string[]): string[] {
  const errors: string[] = [];
  scanSecretSinks('nodes.n.config', config, sinkFields, errors);
  return errors;
}

const MARKER = { $secret: 'stripe-key' } as const;

// --- the gate against a SYNTHETIC sink-declaring activity -------------------
// No real activity declares a `secretSinkFields` until S4 (`http_request`),
// so the ACCEPT branch is exercised here by handing `scanSecretSinks` a
// synthetic sink list directly (the real pure function, not a mock). S4 owns
// the `validateRefs`-level accept test once `http_request` declares its sink.

describe('scanSecretSinks — accept at a declared sink', () => {
  it('accepts a marker directly AT a declared sink field', () => {
    expect(scan({ apiKey: MARKER }, ['apiKey'])).toEqual([]);
  });

  it('accepts a marker NESTED under a declared sink field (the S4 record-of-markers shape)', () => {
    // `http_request` (S4) declares `secretHeaders` = { <headerName>: {$secret} },
    // so a real marker lives one level down at config.secretHeaders.<name>.
    expect(
      scan({ secretHeaders: { Authorization: MARKER, 'X-Api-Key': MARKER } }, ['secretHeaders']),
    ).toEqual([]);
  });

  it('leaves non-marker config under a sink field untouched', () => {
    expect(
      scan({ secretHeaders: { Authorization: MARKER }, url: 'https://x' }, ['secretHeaders']),
    ).toEqual([]);
  });
});

describe('scanSecretSinks — reject off-sink', () => {
  it('rejects a marker at a NON-sink field', () => {
    const errors = scan({ url: MARKER }, ['secretHeaders']);
    expect(errors).toEqual(['nodes.n.config.url: secret reference is not allowed here']);
  });

  it('rejects a marker DEEPLY nested under a non-sink field (by first path segment)', () => {
    const errors = scan({ body: { auth: MARKER } }, ['secretHeaders']);
    expect(errors).toEqual(['nodes.n.config.body.auth: secret reference is not allowed here']);
  });

  it('rejects a marker inside an ARRAY under a non-sink field', () => {
    const errors = scan({ items: [MARKER] }, ['secretHeaders']);
    expect(errors).toEqual(['nodes.n.config.items[0]: secret reference is not allowed here']);
  });

  it('rejects EVERY marker when no sinks are declared (fail-closed)', () => {
    const errors = scan({ a: MARKER, b: { c: MARKER } }, []);
    expect(errors.length).toBe(2);
  });
});

describe('scanSecretSinks — §2 marker-shape rules (at a declared sink)', () => {
  it('rejects a name that contains a ${} expression (must be a literal)', () => {
    const errors = scan({ apiKey: { $secret: '${params.x}' } }, ['apiKey']);
    // Message is PRESENT; the existing `${}` scan may also flag the inner ref,
    // so assert presence, not an exact count.
    expect(errors.some((e) => /literal/.test(e))).toBe(true);
  });

  it('rejects a marker with an extra key (strict)', () => {
    const errors = scan({ apiKey: { $secret: 'x', extra: 1 } }, ['apiKey']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('nodes.n.config.apiKey');
  });

  it('rejects a non-string $secret value', () => {
    const errors = scan({ apiKey: { $secret: 123 } }, ['apiKey']);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// --- FAIL-CLOSED through the real gate + real catalog ----------------------

describe('validateRefs — fail-closed: no activity declares a secret sink (S2)', () => {
  it('refuses a marker in an http_request config (real catalog has no sink yet)', () => {
    const errors = validateRefs(
      doc([node('http_request', { headers: { Authorization: MARKER } })]),
    );
    expect(
      errors.some((e) =>
        e.endsWith('.config.headers.Authorization: secret reference is not allowed here'),
      ),
    ).toBe(true);
  });

  it('refuses a marker in an agent_task config too', () => {
    const errors = validateRefs(doc([node('agent_task', { task: MARKER })]));
    expect(errors.some((e) => /secret reference is not allowed here/.test(e))).toBe(true);
  });

  it('leaves a marker-free doc clean (no false positive from the sink walk)', () => {
    const errors = validateRefs(
      doc([node('http_request', { url: 'https://example.com', headers: { A: 'b' } })]),
    );
    expect(errors).toEqual([]);
  });

  it('refuses a marker under an UNKNOWN activity type (getActivity undefined ⇒ no sinks)', () => {
    const errors = validateRefs(doc([node('not_a_real_type', { x: MARKER })]));
    expect(errors.some((e) => /secret reference is not allowed here/.test(e))).toBe(true);
  });
});
