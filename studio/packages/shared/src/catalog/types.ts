import type { z } from 'zod';
import type { ConnectionKind } from '../schemas/connection.js';
import type { Output } from '../schemas/pipeline.js';

/**
 * How an activity RUNS — the framework's central dispatch discriminant (#1 D6).
 *
 *  - `execution` — **connector-dispatched**: the driver hands it to a connector
 *    adapter over a Connection (I/O, `idempotent`, policy retry/timeout).
 *  - `control` — **engine-evaluated**: a pure reducer transition with no
 *    connector and no I/O (`if`/`switch`/`wait`/`set_variable`, spec #4). It
 *    still carries security metadata — control activities handle values too.
 *
 * NOTE the mechanism by which the REDUCER learns a node is control is NOT
 * settled by a spec and is NOT decided here: #4's A1/A2 may read this `kind`
 * (which needs the catalog injected into `createEngine`) or use a structural
 * config discriminant — the precedent being `call_pipeline`, which is already
 * engine-evaluated via `Node.call` and is not catalogued at all (A9 surfaces
 * it). This field is the contract #1 D6 mandates either way.
 */
export type ActivityKind = 'execution' | 'control';

/**
 * The authoring-palette group (#1 D6; the UI epic's U5 renders a "searchable,
 * categorized palette"). Ordered — the palette groups render in this order.
 *
 * Values are grounded in spec #4's own catalog headings ("Execution — general /
 * IO", "Execution — AI") and cover only what ships today; #4 adds `control` and
 * `data` with the first activity that needs them. Extending is free: a category
 * is code-side metadata and is never persisted in a doc, so no older export can
 * carry a value this build does not know.
 */
