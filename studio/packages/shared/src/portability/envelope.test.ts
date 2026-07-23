import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, SCHEMA_VERSION } from '../schemas/version.js';
import {
  ExportEnvelopeSchema,
  ImportError,
  NodeExportSchema,
  parseAndUpgradeEnvelope,
  type Upgrader,
} from './envelope.js';

const validPipelineEnvelope = {
  schemaVersion: SCHEMA_VERSION,
  catalogVersion: CATALOG_VERSION,
  kind: 'pipeline' as const,
  exportedAt: 1700000000000,
  data: {
    pipeline: {
      id: 'pipe_1',
      // #3 G1 — stable identity rides every current export.
      resourceId: 'res_pipe1',
      ownerId: null,
      name: 'P',
      // #5 S6b — the per-pipeline cap rides the export envelope (a pre-S6b
      // envelope without the key imports as uncapped via the read default).
      concurrency: null,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
    versions: [
      {
        id: 'pv_1',
        resourceId: 'res_pv1',
        pipelineId: 'pipe_1',
        version: 1,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        containers: [],
        catalogVersion: CATALOG_VERSION,
        createdAt: 1700000000000,
      },
    ],
    strippedConnectionRefs: [],
  },
};

describe('NodeExportSchema', () => {
  it('accepts a null connectionId', () => {
    const node = {
      id: 'n1',
      type: 'llm_call',
      config: {},
      connectionId: null,
      position: { x: 0, y: 0 },
    };
    expect(NodeExportSchema.parse(node)).toEqual(node);
  });

  it('rejects an omitted connectionId (must be explicitly null, unlike NodeSchema)', () => {
    const node = { id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } };
    expect(() => NodeExportSchema.parse(node)).toThrow();
  });
});

describe('ExportEnvelopeSchema', () => {
  it('round-trips a valid pipeline envelope', () => {
    expect(ExportEnvelopeSchema.parse(validPipelineEnvelope)).toEqual(validPipelineEnvelope);
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      ExportEnvelopeSchema.parse({ ...validPipelineEnvelope, kind: 'not_a_real_kind' }),
    ).toThrow();
  });

  it("rejects a pipeline envelope whose data doesn't match the pipeline shape", () => {
    expect(() =>
      ExportEnvelopeSchema.parse({ ...validPipelineEnvelope, data: { nope: true } }),
    ).toThrow();
  });

  it('defaults strippedConnectionRefs to [] for an older envelope that predates the field', () => {
    const { strippedConnectionRefs, ...dataWithoutField } = validPipelineEnvelope.data;
    void strippedConnectionRefs;
    const legacyEnvelope = { ...validPipelineEnvelope, data: dataWithoutField };
    const result = ExportEnvelopeSchema.parse(legacyEnvelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    expect(result.data.strippedConnectionRefs).toEqual([]);
  });
});

