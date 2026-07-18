import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRICE_TABLE_VERSION,
  BUILTIN_PRICES,
  computeCostEstimate,
  ModelUnitPriceSchema,
  parseConnectionPriceTable,
  resolvePrice,
  type ConnectionPriceTable,
} from '../price-table.js';

describe('#2 L5 — resolvePrice', () => {
  it('resolves a built-in Anthropic model against the pinned table version', () => {
    // The key is the EXACT resolved model-ID string the adapter stamps
    // (`activity.metered.model`), NOT the friendly tier name — a mismatch would
    // silently unprice every response.
    expect(resolvePrice('anthropic_api', 'claude-opus-4-8', null)).toEqual({
      inUnitPrice: 5,
      outUnitPrice: 25,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
    expect(resolvePrice('anthropic_api', 'claude-sonnet-5', null)).toEqual({
      inUnitPrice: 3,
      outUnitPrice: 15,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
    expect(resolvePrice('anthropic_api', 'claude-haiku-4-5', null)).toEqual({
      inUnitPrice: 1,
      outUnitPrice: 5,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
  });

  it('returns null (UNPRICED, never a zero) for a model with no known price', () => {
    // A legacy-active Anthropic model absent from the built-in table.
    expect(resolvePrice('anthropic_api', 'claude-opus-4-5', null)).toBeNull();
    // A dated/variant ID does NOT fuzzy-match the base ID — exact-string only.
    expect(resolvePrice('anthropic_api', 'claude-opus-4-8-20251101', null)).toBeNull();
    // openai/ollama carry no built-in prices → unpriced by design.
    expect(resolvePrice('openai_api', 'gpt-5', null)).toBeNull();
    expect(resolvePrice('ollama', 'llama3', null)).toBeNull();
  });

  it('returns null for a model/provider that collides with a prototype name (no inherited-fn leak)', () => {
    // `model`/`provider` are operator-supplied config; an `Object.prototype`
    // property name must NOT resolve to the inherited function (which would mint
    // a bogus `{inUnitPrice:undefined}` price → NaN costEstimate → a throwing
    // append). Own-property lookup keeps these unpriced.
    for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(resolvePrice('anthropic_api', name, null)).toBeNull();
      expect(resolvePrice(name, 'claude-opus-4-8', null)).toBeNull();
      // Also on the override path.
      const override: ConnectionPriceTable = {
        models: { 'claude-opus-4-8': { inUnitPrice: 1, outUnitPrice: 1 } },
      };
      expect(resolvePrice('anthropic_api', name, override)).toBeNull();
    }
  });

  it('applies a per-connection override and labels its provenance', () => {
    const override: ConnectionPriceTable = {
      version: 'acme-negotiated-v2',
      models: { 'gpt-5': { inUnitPrice: 2, outUnitPrice: 8 } },
    };
    expect(resolvePrice('openai_api', 'gpt-5', override)).toEqual({
      inUnitPrice: 2,
      outUnitPrice: 8,
      priceTableVersion: 'acme-negotiated-v2',
    });
  });

  it('defaults override provenance to "connection-override" when unversioned', () => {
    const override: ConnectionPriceTable = {
      models: { 'gpt-5': { inUnitPrice: 2, outUnitPrice: 8 } },
    };
    expect(resolvePrice('openai_api', 'gpt-5', override)?.priceTableVersion).toBe(
      'connection-override',
    );
  });

  it('lets a per-connection override WIN over the built-in table', () => {
    const override: ConnectionPriceTable = {
      version: 'corrected',
      models: { 'claude-opus-4-8': { inUnitPrice: 4, outUnitPrice: 20 } },
    };
    expect(resolvePrice('anthropic_api', 'claude-opus-4-8', override)).toEqual({
      inUnitPrice: 4,
      outUnitPrice: 20,
      priceTableVersion: 'corrected',
    });
  });

  it('falls through to the built-in table for a model the override does not cover', () => {
    const override: ConnectionPriceTable = {
      version: 'partial',
      models: { 'claude-opus-4-7': { inUnitPrice: 4, outUnitPrice: 20 } },
    };
    expect(resolvePrice('anthropic_api', 'claude-opus-4-8', override)?.priceTableVersion).toBe(
      BUILTIN_PRICE_TABLE_VERSION,
    );
  });
});

describe('#2 L5 — computeCostEstimate', () => {
  it('computes tokens × unit price, unit = 1,000,000 tokens', () => {
    // 1,000,000 in @ $5/Mtok + 500,000 out @ $25/Mtok = $5 + $12.5 = $17.5
    expect(
      computeCostEstimate(1_000_000, 500_000, { inUnitPrice: 5, outUnitPrice: 25 }),
    ).toBeCloseTo(17.5, 10);
  });

  it('produces raw sub-cent floats without rounding (L6 owns display)', () => {
    // 1200 in @ $3/Mtok + 340 out @ $15/Mtok
    const cost = computeCostEstimate(1200, 340, { inUnitPrice: 3, outUnitPrice: 15 });
    expect(cost).toBeCloseTo((1200 * 3 + 340 * 15) / 1_000_000, 12);
    expect(cost).toBeLessThan(0.01);
  });

  it('is zero only when a real zero unit price is supplied (never manufactured)', () => {
    expect(computeCostEstimate(100, 100, { inUnitPrice: 0, outUnitPrice: 0 })).toBe(0);
  });
});

describe('#2 L5 — parseConnectionPriceTable (fail-safe)', () => {
  it('returns null when the connection config has no priceTable', () => {
    expect(parseConnectionPriceTable({})).toBeNull();
    expect(parseConnectionPriceTable({ model: 'claude-opus-4-8' })).toBeNull();
  });

  it('parses a well-formed override', () => {
    const config = {
      priceTable: {
        version: 'v1',
        models: { 'gpt-5': { inUnitPrice: 2, outUnitPrice: 8 } },
      },
    };
    expect(parseConnectionPriceTable(config)).toEqual({
      version: 'v1',
      models: { 'gpt-5': { inUnitPrice: 2, outUnitPrice: 8 } },
    });
  });

  it('returns null (fall back to built-in, never fail the node) on a malformed override', () => {
    // Missing `models`.
    expect(parseConnectionPriceTable({ priceTable: { version: 'x' } })).toBeNull();
    // Negative price rejected by the schema.
    expect(
      parseConnectionPriceTable({
        priceTable: { models: { 'gpt-5': { inUnitPrice: -1, outUnitPrice: 8 } } },
      }),
    ).toBeNull();
    // Wrong shape entirely.
    expect(parseConnectionPriceTable({ priceTable: 'not-an-object' })).toBeNull();
  });
});

describe('#2 L5 — built-in table integrity', () => {
  it('carries only authoritatively-priced Anthropic models (openai/ollama absent)', () => {
    expect(BUILTIN_PRICES.anthropic_api).toBeDefined();
    expect(BUILTIN_PRICES.openai_api).toBeUndefined();
    expect(BUILTIN_PRICES.ollama).toBeUndefined();
  });

  it('every built-in entry validates against the override model-price shape', () => {
    // The override entry schema is the same {inUnitPrice,outUnitPrice} shape; a
    // built-in row that failed it would be a unit/typo bug.
    for (const price of Object.values(BUILTIN_PRICES.anthropic_api ?? {})) {
      expect(ModelUnitPriceSchema.safeParse(price).success).toBe(true);
    }
  });
});