export const ACTIVITY_CATEGORIES = ['general', 'ai', 'control'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/**
 * The `Node.type` of the `if` control activity (#4 A1). A named constant, not a
 * magic string, because it is a TYPED identifier read structurally in THREE
 * places that must agree: the reducer's control-dispatch discriminant
 * (`reduce.ts` — how the engine learns a node is `if`, the `call_pipeline`/
 * `Node.call` precedent the D6 note sanctions), the save-time branch/condition
 * rule (`validateDoc`), and this catalog entry. A rename must reach all three,
 * so the string lives once.
 */
export const IF_ACTIVITY_TYPE = 'if';

/**
 * The two business branch labels an `if` emits (#4 A1). Typed identifiers, not
 * magic strings: the reducer STAMPS one of these onto `condition.evaluated`
 * (`out ? IF_BRANCH_TRUE : IF_BRANCH_FALSE`), `validateDoc`'s declared-branch
 * rule accepts EXACTLY these on an `if`'s outgoing branch edges, and an author's
 * `BranchEdge.branch` must equal one — three sites that must agree on the exact
 * string, so it lives once.
 */
export const IF_BRANCH_TRUE = 'true';
export const IF_BRANCH_FALSE = 'false';

/**
 * P3 — the ACTIVITY CATALOG entry: the static, pure metadata for one activity
 * `type` (the `type` on a pipeline `Node`). Lives in `shared` (no I/O) so the
 * SAME entry drives:
 *  - the executor's dispatch decision — `idempotent` becomes the PERSISTED
 *    `node.dispatched.idempotent` flag the boot reconciler reads (never
 *    recomputed), and `connectionKinds` gates which Connection a node may bind;
 *  - the web authoring UI (P5) — `title`, `configSchema`, `outputs` describe
 *    the node's settings form and the outputs it can produce.
 *
 * `outputs` here is CANONICAL METADATA (what this activity type produces), NOT
 * the run-time SSOT for a specific node's stored outputs — that remains the
 * node's own `config.outputs` (see `engine/outputs.ts`), which the reducer
 * stores/validates and static `validateRefs` name-checks. The catalog `outputs`
 * is the template the UI seeds a node's `config.outputs` from.
 */
export interface ActivityCatalogEntry {
  /** The `Node.type` this entry describes (unique key in the catalog). */
  type: string;
  /** Human label for the authoring UI. */
  title: string;
  /**
   * Connector-dispatched vs engine-evaluated. See `ActivityKind` — the field
   * #1 D6 makes the framework's SSOT for which dispatch path an activity takes,
   * so no consumer has to infer it from a proxy like "declares no connection".
   */
  kind: ActivityKind;
  /** Authoring-palette group (U5). See `ACTIVITY_CATEGORIES`. */
  category: ActivityCategory;
  /**
   * Whether re-running this activity is SAFE after a crash (no double side
   * effect). Persisted verbatim into `node.dispatched.idempotent`; the boot
   * reconciler resumes an idempotent in-flight node and FREEZES a
   * non-idempotent one. MUST be a static constant per type — the crash-safety
   * invariant depends on it never varying at run time. Fail-safe default is
   * `false` (unknown safety ⇒ treat as unsafe).
   */
  idempotent: boolean;
  /**
   * The Connection kinds this activity can bind. `[]` means it needs NO
   * connection (a self-contained activity). A non-empty list REQUIRES the node
   * to carry a `connectionId` whose Connection's `kind` is in the list — the
   * executor fails the node loudly otherwise.
   */
  connectionKinds: ConnectionKind[];
  /** Canonical outputs (UI/metadata). See the class doc — not the runtime SSOT. */
  outputs: Output[];
  /** Zod schema for this activity's non-secret config settings blob. */
  configSchema: z.ZodType;
  /**
   * Config field NAMES at which a `{ "$secret": "<name>" }` marker is permitted
   * — a secret SINK (item 7 / S2, #1 F15). A marker is allowed only within the
   * subtree of a declared sink field (its first `config` path segment must be
   * one of these); `validateRefs` refuses a marker anywhere else. `undefined` =
   * no sinks (every activity today, fail-CLOSED: no stored version can hold a
   * marker until a consumer — `http_request`, S4 — declares one).
   */
  secretSinkFields?: readonly string[];
  // D6's remaining fields (`inputs`, `supportsPolicy`, `retryableFailureKinds`,
  // `timeoutScope`, `errorMap`, `secureOutputFields`, `supportsCancel`) are
  // deliberately NOT declared yet: each is sequencing behind a named owner
  // (F2a/F2b/F3/F4/F9b-d — `secretSinkFields` above is F15's input sink, now
  // declared; F4's `secureOutputFields` output/redaction slot is still pending),
  // not an open question. Spec #1's F9a block under D6 is the SSOT for why — it
  // is not restated here, so the ticket that fills a field prunes ONE list, not
  // two.
}

/**
 * The activity catalog: a read-only registry keyed by activity `type`.
 *
 * NB adding a new activity TYPE (as #4 does) needs a `CATALOG_VERSION` bump
 * (`schemas/version.ts`) so an older build refuses a doc it cannot run; adding
 * metadata FIELDS to existing entries — as F9a does — does not, since no export
 * carries them. The load-bearing test is "does an EXPORT now carry an artifact
 * an older build would mis-run": F9a's fields (`false`/`[]` defaults) do not, so
 * no bump; but S4 POPULATING `secretSinkFields: ['secretHeaders']` on
 * `http_request` opens a sink an author can mark, so an export can now carry a
 * `{$secret}` marker only a sink-declaring catalog resolves — an older build
 * would drop the secret header silently. That DID bump `CATALOG_VERSION` (1→2),
 * the escape clause of this rule firing, not a violation of it.
 */
export type ActivityCatalog = ReadonlyMap<string, ActivityCatalogEntry>;

/**
 * The spec's noun for a catalog entry (#1 D6 "ActivityDefinition"). The entry
 * IS the definition — this alias exists so a ticket reading D6 can use the
 * spec's name without a rename churning every consumer.
 */
export type ActivityDefinition = ActivityCatalogEntry;
