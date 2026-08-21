import { describe, expect, it } from 'vitest';
import type { ConnectionKind, ConnectionProbeResult } from '@autonomy-studio/shared';
import { z } from 'zod';
import {
  PROBE_BACKSTOP_MS,
  PROBE_CONCURRENCY,
  configKeysChangedByOverlay,
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

  it('rebuilds a success from its known fields, so nothing rides out beside them', async () => {
    // Redaction only ever scrubbed the FAILURE path, because a success is
    // supposed to carry no adapter string at all. TypeScript does not enforce
    // that on a value returned through a variable, and no response schema strips
    // it, so the guarantee is made structural here instead.
    const registry = registryOf(
      'http',
      async () =>
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        ({
          ok: true,
          probed: 'liveness',
          debug: 'authenticated with sk-live-abc',
        }) as unknown as ConnectionProbeResult,
    );
    await expect(
      probeConnection({ registry, kind: 'http', config: {}, secret: 'sk-live-abc' }),
    ).resolves.toEqual({ ok: true, probed: 'liveness' });
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

  it('caps how many probes are in flight at once, process-wide', async () => {
    // The cap is what makes the backstop safe to be a RACE rather than a cancel:
    // an abandoned probe keeps its socket, so without a ceiling N requests mean
    // N live sockets on a server that sets no `requestTimeout`.
    let started = 0;
    const release: Array<() => void> = [];
    const registry = registryOf(
      'http',
      () =>
        new Promise<ConnectionProbeResult>((resolve) => {
          started += 1;
          release.push(() => resolve({ ok: true, probed: 'liveness' }));
        }),
    );

    const inFlight = Array.from({ length: PROBE_CONCURRENCY + 3 }, () =>
      probeConnection({ registry, kind: 'http', config: {}, secret: null }),
    );
    // Let every queued task that CAN start, start.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(PROBE_CONCURRENCY);

    // Freeing one admits exactly one more — the queue drains, it does not refuse.
    release.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(PROBE_CONCURRENCY + 1);

    // Drain: releasing frees a slot, which admits the next queued probe, which
    // registers ITS own release — so this walks the queue rather than iterating
    // a snapshot of it.
    for (let guard = 0; guard < 50 && release.length > 0; guard += 1) {
      release.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(inFlight);
    expect(started).toBe(PROBE_CONCURRENCY + 3);
  });

  it('sits above the default LLM probe budget, so an honest slow probe is never pre-empted', () => {
    // `DEFAULT_LLM_TIMEOUT_MS` is 120_000 and the LLM adapters pass it straight
    // to `llmProbeGet`. A backstop at or below it would report "abandoned" for
    // an adapter behaving exactly as configured.
    expect(PROBE_BACKSTOP_MS).toBeGreaterThan(120_000);
  });
});

describe('configKeysChangedByOverlay', () => {
  it('is empty when the overlay is exactly the stored config', () => {
    const stored = { host: 'db.internal', port: 5432, database: 'app', sslmode: 'disable' };
    expect(configKeysChangedByOverlay(stored, { ...stored })).toEqual([]);
  });

  it('names EVERY changed key, sorted, not just the first', () => {
    expect(
      configKeysChangedByOverlay(
        { host: 'db.internal', port: 5432, database: 'app', sslmode: 'verify-full' },
        { host: 'db.internal', port: 5433, database: 'other', sslmode: 'disable' },
      ),
    ).toEqual(['database', 'port', 'sslmode']);
  });

  it('names a DROPPED key — removing one changes the config too', () => {
    // The overlay replaces the config wholesale rather than merging, so an
    // absent key is not "unchanged"; it is a different config.
    expect(configKeysChangedByOverlay({ host: 'db.internal' }, {})).toEqual(['host']);
  });

  it('names an ADDED key', () => {
    expect(configKeysChangedByOverlay({}, { baseUrl: 'https://attacker.example' })).toEqual([
      'baseUrl',
    ]);
  });

  it('compares by VALUE, not identity, for arrays and objects', () => {
    // Equal-but-distinct values must read as unchanged, or an unedited form
    // round-trip would be refused on every probe.
    expect(configKeysChangedByOverlay({ roots: ['/srv/data'] }, { roots: ['/srv/data'] })).toEqual(
      [],
    );
    expect(configKeysChangedByOverlay({ roots: ['/srv/data'] }, { roots: ['/etc'] })).toEqual([
      'roots',
    ]);
    // Key ORDER inside an object-valued setting is not a change.
    expect(
      configKeysChangedByOverlay({ headers: { a: '1', b: '2' } }, { headers: { b: '2', a: '1' } }),
    ).toEqual([]);
  });

  it('reports a value it CANNOT canonicalize as changed, never as unchanged', () => {
    // Reachable from an HTTP body: JSON permits a literal that overflows on
    // parse, so `{"port": 1e400}` arrives as `Infinity` and `canonicalStringify`
    // REFUSES it (`Number.isFinite`). Two things must hold, and the second is
    // the security-relevant one:
    //   1. it does not throw — the route's promise is a sentence, never a 500;
    //   2. it fails CLOSED — a value that cannot be represented is a value that
    //      cannot be PROVED identical to the stored one, so the guard refuses
    //      and the stored secret is never spent on it.
    const overflowed = JSON.parse('{"port":1e400}') as { port: number };
    expect(Number.isFinite(overflowed.port)).toBe(false);
    expect(configKeysChangedByOverlay({ port: 5432 }, { port: overflowed.port })).toEqual(['port']);
    // Even against ITSELF: unprovable is unprovable, in both directions.
    expect(
      configKeysChangedByOverlay({ port: overflowed.port }, { port: overflowed.port }),
    ).toEqual(['port']);
    expect(configKeysChangedByOverlay({ port: overflowed.port }, { port: 5432 })).toEqual(['port']);
  });

  it('consults NO per-kind allowlist — it takes no kind at all', () => {
    // The regression this function exists for. The first version asked
    // `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS` which keys were dangerous; that
    // table is EMPTY for `http`/`anthropic_api`/`openai_api`, three kinds whose
    // probes send the stored secret to `config.baseUrl` as an auth header. A
    // rule that consulted it returned "nothing changed" for the single most
    // dangerous overlay there is. This one cannot: it has no kind to consult.
    expect(
      configKeysChangedByOverlay(
        { baseUrl: 'https://api.anthropic.com' },
        { baseUrl: 'https://attacker.example' },
      ),
    ).toEqual(['baseUrl']);
  });
});
