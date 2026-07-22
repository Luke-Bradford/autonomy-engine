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

      const fakeRegistry = new Map<number, Upgrader>([[0, upgradeV0ToV1]]);
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

    it('a normal one-step chain lands EXACTLY on SCHEMA_VERSION', () => {
      const upgradeZeroToOne: Upgrader = (env) => {
        const e = env as Record<string, unknown>;
        return { ...e, schemaVersion: 1 };
      };
      const olderEnvelope = { ...validPipelineEnvelope, schemaVersion: 0 };
      const result = parseAndUpgradeEnvelope(olderEnvelope, new Map([[0, upgradeZeroToOne]]));
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
});
