import { z } from 'zod';
import type { ConnectionKind } from '../schemas/connection.js';

/**
 * #2 L5 — the model price table + cost-estimate math. The SSOT for turning a
 * captured `activity.metered` usage fact (`provider`/`model`/token counts) into
 * the PRICE fields that L5 stamps ADDITIVELY onto that same event
 * (`inUnitPrice`/`outUnitPrice`/`costEstimate`/`priceTableVersion`). L6 sums the
 * stamped `costEstimate` for the run-cost projection — it does NOT re-price.
 *
 * Prices are captured AT run-time and the resolved `priceTableVersion` is
 * stamped alongside, so a future price change (a new built-in table version, or
 * an edited connection override) NEVER alters a past run's recorded cost — the
 * cost is an immutable fact, mirroring how usage is (spec #2's replay invariant).
 *
 * FAIL-CLOSED (the #473 / F13a lesson): a model with no known price resolves to
 * `null`, NOT to a zero price. An absent price must stay VISIBLE (no
 * `costEstimate` stamped) so the L6 projection can flag run-cost incompleteness
 * — a manufactured `costEstimate: 0` would silently understate spend, the exact
 * fail-open shape the merge-gate and F13a forbid.
 */

/**
 * A per-model unit price. `inUnitPrice`/`outUnitPrice` are **USD per 1,000,000
 * tokens** (a "unit" is 1M tokens — the convention every first-party provider
 * publishes). `computeCostEstimate` divides by 1e6 accordingly.
 */
export interface ModelUnitPrice {
  inUnitPrice: number;
  outUnitPrice: number;
}

/** A resolved price plus the provenance stamped into the metered event. */
export interface ResolvedPrice extends ModelUnitPrice {
  priceTableVersion: string;
}

/**
 * The built-in price table's version. PIN THIS: an immutable run stamps the
 * version it was priced against, so any change to a price value below MUST bump
 * this string (old runs keep replaying their own recorded cost). The date form
 * is a human-readable monotonic label, not a magic string — it is the single
 * source consumed by `resolvePrice`.
 */
export const BUILTIN_PRICE_TABLE_VERSION = 'builtin-2026-07-18';

/**
 * Built-in prices (USD per 1M tokens), keyed by ConnectionKind then EXACT
 * resolved model-ID string — the `claude-`-prefixed form the adapters stamp
 * into `activity.metered.model` (`anthropic.ts` `DEFAULT_MODEL` + `resolveModel`
 * pass the requested ID through verbatim). Matching is exact-string only: a
 * dated/variant ID (`claude-opus-4-8[1m]`, `…-20251001`) or a legacy-active
 * model absent below (`claude-opus-4-5`, `claude-sonnet-4-5`) goes UNPRICED by
 * design (→ `resolvePrice` returns `null` → no `costEstimate`), addable via a
 * per-connection override.
 *
 * Seeded ONLY with authoritatively-sourced Anthropic list prices (claude-api
 * skill, cached 2026-06-24). `openai_api` and `ollama` are deliberately ABSENT:
 * no authoritative unit prices were on hand, and the repo's "verify before
 * asserting" rule forbids guessing them — an unpriced provider is the honest
 * fail-closed default, addable now via the per-connection override and later via
 * a built-in table update. Sonnet-5's introductory $2/$10 (through 2026-08-31)
 * is NOT modelled — the standard $3/$15 is used, a conscious conservative
 * OVER-estimate (never understates); the version pin means it never retro-edits.
 */
export const BUILTIN_PRICES: Partial<Record<ConnectionKind, Record<string, ModelUnitPrice>>> = {
  anthropic_api: {
    'claude-opus-4-8': { inUnitPrice: 5, outUnitPrice: 25 },
    'claude-opus-4-7': { inUnitPrice: 5, outUnitPrice: 25 },
    'claude-opus-4-6': { inUnitPrice: 5, outUnitPrice: 25 },
    'claude-sonnet-5': { inUnitPrice: 3, outUnitPrice: 15 },
    'claude-sonnet-4-6': { inUnitPrice: 3, outUnitPrice: 15 },
    'claude-haiku-4-5': { inUnitPrice: 1, outUnitPrice: 5 },
    'claude-fable-5': { inUnitPrice: 10, outUnitPrice: 50 },
    'claude-mythos-5': { inUnitPrice: 10, outUnitPrice: 50 },
  },
};

/**
 * One model's unit price. Shared by the override schema AND asserted against
 * every built-in row (a built-in that failed it would be a unit/typo bug).
 */
