import { describe, expect, it } from 'vitest';
import type { Node, PipelineVersion } from '../types.js';
import {
  MAX_CONFIG_DEPTH,
  collectSecretSinkMarkers,
  scanSecretSinks,
  validateRefs,
} from '../params.js';

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

  it('refuses a marker even when config is a top-level ARRAY (no field ⇒ no sink)', () => {
    const errors: string[] = [];
    scanSecretSinks('nodes.n.config', [MARKER] as unknown, ['secretHeaders'], errors);
    expect(errors).toEqual(['nodes.n.config[0]: secret reference is not allowed here']);
  });

  it('refuses a config that is itself a bare marker', () => {
    const errors: string[] = [];
    scanSecretSinks('nodes.n.config', MARKER as unknown, ['$secret'], errors);
    expect(errors).toEqual(['nodes.n.config: secret reference is not allowed here']);
  });
});

describe('scanSecretSinks — §2 marker-shape rules (at a declared sink)', () => {
  it('rejects a name that contains a ${} expression (must be a literal)', () => {
    const errors = scan({ apiKey: { $secret: '${params.x}' } }, ['apiKey']);
    // Message is PRESENT; the existing `${}` scan may also flag the inner ref,
    // so assert presence, not an exact count.
    expect(errors.some((e) => /literal/.test(e))).toBe(true);
  });

  it('rejects a name carrying a $${ escape (substitute would rewrite it to a different name)', () => {
    // `substitute` recurses into the marker and turns `foo$${x}` into `foo${x}`,
    // so the gated name would differ from the S3-resolved name — refuse it.
    const errors = scan({ apiKey: { $secret: 'foo$${x}' } }, ['apiKey']);
    expect(errors.some((e) => /literal/.test(e))).toBe(true);
  });

  it('accepts a plain literal name at a sink (the happy path)', () => {
    expect(scan({ apiKey: { $secret: 'prod/db-password' } }, ['apiKey'])).toEqual([]);
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

// --- collectSecretSinkMarkers (item 7 / S3): the DISPATCH-time companion ----
// It MUST visit the exact same positions the gate blesses (shared traversal, no
// drift) and return config-RELATIVE `{path, name}` pairs for VALID in-sink
// markers only. The executor keys its resolved-plaintext side channel by `path`.

describe('collectSecretSinkMarkers — collects valid in-sink markers only', () => {
  it('collects a marker directly at a sink (config-relative path, no prefix)', () => {
    expect(collectSecretSinkMarkers({ apiKey: MARKER }, ['apiKey'])).toEqual([
      { path: 'apiKey', name: 'stripe-key' },
    ]);
  });

  it('collects markers NESTED under a sink field with dotted paths, key-sorted', () => {
    expect(
      collectSecretSinkMarkers({ secretHeaders: { 'X-Api-Key': MARKER, Authorization: MARKER } }, [
        'secretHeaders',
      ]),
    ).toEqual([
      // Object keys are visited sorted (deterministic), so Authorization first.
      { path: 'secretHeaders.Authorization', name: 'stripe-key' },
      { path: 'secretHeaders.X-Api-Key', name: 'stripe-key' },
    ]);
  });

  it('collects a marker inside an ARRAY under a sink field with [i] paths', () => {
    expect(collectSecretSinkMarkers({ keys: [MARKER] }, ['keys'])).toEqual([
      { path: 'keys[0]', name: 'stripe-key' },
    ]);
  });

  it('NEVER collects a marker outside a declared sink (parity with the gate reject)', () => {
    expect(
      collectSecretSinkMarkers({ url: MARKER, body: { auth: MARKER } }, ['secretHeaders']),
    ).toEqual([]);
  });

  it('skips a malformed marker even AT a sink (only { $secret: <non-empty string> } resolves)', () => {
    // A stored version cannot hold these (the save gate rejects them); the
    // resolver skips rather than resolve garbage — defence in depth.
    expect(collectSecretSinkMarkers({ apiKey: { $secret: 123 } }, ['apiKey'])).toEqual([]);
    expect(collectSecretSinkMarkers({ apiKey: { $secret: 'x', extra: 1 } }, ['apiKey'])).toEqual(
      [],
    );
  });

  it('is empty when the activity declares no sinks (fail-closed — nothing to resolve)', () => {
    expect(collectSecretSinkMarkers({ apiKey: MARKER }, [])).toEqual([]);
  });

  it('collects the SAME positions the gate accepts (no drift)', () => {
    // Everything the gate leaves error-free at a sink is exactly what the
    // resolver collects — the shared traversal makes this hold by construction.
    const config = { secretHeaders: { Authorization: MARKER }, url: 'https://x' };
    expect(scan(config, ['secretHeaders'])).toEqual([]);
    expect(collectSecretSinkMarkers(config, ['secretHeaders'])).toEqual([
      { path: 'secretHeaders.Authorization', name: 'stripe-key' },
    ]);
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

describe('MAX_CONFIG_DEPTH bounds the marker walk on BOTH paths (#537)', () => {
  // Both the SAVE-time gate (`scanSecretSinks`) and the DISPATCH-time resolver
  // (`collectSecretSinkMarkers`) share ONE traversal (`walkConfigForMarkers`)
  // over an opaque, attacker-controlled `config`. A pathologically nested config
  // overflowed the stack before this cap. See params.test.ts for the shared-axis
  // rationale (config tree, distinct from expression nesting / ref-path depth).
  function deepConfig(n: number): Record<string, unknown> {
    let v: Record<string, unknown> = { end: 'leaf' };
    for (let i = 0; i < n; i += 1) v = { a: v };
    return v;
  }

  it('the SAVE gate reports a clean error past the cap — no RangeError', () => {
    let thrown: unknown;
    const errors: string[] = [];
    try {
      // Nest the deep tree UNDER a declared sink so the walk descends in-region.
      scanSecretSinks(
        'nodes.n.config',
        { sink: deepConfig(MAX_CONFIG_DEPTH + 50) },
        ['sink'],
        errors,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(errors.join('\n')).not.toMatch(/Maximum call stack/i);
    expect(errors.join('\n')).toMatch(/config nested too deep/i);
  });

  it('the DISPATCH resolver fail-safe STOPS at the cap — no throw, no markers', () => {
    // Defence-in-depth: no stored version can hold an over-deep config (the save
    // gate rejects it), and `substitute` overflows first on the run path anyway.
    // If one somehow reaches here, stopping is fail-safe — markers below the cut
    // were never blessed by the gate, so not resolving them is correct.
    let thrown: unknown;
    let out: { path: string; name: string }[] = [];
    try {
      out = collectSecretSinkMarkers({ sink: deepConfig(MAX_CONFIG_DEPTH + 50) }, ['sink']);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(out).toEqual([]);
  });
});