describe('parseAndUpgradeEnvelope', () => {
  it('accepts a JSON string, not just a parsed object', () => {
    const result = parseAndUpgradeEnvelope(JSON.stringify(validPipelineEnvelope));
    expect(result).toEqual(validPipelineEnvelope);
  });

  it('accepts an already-parsed object', () => {
    expect(parseAndUpgradeEnvelope(validPipelineEnvelope)).toEqual(validPipelineEnvelope);
  });

  it('at SCHEMA_VERSION with an empty upgrader registry, this is pure validation (identity)', () => {
    const result = parseAndUpgradeEnvelope(validPipelineEnvelope, new Map());
    expect(result).toEqual(validPipelineEnvelope);
  });

  it('throws ImportError on invalid JSON', () => {
    expect(() => parseAndUpgradeEnvelope('not-json-{{{')).toThrow(ImportError);
  });

  it('throws ImportError when the payload is not a JSON object (e.g. an array)', () => {
    expect(() => parseAndUpgradeEnvelope([1, 2, 3])).toThrow(ImportError);
  });

  it('throws ImportError on a missing/invalid schemaVersion', () => {
    const { schemaVersion, ...rest } = validPipelineEnvelope;
    void schemaVersion;
    expect(() => parseAndUpgradeEnvelope(rest)).toThrow(ImportError);
    expect(() => parseAndUpgradeEnvelope({ ...validPipelineEnvelope, schemaVersion: 'x' })).toThrow(
      ImportError,
    );
  });

  it('throws ImportError on a missing/invalid catalogVersion', () => {
    const { catalogVersion, ...rest } = validPipelineEnvelope;
    void catalogVersion;
    expect(() => parseAndUpgradeEnvelope(rest)).toThrow(ImportError);
  });

  it('throws ImportError on a schemaVersion newer than this build supports', () => {
    expect(() =>
      parseAndUpgradeEnvelope({ ...validPipelineEnvelope, schemaVersion: SCHEMA_VERSION + 1 }),
    ).toThrow(ImportError);
  });

  it('throws ImportError on a catalogVersion newer than this build supports', () => {
    expect(() =>
      parseAndUpgradeEnvelope({ ...validPipelineEnvelope, catalogVersion: CATALOG_VERSION + 1 }),
    ).toThrow(ImportError);
  });

  it('throws a validation-failure ImportError for a malformed-but-versioned envelope', () => {
    expect(() =>
      parseAndUpgradeEnvelope({
        schemaVersion: SCHEMA_VERSION,
        catalogVersion: CATALOG_VERSION,
        kind: 'pipeline',
        exportedAt: 1,
        data: { totally: 'wrong shape' },
      }),
    ).toThrow(ImportError);
  });

  describe('the upgrade framework (chained-apply)', () => {
    // Version-stamp-only hops from `from` up to SCHEMA_VERSION, so the fake
    // legacy fixtures below (which reshape into the v1 pipeline shape — still
    // shape-identical at v2 for a pipeline envelope) reach the current version
    // without re-encoding the real upgraders.
    const passthroughHops = (from: number): Array<[number, Upgrader]> =>
      Array.from({ length: SCHEMA_VERSION - from }, (_, i) => [
        from + i,
        (env: unknown) => ({ ...(env as Record<string, unknown>), schemaVersion: from + i + 1 }),
      ]);

    it('chains a FAKE upgrader registered from a lower schemaVersion up to SCHEMA_VERSION', () => {
      // Simulate a legacy (pre-CATALOG_VERSION-aware, differently-shaped)
      // envelope at schemaVersion 0 and a fake upgrader that reshapes it into
      // today's valid v1 pipeline envelope. This is exactly the one-entry
      // add a future real schema bump would make to `UPGRADERS`.
      const legacyV0Envelope = {
        schemaVersion: 0,
        catalogVersion: CATALOG_VERSION,
        kind: 'pipeline',
        exportedAt: 1700000000000,
        legacyPipelineBlob: validPipelineEnvelope.data,
      };

      const upgradeV0ToV1: Upgrader = (env) => {
        const e = env as typeof legacyV0Envelope;
        const { legacyPipelineBlob, ...rest } = e;
        return { ...rest, schemaVersion: 1, data: legacyPipelineBlob };
      };

      // A passthrough hop for each version between the fake's landing point
      // (1) and today's SCHEMA_VERSION, so this test keeps exercising the
      // chain without re-encoding every real upgrader's reshaping.
      const fakeRegistry = new Map<number, Upgrader>([[0, upgradeV0ToV1], ...passthroughHops(1)]);
      const result = parseAndUpgradeEnvelope(legacyV0Envelope, fakeRegistry);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result).toEqual(validPipelineEnvelope);
    });

    it('chains TWO fake upgraders through the real entry point (a genuine multi-hop path)', () => {
      // Two hops BELOW today's SCHEMA_VERSION (1): -1 -> 0 -> 1, both
      // registered at once, so `parseAndUpgradeEnvelope`'s own loop (not the
      // test) is what walks the full chain.
      const legacyMinusOneEnvelope = {
        schemaVersion: -1,
        catalogVersion: CATALOG_VERSION,
        kind: 'pipeline',
        exportedAt: 1700000000000,
        veryLegacyBlob: validPipelineEnvelope.data,
      };
      const upgradeMinusOneToZero: Upgrader = (env) => {
        const e = env as typeof legacyMinusOneEnvelope;
        const { veryLegacyBlob, ...rest } = e;
        return { ...rest, schemaVersion: 0, legacyPipelineBlob: veryLegacyBlob };
      };
      const upgradeZeroToOne: Upgrader = (env) => {
        const e = env as { legacyPipelineBlob: unknown } & Record<string, unknown>;
        const { legacyPipelineBlob, ...rest } = e;
        return { ...rest, schemaVersion: 1, data: legacyPipelineBlob };
      };

      const fakeRegistry = new Map<number, Upgrader>([
        [-1, upgradeMinusOneToZero],
        [0, upgradeZeroToOne],
        ...passthroughHops(1),
      ]);

      const result = parseAndUpgradeEnvelope(legacyMinusOneEnvelope, fakeRegistry);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result).toEqual(validPipelineEnvelope);
    });

    it('throws ImportError when no upgrader is registered for an older schemaVersion', () => {
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      expect(() => parseAndUpgradeEnvelope(olderEnvelope, new Map())).toThrow(ImportError);
    });

    it("throws ImportError when a registered upgrader doesn't advance schemaVersion", () => {
      const brokenUpgrader: Upgrader = (env) => env; // returns schemaVersion unchanged
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      expect(() => parseAndUpgradeEnvelope(olderEnvelope, new Map([[0, brokenUpgrader]]))).toThrow(
        ImportError,
      );
    });

    it('throws ImportError when a registered upgrader OVERSHOOTS past schemaVersion + 1', () => {
      // A single upgrader that jumps straight from 0 to SCHEMA_VERSION + 1
      // (skipping 1, and skipping SCHEMA_VERSION itself) must be rejected —
      // otherwise it could silently skip an intermediate version's own
      // upgrader, or land past `SCHEMA_VERSION` undetected.
      const overshootingUpgrader: Upgrader = (env) => {
        const e = env as Record<string, unknown>;
        return { ...e, schemaVersion: SCHEMA_VERSION + 1 };
      };
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      expect(() =>
        parseAndUpgradeEnvelope(olderEnvelope, new Map([[0, overshootingUpgrader]])),
      ).toThrow(ImportError);
    });

    it('throws ImportError on a version GAP with no upgrader registered for the intermediate version', () => {
      // Two hops below SCHEMA_VERSION (-1 -> 0 -> 1), but only the FIRST
      // hop's upgrader is registered — the chain must not be able to skip
      // straight from -1 to SCHEMA_VERSION even if such an upgrader existed;
      // here it simply has nowhere to go once it reaches schemaVersion 0.
      const upgradeMinusOneToZero: Upgrader = (env) => {
        const e = env as Record<string, unknown>;
        return { ...e, schemaVersion: 0 };
      };
      const legacyEnvelope = { ...validPipelineEnvelope, schemaVersion: -1 };
      expect(() =>
        parseAndUpgradeEnvelope(legacyEnvelope, new Map([[-1, upgradeMinusOneToZero]])),
      ).toThrow(ImportError);
    });

    it('a normal one-hop-at-a-time chain lands EXACTLY on SCHEMA_VERSION', () => {
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      const result = parseAndUpgradeEnvelope(olderEnvelope, new Map(passthroughHops(0)));
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('throws ImportError when a registered upgrader returns a malformed (non-object) envelope', () => {
      const brokenUpgrader: Upgrader = () => 'not-an-object';
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      expect(() => parseAndUpgradeEnvelope(olderEnvelope, new Map([[0, brokenUpgrader]]))).toThrow(
        ImportError,
      );
    });
  });

  // #5 S8 — the REAL v1→v2 upgrader (the production `UPGRADERS` registry):
  // a v1 trigger envelope predates `recurrence` (#5 S5b — which bumped no
  // version, a latent import break healed here) and `event` (#5 S8), both now
  // required-nullable on the stored shape. The upgrader backfills `null` (the
  // honest "never had one" value) so a pre-S5b/pre-S8 export still imports.
  describe('v1→v2 upgrader (production registry)', () => {
    const v1TriggerData = {
      id: 'trig_1',
      ownerId: null,
      name: 'Legacy trigger',
      pipelineVersionId: null,
      params: {},
      mode: 'manual' as const,
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' as const },
      runWindows: null,
      enabled: false,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      // NO `recurrence`, NO `event` — the pre-S5b/pre-S8 v1 shape.
    };
    const v1TriggerEnvelope = {
      schemaVersion: 1,
      catalogVersion: CATALOG_VERSION,
      kind: 'trigger' as const,
      exportedAt: 1700000000000,
      data: v1TriggerData,
    };

    it('imports a v1 trigger envelope, chain-upgrading to backfill recurrence/event/window', () => {
      const result = parseAndUpgradeEnvelope(v1TriggerEnvelope);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.recurrence).toBeNull();
      expect(result.data.event).toBeNull();
      expect(result.data.window).toBeNull();
    });

    it('does NOT clobber a v1 trigger envelope that already carries a recurrence', () => {
      const recurrence = { frequency: 'day', interval: 1 };
      const env = { ...v1TriggerEnvelope, data: { ...v1TriggerData, recurrence } };
      const result = parseAndUpgradeEnvelope(env);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.recurrence).toEqual(recurrence);
      expect(result.data.event).toBeNull();
    });

    it('upgrades a v1 pipeline envelope untouched (only the version stamp advances)', () => {
      const result = parseAndUpgradeEnvelope({ ...validPipelineEnvelope, schemaVersion: 1 });
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.kind).toBe('pipeline');
    });

    it('a CURRENT trigger envelope needs no upgrade (already at SCHEMA_VERSION)', () => {
      const env = {
        ...v1TriggerEnvelope,
        schemaVersion: SCHEMA_VERSION,
        // A current envelope carries every stamped field, incl. #3 G1's
        // resourceId (nullable in the export shape).
        data: {
          ...v1TriggerData,
          recurrence: null,
          event: null,
          window: null,
          resourceId: 'res_trig1',
        },
      };
      const result = parseAndUpgradeEnvelope(env);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    });
  });

  // #5 S9 — the v2→v3 upgrader: a v2 trigger envelope predates `window`
  // (required-nullable on the stored shape since S9).
  describe('v2→v3 upgrader (production registry)', () => {
    const v2TriggerData = {
      id: 'trig_1',
      ownerId: null,
      name: 'S8-era trigger',
      pipelineVersionId: null,
      params: {},
      mode: 'event' as const,
      schedule: null,
      webhook: null,
      recurrence: null,
      event: { name: 'order.created' },
      concurrency: { policy: 'queue' as const },
      runWindows: null,
      enabled: false,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      // NO `window` — the pre-S9 v2 shape.
    };
    const v2TriggerEnvelope = {
      schemaVersion: 2,
      catalogVersion: CATALOG_VERSION,
      kind: 'trigger' as const,
      exportedAt: 1700000000000,
      data: v2TriggerData,
    };

    it('imports a v2 trigger envelope, backfilling window:null (event kept verbatim)', () => {
      const result = parseAndUpgradeEnvelope(v2TriggerEnvelope);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.window).toBeNull();
      expect(result.data.event).toEqual({ name: 'order.created' });
    });

    it('does NOT clobber a v2 trigger envelope that already carries a window', () => {
      const window = {
        frequency: 'hour' as const,
        interval: 1,
        startTime: '2026-07-01T00:00:00.000Z',
      };
      const env = {
        ...v2TriggerEnvelope,
        data: { ...v2TriggerData, mode: 'tumbling' as const, event: null, window },
      };
      const result = parseAndUpgradeEnvelope(env);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.window).toEqual(window);
    });

    it('upgrades a v2 pipeline envelope untouched (only the version stamp advances)', () => {
      const result = parseAndUpgradeEnvelope({ ...validPipelineEnvelope, schemaVersion: 2 });
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.kind).toBe('pipeline');
    });
  });

  describe('v3→v4 upgrader (production registry, #3 G1 resourceId)', () => {
    // A v3 export carries NO resourceId anywhere — strip them from the
    // current fixture to build honest pre-G1 shapes.
    const { resourceId: strippedPipelineResourceId, ...v3Pipeline } =
      validPipelineEnvelope.data.pipeline;
    const { resourceId: strippedVersionResourceId, ...v3Version } =
      validPipelineEnvelope.data.versions[0]!;
    void strippedPipelineResourceId;
    void strippedVersionResourceId;
    const v3PipelineEnvelope = {
      ...validPipelineEnvelope,
      schemaVersion: 3,
      data: {
        ...validPipelineEnvelope.data,
        pipeline: v3Pipeline,
        versions: [v3Version, { ...v3Version, id: 'pv_2', version: 2 }],
      },
    };

    it('backfills resourceId:null on the NESTED pipeline AND every versions[] entry', () => {
      const result = parseAndUpgradeEnvelope(v3PipelineEnvelope);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      if (result.kind !== 'pipeline') throw new Error('expected a pipeline envelope');
      expect(result.data.pipeline.resourceId).toBeNull();
      expect(result.data.versions).toHaveLength(2);
      for (const version of result.data.versions) {
        expect(version.resourceId).toBeNull();
      }
    });

    it('backfills resourceId:null on a v3 trigger envelope', () => {
      const v3TriggerEnvelope = {
        schemaVersion: 3,
        catalogVersion: CATALOG_VERSION,
        kind: 'trigger' as const,
        exportedAt: 1700000000000,
        data: {
          id: 'trig_1',
          ownerId: null,
          name: 'pre-G1 trigger',
          pipelineVersionId: null,
          params: {},
          mode: 'manual' as const,
          schedule: null,
          webhook: null,
          recurrence: null,
          event: null,
          window: null,
          concurrency: { policy: 'queue' as const },
          runWindows: null,
          enabled: false,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          // NO `resourceId` — the pre-G1 v3 shape.
        },
      };
      const result = parseAndUpgradeEnvelope(v3TriggerEnvelope);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.resourceId).toBeNull();
    });

    it('backfills resourceId:null on a v3 connection envelope', () => {
      const v3ConnectionEnvelope = {
        schemaVersion: 3,
        catalogVersion: CATALOG_VERSION,
        kind: 'connection' as const,
        exportedAt: 1700000000000,
        data: {
          id: 'conn_1',
          ownerId: null,
          name: 'pre-G1 connection',
          kind: 'http' as const,
          config: {},
          parameters: [],
          requiresSecret: false,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          // NO `resourceId` — the pre-G1 v3 shape.
        },
      };
      const result = parseAndUpgradeEnvelope(v3ConnectionEnvelope);
      if (result.kind !== 'connection') throw new Error('expected a connection envelope');
      expect(result.data.resourceId).toBeNull();
    });

    it('does NOT clobber an already-present resourceId', () => {
      // A hand-rolled v3-stamped envelope that (illegally early) carries
      // resourceIds: the deterministic spread must keep them verbatim.
      const env = { ...validPipelineEnvelope, schemaVersion: 3 };
      const result = parseAndUpgradeEnvelope(env);
      if (result.kind !== 'pipeline') throw new Error('expected a pipeline envelope');
      expect(result.data.pipeline.resourceId).toBe('res_pipe1');
      expect(result.data.versions[0]!.resourceId).toBe('res_pv1');
    });

    it('a v1 trigger envelope chains ALL the way: recurrence/event/window/resourceId backfilled', () => {
      const v1TriggerEnvelope = {
        schemaVersion: 1,
        catalogVersion: CATALOG_VERSION,
        kind: 'trigger' as const,
        exportedAt: 1700000000000,
        data: {
          id: 'trig_1',
          ownerId: null,
          name: 'v1-era trigger',
          pipelineVersionId: null,
          params: {},
          mode: 'manual' as const,
          schedule: null,
          webhook: null,
          concurrency: { policy: 'queue' as const },
          runWindows: null,
          enabled: false,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      };
      const result = parseAndUpgradeEnvelope(v1TriggerEnvelope);
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);
      if (result.kind !== 'trigger') throw new Error('expected a trigger envelope');
      expect(result.data.recurrence).toBeNull();
      expect(result.data.event).toBeNull();
      expect(result.data.window).toBeNull();
      expect(result.data.resourceId).toBeNull();
    });
  });
});
