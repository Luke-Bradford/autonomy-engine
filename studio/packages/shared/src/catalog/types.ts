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
 * The `Node.type` of the `llm_call` execution activity (#2 L-series). A named
 * constant, not a magic string, because — like the control types below — it is a
 * TYPED identifier read structurally in agreeing places: the catalog entry
 * (`registry.ts`), the L4a save-time structured-output rule (`validateDoc`), and
 * the L4a lowering pass (`catalog/lower.ts`) that derives a structured node's
 * `config.outputs` from its `outputSchema`. A rename must reach all of them, so
 * the string lives once. (Pre-L4a it was an incidental literal in `registry.ts`
 * only; L4a's second and third readers are what make the SSOT constant earn its
 * keep.)
 */
export const LLM_CALL_ACTIVITY_TYPE = 'llm_call';

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
 * The `Node.type` of the `switch` control activity (#4 A2). Same constant-SSOT
 * rationale as `IF_ACTIVITY_TYPE`: a typed identifier read STRUCTURALLY in the
 * same three sites that must agree — the reducer's control-dispatch discriminant
 * (`reduce.ts`, the `if`/`call_pipeline` precedent), the save-time branch/`on`
 * rule (`validateDoc`), and this catalog entry.
 */
export const SWITCH_ACTIVITY_TYPE = 'switch';

/**
 * The fallthrough branch a `switch` routes to when its `on` value matches NO
 * declared case (#4 A2). A typed identifier, not a magic string: the reducer
 * STAMPS it onto `switch.evaluated` when no case matches, `validateDoc`'s
 * declared-branch rule accepts it on a `switch`'s outgoing branch edges
 * (alongside the configured case labels), and it is refused as a case label
 * (a case named `'default'` would collide with the fallthrough) — three sites
 * that must agree on the exact string, so it lives once.
 */
export const SWITCH_DEFAULT_BRANCH = 'default';

/**
 * The `Node.type` of the `fail` control activity (#4 A7). Same constant-SSOT
 * rationale as `IF_ACTIVITY_TYPE`/`SWITCH_ACTIVITY_TYPE`: a typed identifier read
 * STRUCTURALLY in the sites that must agree — the reducer's control-dispatch
 * discriminant (`reduce.ts`, the `if`/`switch`/`call_pipeline` precedent), the
 * save-time config rule (`validateDoc`'s `validateFailConfig`), and this catalog
 * entry. Unlike `if`/`switch`, a `fail` produces a FAILURE (`node.failed`), not a
 * branch — so it declares NO branch labels (a branch edge off a `fail` is
 * correctly invalid) and has NO outputs.
 */
export const FAIL_ACTIVITY_TYPE = 'fail';

/**
 * The `Node.type` of the `filter` control activity (#4 A8). Same constant-SSOT
 * rationale as the other control types: a typed identifier read STRUCTURALLY by
 * the reducer's control-dispatch discriminant (`reduce.ts`), the save-time config
 * rule (`validateDoc`'s `validateFilterConfig` + `validateRefs`' composed-expr
 * scan), and this catalog entry. Unlike `if`/`switch` (a branch) and `fail` (a
 * failure), a `filter` produces a normal SUCCESS with an OUTPUT — the input array
 * filtered by a whole-value `${}` predicate — so it declares a `result` output and
 * NO branch labels (a branch edge off a `filter` is correctly invalid).
 */
export const FILTER_ACTIVITY_TYPE = 'filter';

/**
 * The `Node.type` of the `wait` control activity (#4 A6). Same constant-SSOT
 * rationale as the other control types: a typed identifier read STRUCTURALLY by
 * the reducer's control-dispatch discriminant (`reduce.ts`), the save-time config
 * rule (`validateDoc`'s `validateWaitConfig`), and this catalog entry. UNLIKE the
 * synchronous control activities (`if`/`switch`/`fail`/`filter`), a `wait` is
 * DURABLE — it parks the node `wait_pending` on S1's alarm (A5) until a `timer.due`
 * fires, then SUCCEEDS with no output. It is the first control activity that both
 * routes structurally AND consumes the durable-alarm machinery.
 */
export const WAIT_ACTIVITY_TYPE = 'wait';

/**
 * The `Node.type` of the `webhook` external-wait control activity (#4 A13). Read
 * STRUCTURALLY by the reducer's control-dispatch discriminant (`reduce.ts`), the
 * save-time config rule (`validateDoc`'s `validateWebhookConfig`), and this catalog
 * entry — the same constant-SSOT rationale as `wait`.
 *
 * The DURABLE twin of `wait`, but a DIFFERENT suspend/resume source: where a `wait`
 * parks `wait_pending` on S1's alarm and resumes when a `timer.due` fires, a
 * `webhook` parks `external_wait_pending` until an inbound, correlated + authed +
 * replay-protected HTTP callback appends `externalWait.completed` (or a timeout
 * alarm appends `externalWait.expired`, folding the node to `failure` so its
 * `failure` edge is the timeout/default path).
 *
 * #4 A16 (inbound half, LANDED) — the callback body is now a TYPED output: it is
 * validated at the HTTP boundary (`checkInboundOutputs`) against the webhook's
 * declared generic-F13 `config.outputs` contract, and the declared-key-filtered
 * payload rides `externalWait.completed.outputs` so `${nodes.w.output.decision}`
 * type-checks and resolves downstream. A webhook that declares no outputs still
 * succeeds with `{}` (the A13 empty-outputs behaviour). The OUTBOUND half —
 * injecting a `callBackUri` + correlation token into an outbound trigger — remains
 * DEFERRED (it would need this `kind:'control'` node to do outbound HTTP I/O,
 * against the #1 D6 no-connector-I/O invariant; the callback URL is already
 * retrievable via `GET /api/runs/:id/external-waits`). Its config rides
 * `Node.config` (a `${}` `timeoutSeconds` + optional `outputs`), NOT `Node.call`,
 * so it is NOT a structural-call and is generically authorable (no palette
 * exclusion).
 */
export const WEBHOOK_ACTIVITY_TYPE = 'webhook';

/**
 * The `Node.type` of the `execute_pipeline` control activity (#4 A9). UNLIKE
 * every other catalogued type, `execute_pipeline` is NOT a new mechanism — it
 * SURFACES the pre-existing structural `call_pipeline` (P2c): the reducer routes
 * a call node by the presence of `Node.call` (`reduce.ts`), never by this type
 * string, so an older build (which lacks this catalog entry) still routes an
 * `{type:'execute_pipeline', call}` node IDENTICALLY. That is why cataloguing it
 * does NOT bump `CATALOG_VERSION` (see `schemas/version.ts`) — it is the sole
 * exception to the "a new TYPE bumps" rule the other control types obey.
 *
 * A first-class TYPE gains it: a catalog entry (palette metadata + the
 * executor's `CONTROL_NOT_DISPATCHABLE` guard for a mis-authored call-less node)
 * and a save-time rule (`validateDoc`: an `execute_pipeline` MUST carry a
 * `Node.call`). Its settings live in `Node.call`, NOT `Node.config` — the
 * `isStructuralCallActivity` exception the generic palette/inspector excludes
 * (call-node authoring is #425).
 */
export const EXECUTE_PIPELINE_ACTIVITY_TYPE = 'execute_pipeline';

/**
 * The `Node.type`s of the `file_read` / `file_write` EXECUTION activities (#4
 * A11) — the first non-http/LLM connector (`fs`). Named constants, not magic
 * strings, because they are TYPED identifiers read in two agreeing places: the
 * catalog entries here, and the server `fs` adapter's dispatch branch
 * (`connectors/fs.ts`) — the `fs` connector is the FIRST to serve MORE THAN ONE
 * activity type through ONE adapter (the registry is keyed by connection KIND,
 * so the adapter must select the operation by `ctx.activityType`). A rename must
 * reach both sites, so each string lives once. UNLIKE the control types above,
 * these are `kind:'execution'` (connector-dispatched I/O), so cataloguing them
 * bumps `CATALOG_VERSION` (an older build lacks the type AND the `fs` connection
 * kind — it would fail `UNKNOWN_ACTIVITY`).
 */
export const FILE_READ_ACTIVITY_TYPE = 'file_read';
export const FILE_WRITE_ACTIVITY_TYPE = 'file_write';

/**
 * The `Node.type`s of the four remaining file EXECUTION activities (#4 A12) —
 * `file_copy` / `file_move` / `file_delete` / `file_list`. Same `fs` connector as
 * the A11 read/write pair, dispatched by `ctx.activityType` through the ONE
 * adapter (`connectors/fs.ts`), so — like `FILE_{READ,WRITE}_ACTIVITY_TYPE` —
 * each string is a TYPED identifier read in two agreeing places (catalog entry +
 * adapter branch) and lives once. All four are `kind:'execution'` runnable TYPES
 * routed BY TYPE at the executor (an older build lacks the entry → `UNKNOWN_
 * ACTIVITY`), so cataloguing them bumps `CATALOG_VERSION` (the A11 rule again).
 */
export const FILE_COPY_ACTIVITY_TYPE = 'file_copy';
export const FILE_MOVE_ACTIVITY_TYPE = 'file_move';
export const FILE_DELETE_ACTIVITY_TYPE = 'file_delete';
export const FILE_LIST_ACTIVITY_TYPE = 'file_list';

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
