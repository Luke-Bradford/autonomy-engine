import { describe, expect, it } from 'vitest';
import type { ConnectionKind, ConnectionProbeResult } from '@autonomy-studio/shared';
import { z } from 'zod';
import {
  PROBE_BACKSTOP_MS,
  boundaryKeysChangedByOverlay,
  probeConnection,
} from '../probe.js';
import type { ConnectorAdapter } from '../types.js';
import type { ConnectorRegistry } from '../registry.js';

/**
 * #1191 — the route boundary over `ConnectorAdapter.testConnection`.
 *
 * Everything here is about what the ROUTE owes that an adapter does not: never
 * throwing, never hanging forever, never echoing a plaintext, and never letting
 * a config overlay spend a stored credential somewhere the saved connection
 * does not point.
 */

function registryOf(
  kind: ConnectionKind,
  testConnection: ConnectorAdapter['testConnection'],
): ConnectorRegistry {
  const adapter = {
    kind,
    configSchema: z.object({}),
    testConnection,
    runActivity: () => {
      throw new Error('not used by a probe');
    },
  } as unknown as ConnectorAdapter;
  return new Map<ConnectionKind, ConnectorAdapter>([[kind, adapter]]);
}

const NO_ADAPTERS: ConnectorRegistry = new Map();

describe('probeConnection', () => {
  it('passes the adapter’s own verdict through, `probed` and all', async () => {
    const registry = registryOf('fs', async () => ({ ok: true, probed: 'liveness' }));
    await expect(
      probeConnection({ registry, kind: 'fs', config: { roots: ['/tmp'] }, secret: null }),
    ).resolves.toEqual({ ok: true, probed: 'liveness' });
  });

  it('hands the adapter the config and secret it was given', async () => {
    const seen: { config?: unknown; secret?: unknown } = {};
    const registry = registryOf('postgres', async (config, secret) => {
      seen.config = config;
      seen.secret = secret;
      return { ok: true, probed: 'liveness' };
    });
    await probeConnection({
      registry,
      kind: 'postgres',
      config: { host: 'db.internal' },
      secret: 'hunter2',
    });
    expect(seen).toEqual({ config: { host: 'db.internal' }, secret: 'hunter2' });
  });

  it('refuses a kind with no adapter rather than reporting ok', async () => {
    const result = await probeConnection({
      registry: NO_ADAPTERS,
      kind: 'postgres',
      config: {},
      secret: null,
    });
    expect(result).toEqual({ ok: false, error: "no adapter for connection kind 'postgres'" });
  });

  it('turns an adapter that REJECTS into a sentence, not a thrown error', async () => {
    // The contract says `testConnection` resolves and never rejects. A route
    // must not 500 when an adapter breaks that promise.
    const registry = registryOf('http', async () => {
      throw new Error('adapter blew up');
    });
    await expect(
      probeConnection({ registry, kind: 'http', config: {}, secret: null }),
    ).resolves.toEqual({ ok: false, error: 'adapter blew up' });
  });

  it('redacts the plaintext secret out of an adapter error it forgot to redact', async () => {
    const registry = registryOf('postgres', async (_config, secret) => ({
      ok: false,
      error: `connection string rejected: postgres://app:${String(secret)}@db/app`,
    }));
    const result = await probeConnection({
      registry,
      kind: 'postgres',
      config: {},
      secret: 's3cr3t-pw',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    // The property that matters is ABSENCE of the plaintext — not any
    // particular sentinel. The adapters use two (`***` here, `[redacted]` in
    // postgres's own redaction), and asserting a sentinel would pin the wrong
    // thing.
    expect(result.error).not.toContain('s3cr3t-pw');
    expect(result.error).toContain('***');
  });

  it('redacts a plaintext quoted by an adapter that THREW', async () => {
    const registry = registryOf('postgres', async (_config, secret) => {
      throw new Error(`bad password: ${String(secret)}`);
    });
    const result = await probeConnection({
      registry,
      kind: 'postgres',
      config: {},
      secret: 'leaky',
    });
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).not.toContain('leaky');
  });

  it('abandons an adapter that never settles, and says so honestly', async () => {
    // The hazard `postgres-session.ts` documents: a client whose own timeout no
    // longer applies once the handshake has begun. Without the backstop the
    // request hangs forever; the server sets no `requestTimeout`.
    const registry = registryOf('postgres', () => new Promise<ConnectionProbeResult>(() => {}));
    const result = await probeConnection({
      registry,
      kind: 'postgres',
      config: {},
      secret: null,
      backstopMs: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    // "abandoned", not "the store timed out": the engine gave up, and the
    // sentence must not be mistaken for the store's own verdict.
    expect(result.error).toMatch(/did not answer within 0s and was abandoned/);
  });

  it('sits above the default LLM probe budget, so an honest slow probe is never pre-empted', () => {
    // `DEFAULT_LLM_TIMEOUT_MS` is 120_000 and the LLM adapters pass it straight
    // to `llmProbeGet`. A backstop at or below it would report "abandoned" for
    // an adapter behaving exactly as configured.
    expect(PROBE_BACKSTOP_MS).toBeGreaterThan(120_000);
  });
});

describe('boundaryKeysChangedByOverlay', () => {
  it('is empty when the overlay changes only a NON-boundary key', () => {
    // `connectTimeoutMs` is deliberately outside the postgres list — the map's
    // own rule is "identity and transport are fixed; only how long it waits is
    // a per-dispatch tunable". Editing it must stay probeable with the stored
    // secret, or the refusal would swallow the ordinary case.
    expect(
      boundaryKeysChangedByOverlay(
        'postgres',
        { host: 'db.internal', port: 5432, database: 'app', connectTimeoutMs: 5_000 },
        { host: 'db.internal', port: 5432, database: 'app', connectTimeoutMs: 9_000 },
      ),
    ).toEqual([]);
  });

  it('names EVERY changed boundary key, sorted, not just the first', () => {
    expect(
      boundaryKeysChangedByOverlay(
        'postgres',
        { host: 'db.internal', port: 5432, database: 'app', sslmode: 'verify-full' },
        { host: 'db.internal', port: 5433, database: 'other', sslmode: 'disable' },
      ),
    ).toEqual(['database', 'port', 'sslmode']);
  });

  it('names a REWRITTEN destination key', () => {
    expect(
      boundaryKeysChangedByOverlay(
        'postgres',
        { host: 'db.internal', port: 5432 },
        { host: 'attacker.example', port: 5432 },
      ),
    ).toEqual(['host']);
  });

  it('names a DROPPED destination key — removing it redirects too', () => {
    // The overlay replaces the config wholesale rather than merging, so an
    // absent `host` is not "unchanged"; it is a different destination.
    expect(boundaryKeysChangedByOverlay('postgres', { host: 'db.internal' }, {})).toEqual(['host']);
  });

  it('compares an ARRAY-valued boundary key by value, not by identity', () => {
    // `fs.roots` is the only array-valued boundary key. An equal-but-distinct
    // array must read as unchanged, or every edit-form probe of an `fs`
    // connection would be refused.
    expect(
      boundaryKeysChangedByOverlay('fs', { roots: ['/srv/data'] }, { roots: ['/srv/data'] }),
    ).toEqual([]);
    expect(
      boundaryKeysChangedByOverlay('fs', { roots: ['/srv/data'] }, { roots: ['/etc'] }),
    ).toEqual(['roots']);
  });

  it('flags nothing for a kind that declares no boundary keys', () => {
    // `http` has an empty list: its `baseUrl` IS overridable per dispatch, so
    // this rule is a deliberate no-op there and the refusal never fires.
    expect(
      boundaryKeysChangedByOverlay(
        'http',
        { baseUrl: 'https://api.example' },
        { baseUrl: 'https://attacker.example' },
      ),
    ).toEqual([]);
  });
});