export const ModelUnitPriceSchema = z.object({
  /** USD per 1,000,000 input tokens. */
  inUnitPrice: z.number().nonnegative(),
  /** USD per 1,000,000 output tokens. */
  outUnitPrice: z.number().nonnegative(),
});

/**
 * A per-connection price-table override, carried non-secret on the LLM
 * connection's free-form `config.priceTable`. `models` is keyed by EXACT model
 * ID (the connection already fixes the provider). Prices are **USD per 1,000,000
 * tokens**, same unit as the built-in table — an operator who enters per-1K
 * prices would over-state cost 1000× with no error (pricing never fails a node),
 * so the unit is fixed here deliberately. `version` labels the override for
 * provenance; absent → `resolvePrice` stamps `'connection-override'`.
 */
export const ConnectionPriceTableSchema = z.object({
  version: z.string().min(1).optional(),
  models: z.record(z.string().min(1), ModelUnitPriceSchema),
});
export type ConnectionPriceTable = z.infer<typeof ConnectionPriceTableSchema>;

/**
 * Resolve the unit price for one metered response. Precedence:
 *   1. a per-connection override entry for `model` (provenance = the override's
 *      `version`, or `'connection-override'`),
 *   2. the built-in table entry (provenance = `BUILTIN_PRICE_TABLE_VERSION`),
 *   3. `null` — UNPRICED. Never a zero price (fail-closed): the caller omits the
 *      price fields entirely so the absence stays visible to L6.
 * The override wins over the built-in so an operator can correct a stale/negotiated
 * rate (or price a model the built-in table omits, incl. openai/ollama).
 */
export function resolvePrice(
  provider: string,
  model: string,
  override: ConnectionPriceTable | null,
): ResolvedPrice | null {
  // `provider`/`model` come from operator-supplied config (settable via the API),
  // so both lookups MUST be own-property only: a model named `toString` /
  // `constructor` / `__proto__` would otherwise return an inherited function
  // instead of `undefined`, mint a bogus `{inUnitPrice:undefined}` price →
  // `costEstimate:NaN` → the durable append's `z.number().nonnegative()` throws,
  // failing the node — the exact invariant this module promises never to break.
  // Same prototype-name hazard `resolveConfigSecrets` guards with `Object.create(null)`.
  const overrideEntry =
    override !== null && Object.hasOwn(override.models, model) ? override.models[model] : undefined;
  if (overrideEntry !== undefined) {
    return {
      inUnitPrice: overrideEntry.inUnitPrice,
      outUnitPrice: overrideEntry.outUnitPrice,
      priceTableVersion: override?.version ?? 'connection-override',
    };
  }
  // `provider` is the metered event's Connection-kind STRING (`activity.metered`
  // stores it as `string`); the built-in table is keyed by `ConnectionKind`. An
  // unknown/prototype-named provider or model simply misses (→ `undefined` → null),
  // so the cast is a lookup convenience, not a trust boundary.
  const builtinByProvider = BUILTIN_PRICES as Record<string, Record<string, ModelUnitPrice>>;
  const providerTable = Object.hasOwn(builtinByProvider, provider)
    ? builtinByProvider[provider]
    : undefined;
  const builtinEntry =
    providerTable !== undefined && Object.hasOwn(providerTable, model)
      ? providerTable[model]
      : undefined;
  if (builtinEntry !== undefined) {
    return {
      inUnitPrice: builtinEntry.inUnitPrice,
      outUnitPrice: builtinEntry.outUnitPrice,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    };
  }
  return null;
}

/**
 * The estimated USD cost of one response: tokens × unit price, unit = 1M tokens.
 * L5 stamps this raw/unrounded — it is an immutable fact; L6's summation + Monitor
 * rollup own any display rounding, so the executor never quantizes at stamp time.
 */
export function computeCostEstimate(
  inputTokens: number,
  outputTokens: number,
  price: ModelUnitPrice,
): number {
  return (inputTokens * price.inUnitPrice + outputTokens * price.outUnitPrice) / 1_000_000;
}

/**
 * Parse a connection's `config.priceTable` override, FAIL-SAFE: an absent or
 * malformed override returns `null` (→ the built-in table is used). Pricing is
 * best-effort observability, so a mistyped override must NEVER fail the node —
 * distinct from the fail-CLOSED cost rule (a resolved-null price omits
 * `costEstimate`): here we fall back to a real built-in price, we never
 * manufacture one.
 */
export function parseConnectionPriceTable(
  config: Record<string, unknown>,
): ConnectionPriceTable | null {
  const raw = config.priceTable;
  if (raw === undefined) return null;
  const parsed = ConnectionPriceTableSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
