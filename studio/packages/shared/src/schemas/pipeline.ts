import { z } from 'zod';
import { CATALOG_VERSION } from './version.js';

/**
 * The value-type vocabulary shared by declared pipeline `params` and
 * `outputs` (typed params/outputs — validated at edit time + run start,
 * unknown keys refused, per the target architecture's mined param-language
 * semantics).
 */
// `secret` names a param whose value is a credential LABEL, never substituted:
// the `${}` engine STRIPS secret params from every substitution context and
// `validateRefs` refuses a `${params.<secret>}` ref anywhere. Its value resolves
// only executor-side at the env sink (see `engine/params.ts`).
export const ParamTypeSchema = z.enum(['string', 'number', 'boolean', 'json', 'secret']);
export type ParamType = z.infer<typeof ParamTypeSchema>;

export const ParamSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  required: z.boolean(),
  /** Only meaningful when `required` is false; omitted entirely otherwise. */
  default: z.unknown().optional(),
  description: z.string().optional(),
});
export type Param = z.infer<typeof ParamSchema>;

// Outputs get their OWN type vocabulary: every `ParamType` EXCEPT `secret`. An
// output flows raw into `ctx.nodeOutputs` and on into downstream `${}`
// substitution — unlike params, outputs are never stripped — so a
// secret-typed output would be a live credential-leak channel. `secret` names
// a param-only concept (a credential LABEL); it is nonsensical as a produced
// value.
export const OutputTypeSchema = ParamTypeSchema.exclude(['secret']);
export type OutputType = z.infer<typeof OutputTypeSchema>;

export const OutputSchema = z.object({
  name: z.string().min(1),
  type: OutputTypeSchema,
  description: z.string().optional(),
  // #594 — an OPTIONAL declared output MAY be produced as a present `null` (or
  // omitted by the executor and normalized to present-null by `storeOutputs`)
  // instead of a required present-non-null value. ABSENT = required, which is
  // load-bearing: every pre-#594 lowered row AND every non-structured node keeps
  // the all-required floor, so the immutable-version fold is unchanged (no old
  // logged `node.succeeded` re-folds differently). Today only #2 structured
  // `llm_call` lowering (`lowerOutputSchema`) sets it — from an EXPLICIT partial
  // `required` list that omits the property. Since `OutputSchema` is the ONE
  // shared output contract, a hand-authored node MAY set it too; `validateOutputs`
  // / `storeOutputs` / `checkInboundOutputs` honour it uniformly (present-null).
  optional: z.boolean().optional(),
});
export type Output = z.infer<typeof OutputSchema>;

/**
 * What a NODE-level output name may be (`Node.config.outputs`, #1 F13a).
 *
 * `refRoot` (`engine/params.ts`) addresses `${nodes.<id>.output.<name>}` by
 * splitting on `.` and taking a SINGLE segment as the name — so an output named
 * `a.b` is unaddressable as itself: it silently aliases output `a` plus deep
 * field `b` (#6 E7). Constraining the name to an identifier keeps "declarable"
 * and "referenceable" the same set.
 *
 * Deliberately NOT applied to `OutputSchema` itself: that schema is shared with
 * PIPELINE-level `outputs`, which are not `${}`-addressable and are parsed on
 * the READ path (see `PipelineVersionSchema`) — tightening it there would brick
 * stored rows for a rule that does not apply to them.
 *
 * Not exported: `NodeOutputsSchema` is the seam every consumer should use, so
 * the rule has one enforcement point rather than a regex others can re-apply
 * inconsistently.
 */
const NODE_OUTPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `name` is addressable as a `${nodes.<id>.output.<name>}` reference —
 * i.e. a single identifier segment (`NODE_OUTPUT_NAME_RE`). `NodeOutputsSchema`
 * below is the primary enforcer, but this predicate is EXPORTED for one other
 * legitimate consumer: #2 L4a's `outputSchema` subset validator
 * (`catalog/llm-config.ts`), which must apply the SAME rule to a structured
 * schema's top-level PROPERTY names — those names lower into `config.outputs`, so
 * an unaddressable property (`my-field`) would derive an unaddressable output and
 * be rejected downstream by `NodeOutputsSchema` with a confusing `config.outputs`
 * error the author never wrote. Enforcing it at the schema door instead keeps
 * "declarable" and "referenceable" the same set at BOTH producers, from one
 * predicate (the SSOT reason `refuseDuplicateNames` was extracted for #458). The
 * regex itself stays unexported so the rule has exactly one spelling.
 */
export function isAddressableOutputName(name: string): boolean {
  return NODE_OUTPUT_NAME_RE.test(name);
}

/**
 * A `superRefine` body that refuses duplicate `name`s in a list of named
 * declarations. A duplicate NAME is state corruption, not a style nit: every
 * consumer indexes these lists by name and so silently COLLAPSES a duplicate
 * last-wins — `resolveRunParams`'s `byName` map (`engine/params.ts`), the
 * `declared` maps in `validateDoc`/`validateRefs`, and `storeOutputs`'s
 * `Object.fromEntries` (`engine/reduce.ts`). So `${params.x}` with two `x`s
 * resolves to whichever is LAST, and a doc reorder (a canvas save, a git
 * round-trip) can change what a pipeline MEANS with no diff to its logic.
 *
 * Extracted so node-level `config.outputs` (#1 F13a) and pipeline-level
 * `params`/`outputs` (#458) enforce ONE rule, worded consistently, from one
 * place. `label`/`scope` shape the message (e.g. `'output'`/`'within a node'`);
 * the emitted issue `path` is `[i, 'name']` so callers can prefix their own
 * field name. Applied on the WRITE path only — see `NewPipelineVersionSchema`.
 */
function refuseDuplicateNames(label: string, scope: string) {
  return (items: readonly { name: string }[], ctx: z.RefinementCtx): void => {
    const seen = new Set<string>();
    for (const [i, item] of items.entries()) {
      if (seen.has(item.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `duplicate ${label} name '${item.name}' (${label} names must be unique ${scope})`,
        });
      }
      seen.add(item.name);
    }
  };
}

/**
 * A node's `config.outputs` declaration — the SSOT for what a VALID contract
 * looks like, used by BOTH the write-path schema (`StrictNodeSchema` below,
 * which refuses a corrupt one at save) and the run-time reader
 * (`engine/outputs.ts` `outputContract`, which fails the node on a corrupt one).
 * One schema so the two can never disagree about what "valid" means.
 */
const refuseDuplicateNodeOutputNames = refuseDuplicateNames('output', 'within a node');
const NodeOutputsSchema = z.array(OutputSchema).superRefine((outputs, ctx) => {
  for (const [i, o] of outputs.entries()) {
    if (!isAddressableOutputName(o.name)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'name'],
        message:
          `output name '${o.name}' is not addressable: a \${nodes.<id>.output.<name>} ` +
          'reference takes a single identifier segment',
      });
    }
  }
  // Duplicate NAMES silently collapse last-wins in `storeOutputs`'s
  // Object.fromEntries — same rule as pipeline-level params/outputs (#458).
  refuseDuplicateNodeOutputNames(outputs, ctx);
});

/**
 * A node's `config.outputs` FIELD — `NodeOutputsSchema` plus the rule that the
 * field may be absent (`undefined` = "no contract", legal by design).
 *
 * This is the schema BOTH readers parse: `StrictNodeSchema` below (write path)
 * and `engine/outputs.ts` `outputContract` (run time). Putting the
 * absent-is-legal rule IN the schema — rather than each caller special-casing
 * `undefined` before parsing — is what keeps it a single fact. The two live in
 * different layers (`engine/` imports `schemas/`, never the reverse), so
 * without this they would be two copies of one rule that must change in
 * lockstep — the drift `engine/outputs.ts`'s SSOT rule exists to prevent.
 */
export const NodeOutputsFieldSchema = NodeOutputsSchema.optional();

export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * The `call_pipeline` config on a Node (P2c). A node carrying a `call` is a call
 * node: the engine emits `startChild` (a deterministic child run id) and holds
 * the node `waiting` until a `call.returned` event. `pipelineVersionId` may be a
 * literal id or a `${}` param/output ref resolved at dispatch time. A FAILED
 * child still returns projected `outputs` (the findings loop).
 */
export const CallConfigSchema = z.object({
  pipelineVersionId: z.string().min(1),
  /** Param overrides passed to the child run (an empty object when none). */
  params: z.record(z.string(), z.unknown()),
  wait: z.boolean().optional(),
});
export type CallConfig = z.infer<typeof CallConfigSchema>;

/**
 * Per-activity execution policy (spec #1 D4). Every knob is optional: an absent
 * `policy` means "no policy", which is legal and is the default for every node
 * authored to date.
 *
 * **This field is INERT as of F2a — it is a declared, validated, persisted knob
 * that NOTHING reads yet.** Each consumer is a named, sequenced ticket, not an
 * open question: `retry`/`retryIntervalSeconds` → F2b (reducer retry-eligibility,
 * keyed off F0's failure `kind`) + F2c (driver durable scheduling via S1's
 * `scheduled_wakeups` outbox); `timeoutSeconds` → F3. This mirrors F9a, which
 * shipped `ActivityDefinition.kind` as honest metadata with a ZERO production
 * delta rather than guessing its consumer's shape.
 *
 * `secureInput`/`secureOutput` — which spec #1 D4 lists in this object — are
 * deliberately NOT declared here; they ship with **F4**, whose ticket row owns
 * "emit-time redaction + downstream-ref rule" (see also spec #1's
 * resolved-question 2, which sequences the prohibit-first behaviour F4 builds).
 * Note the specs say F4 makes those fields TRUE; that F2a must therefore not
 * DECLARE them is this ticket's own inference, and it rests on the security
 * argument alone: a `secureOutput: true` accepted but not honoured is a fail-open
 * — the operator marks an output secret and it is still written to the event log
 * in plaintext, whereas an absent field fails loudly at save. That is why the
 * secure fields wait and the retry knobs do not: a dropped retry costs
 * availability, a dropped redaction discloses a secret.
 */

/**
 * The ceiling (whole seconds) on a retry delay — spec #1 D4 verbatim (max of the
 * 30–86400 range). The SSOT for that bound: the policy `retryIntervalSeconds`
 * schema below caps here, and so does #2 L7's provider `Retry-After` hint (its
 * `MAX_RETRY_AFTER_SECONDS` and the `node.failed`/`scheduleRetry` schema caps all
 * import this) — a provider hint feeds the SAME retry-alarm `dueAt` an author
 * interval does, so both must be bounded by ONE value, not three copies of the
 * literal that could drift ("export once, import everywhere").
 */
export const MAX_RETRY_INTERVAL_SECONDS = 86400;

export const NodePolicySchema = z.object({
  /**
   * Wall-clock budget for one attempt. F3 terminalizes an over-budget attempt
   * via `node.failed{kind:'transient', code:'timeout'}` so retry policy then
   * applies uniformly and boot-recovery can tell timed-out from crashed.
   *
   * Named `timeoutSeconds`, not the spec's bare `timeout`, so this object never
   * mixes units with the spec-verbatim `retryIntervalSeconds`.
   *
   * Unbounded above 0 HERE, on purpose: spec #1 D4 bounds only
   * `retryIntervalSeconds`, and the real semantic ceiling is F3's to set from
   * enforcement experience. A read-path range can only ever be WIDENED (see
   * `NodeSchema.policy`), so inventing one here would be a guess F3 could not
   * take back. The fat-finger guard lives on the WRITE path instead
   * (`StrictNodePolicySchema`), where a bound can move freely in either
   * direction without making a stored row unreadable.
   *
   * SEAM FOR F3 (a named question, not a discovery): connection-level
   * `config.timeoutMs` already bounds a single HTTP/LLM exchange
   * (`connectors/http.ts`, `connectors/llm-shared.ts`). Which one wins, and
   * whether this bounds the attempt or the whole node, is `timeoutScope` — the
   * field F9a explicitly declined to declare ahead of its consumer.
   */
  timeoutSeconds: z.number().int().positive().optional(),
  /**
   * Max RETRIES after the first attempt (so `retry: 2` = up to 3 attempts).
   * `0` is meaningful and is NOT the same fact as absent: `0` is the operator
   * explicitly pinning "never retry this node", absent is "policy says nothing".
   * F2b must preserve that difference once a catalog/global default exists.
   */
  retry: z.number().int().min(0).optional(),
  /**
   * Delay between attempts. Bounds are spec #1 D4 verbatim (30–86400). F2c
   * stores the computed next-attempt time as `scheduled_wakeups.dueAt` — a
   * STORED fact, never recomputed at fold time (spec #5's spike block: the
   * reducer stays clock-free and replay-stable).
   *
   * Absent means "policy says nothing", and F2c resolves that to
   * `DEFAULT_RETRY_INTERVAL_SECONDS` below.
   */
  retryIntervalSeconds: z.number().int().min(30).max(MAX_RETRY_INTERVAL_SECONDS).optional(),
});
export type NodePolicy = z.infer<typeof NodePolicySchema>;

/**
 * F2c — the delay used when a node sets `retry` but no `retryIntervalSeconds`.
 *
 * Neither spec #1 D4 nor the joint F1b/F2b spec states a default, and the two
 * knobs are independent optionals, so `{retry: 2}` with no interval is a legal
 * doc that needs an answer. `30` is the schema's own floor immediately above —
 * declared HERE, next to that `.min(30)`, precisely so the default and the floor
 * cannot drift into a default the schema itself would reject.
 *
 * It is also the conservative direction: the only other obvious reading of
 * "unspecified" is "retry immediately", which turns a transient failure into a
 * hot retry loop against a provider that is already throttling us.
 *
 * This is a v1 FALLBACK, not a policy decision: **F13b** (catalog defaults /
 * overrides) is where an activity gets to say "my sensible retry interval is
 * N". When it lands, this is the value it overrides — and, per `retry`'s note
 * above, absent must then resolve to F13b's default while an explicit value
 * still wins.
 */
export const DEFAULT_RETRY_INTERVAL_SECONDS = 30;

/**
 * `NodePolicySchema` + the rules a policy must pass to be SAVED. Applied ONLY
 * via `StrictNodeSchema` below (write path); `NodeSchema` stays read-tolerant.
 *
 * WHY `.strict()` is on the write path and not the read path: an unknown key is
 * silently STRIPPED by default, so a `{ secureOutput: true }` posted before F4
 * lands would be accepted, dropped, and the operator would believe redaction was
 * on — the whole point of the F4 deferral above. But the READ path must keep
 * stripping rather than throwing, or a row this version cannot parse is a
 * pipeline that cannot be opened in the UI to be repaired. Since every write is
 * gated here, such a row arises only from a version DOWNGRADE against an
 * existing DB (an import carrying a later studio's field is refused, not
 * stored). That is F13a's strict-on-write / tolerant-on-read asymmetry, applied
 * to a typed field.
 */
/**
 * A fat-finger guard on `timeoutSeconds`, NOT a semantic bound — F3 owns the
 * real one. One year is far past any legitimate single-attempt budget, so a
 * value above it is a typo (a stray zero, or ms passed where seconds were
 * meant), never an intent.
 *
 * WHY this is a write-path rule and not a `.max()` on `NodePolicySchema`: a
 * range on the read path can only ever be widened, so a ceiling there would be a
 * guess F3 could never take back. Here it costs F3 nothing — a write-path bound
 * can tighten or relax freely, because no stored row becomes unreadable.
 */
const TIMEOUT_SECONDS_SANITY_CEILING = 31_536_000;

const StrictNodePolicySchema = NodePolicySchema.strict().superRefine((policy, ctx) => {
  if (
    policy.timeoutSeconds !== undefined &&
    policy.timeoutSeconds > TIMEOUT_SECONDS_SANITY_CEILING
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['timeoutSeconds'],
      message:
        `timeoutSeconds ${policy.timeoutSeconds} exceeds ${TIMEOUT_SECONDS_SANITY_CEILING} ` +
        '(one year) — that is a single attempt budget, so this is almost certainly a typo ' +
        '(milliseconds passed as seconds?)',
    });
  }
  // An interval with no retry to space out is dead config the operator almost
  // certainly believes is live. Cheap to refuse at save, and no stored row can
  // carry one yet. NB: if a later ticket gives `retry` a catalog/global DEFAULT
  // (the #456/F13b shape), this rule must relax — relaxing is back-compat-safe.
  if (policy.retryIntervalSeconds !== undefined && (policy.retry ?? 0) < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['retryIntervalSeconds'],
      message:
        'retryIntervalSeconds has no effect without retry >= 1 (it spaces out retries; ' +
        'set retry, or drop the interval)',
    });
  }
});

/**
 * An activity instance on the canvas. `type` names an entry in the Activity
 * Catalog (validated against the catalog elsewhere — this schema only checks
 * shape, not that `type` is a currently-known catalog entry, since an
 * imported pipeline authored on an older catalog must still *parse*; the
 * upgrade/validate pass is a separate concern). `config` is the typed
 * activity settings blob for that `type`.
 *
 * A node carrying a `call` config is a `call_pipeline` node (P2c) — a plain
 * activity node and a call node coexist via this OPTIONAL discriminant, so
 * existing docs (no `call`) still parse unchanged.
 */
export const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  connectionId: z.string().min(1).optional(),
  position: PositionSchema,
  call: CallConfigSchema.optional(),
  /**
   * Per-activity execution policy (#1 D4/F2a) — INERT, see `NodePolicySchema`.
   *
   * Declared on the READ schema because `createPipelineVersion` spreads the
   * PARSED value into the stored row (`repo/pipeline-versions.ts`) and this is a
   * plain `z.object`, which strips unknown keys — a policy declared only on the
   * write-path `StrictNodeSchema` would never persist at all.
   *
   * Shape + ranges live here; `.strict()` + the cross-field rule are write-only
   * (`StrictNodeSchema`). A range is safe on the read path because this version
   * can already judge it — but only ever WIDEN one once rows carry policies:
   * narrowing makes a stored row unreadable, and an unreadable pipeline cannot
   * be opened to be repaired. A later narrowing belongs on `StrictNodeSchema`.
   */
  policy: NodePolicySchema.optional(),
});
export type Node = z.infer<typeof NodeSchema>;

/**
 * `NodeSchema` + the semantic checks a node must pass to be SAVED (#1 F13a).
 * Today: `config.outputs`, if present, must be a valid `NodeOutputsSchema`; and
 * `policy`, if present, must pass `StrictNodePolicySchema` (#1 F2a).
 *
 * The two are enforced by DIFFERENT mechanisms, and the difference is forced by
 * Zod, not taste. `config` is a `z.record(z.string(), z.unknown())` — an opaque
 * blob that preserves every key — so `config.outputs` is still raw when
 * `superRefine` runs, and F13a can `safeParse` it there. But `policy` is a TYPED
 * field: `NodeSchema` has already parsed it, stripping unknown keys, before any
 * `superRefine` body runs. A `.strict()` re-parse inside `superRefine` would be
 * handed the already-cleaned object and could never see the unknown key it
 * exists to refuse — it would silently pass. Re-declaring `policy` via
 * `.extend()` puts the strict schema in the PARSE itself, the only place that
 * sees raw input.
 *
 * WHY a separate schema rather than refining `NodeSchema`: `NodeSchema` is
 * parsed on the READ path too (`PipelineVersionSchema.parse(row)` runs on every
 * stored row — `repo/pipeline-versions.ts`). Refining it would make an
 * already-stored row with a corrupt contract unreadable — the pipeline could not
 * be opened in the UI to be REPAIRED, and runs bound to that version could not
 * load. That would trade a silent fail-open for an unrecoverable brick. So:
 * **strict on write, tolerant on read, fail-safe at run time** (a corrupt
 * contract fails the node — `engine/outputs.ts`), which is defence in depth
 * rather than a single schema chokepoint.
 *
 * This mirrors `NodeSchema`'s existing shape-only stance on `type` (an older
 * catalog's doc must still parse) and the backward-tolerant `containers`
 * default — the validate/upgrade pass is deliberately a separate concern.
 */
export const StrictNodeSchema = NodeSchema.extend({
  policy: StrictNodePolicySchema.optional(),
}).superRefine((node, ctx) => {
  const parsed = NodeOutputsFieldSchema.safeParse(node.config['outputs']);
  if (parsed.success) return; // valid, or absent (= no contract, legal)
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: 'custom',
      path: ['config', 'outputs', ...issue.path],
      message: issue.message,
    });
  }
});

/**
 * A predecessor's OPERATIONAL outcome — what the activity itself did. These are
 * ADF's four dependency conditions and they are deliberately distinct:
 * `completion` fires after the activity ran (success OR failure), while
 * `skipped` fires when the activity never ran at all. A skip is therefore NOT a
 * completion — it propagates until an `on:'skipped'` edge catches it.
 *
 * This enum is operational-only: business routing is the `branch` member of
 * `EdgeSchema` below, never a value here (spec #1 D5, #4 A0).
 */
export const EdgeOnSchema = z.enum(['success', 'failure', 'completion', 'skipped']);
export type EdgeOn = z.infer<typeof EdgeOnSchema>;

const edgeBase = {
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Traversal-only back-edge (loop), enforced against `maxBounces`. */
  back: z.boolean().optional(),
  /**
   * Bounce cap for a `back` edge. `validateDoc` REQUIRES one on every back-edge.
   * The engine also applies a hard ceiling (`DEFENSIVE_BOUNCE_CAP`, 10_000) and
   * CLAMPS a larger declared value down to it — a skip-only loop body runs every
   * bounce synchronously inside one `reduce()`, so an unbounded cap would block
   * the driver's event loop. Declaring more than the ceiling is not an error
   * (the doc stays savable) but is clamped, with a reducer diagnostic saying so.
   */
  maxBounces: z.number().int().nonnegative().optional(),
};

/** An edge keyed off the predecessor's operational outcome. */
export const OperationalEdgeSchema = z.object({ ...edgeBase, on: EdgeOnSchema });
export type OperationalEdge = z.infer<typeof OperationalEdgeSchema>;

/**
 * An edge keyed off a BUSINESS decision the predecessor made: `if` → `true`/
 * `false`, `switch` → a named case/`default`. The `branch` label is the routing
 * key, so it is required. A branch edge may also be a capped back-edge — a
 * 3-way switch can loop on one arm (an approval's "needs-changes" → redraft).
 *
 * The activities that EMIT a branch outcome (`if`/`switch`) are spec #4
 * A0/A1/A2; this schema is settled here (spec #1 owns the union) so they build
 * against a final shape. Until then a branch edge is INERT — it can never be
 * satisfied, `validateDoc` reports it and the write path refuses it (#444;
 * PARSE stays permissive, so a pre-gate row still round-trips), and the reducer
 * emits a diagnostic rather than stranding the downstream silently.
 */
export const BranchEdgeSchema = z.object({
  ...edgeBase,
  on: z.literal('branch'),
  branch: z.string().min(1),
});
export type BranchEdge = z.infer<typeof BranchEdgeSchema>;

/**
 * Operational outcome vs business routing, discriminated on `on`. Keeping them
 * one union (rather than an optional `branch` field) is what stops `if`/`switch`
 * overloading `success`/`failure` for routing — which would poison both
 * pipeline-success semantics and monitoring.
 */
export const EdgeSchema = z.discriminatedUnion('on', [OperationalEdgeSchema, BranchEdgeSchema]);
export type Edge = z.infer<typeof EdgeSchema>;

/**
 * A control-flow CONTAINER (P2c): a `loop`, `stage`, or `foreach` grouping child
 * nodes into a namespace with its own lifecycle. `children` are node ids (unique
 * within the container, disjoint across containers — validated at save time).
 * `exitWhen` (a `${}` boolean over child outputs, loop only) and `maxRounds` bound
 * a loop; a `stage` exits once all children are terminal; a `foreach` (#4 A4)
 * iterates its body once per element of the `items` array, binding `${item}` and
 * aggregating the order-stable `results: Array<childOutputShape>` output. `join`
 * gates the container's own readiness from its incoming OUTER edges (default
 * `all`), mirroring a node's.
 */
export const ContainerKindSchema = z.enum(['loop', 'stage', 'foreach']);
export type ContainerKind = z.infer<typeof ContainerKindSchema>;

export const ContainerSchema = z.object({
  id: z.string().min(1),
  kind: ContainerKindSchema,
  children: z.array(z.string().min(1)),
  /** `${}` boolean over child outputs; evaluated only when a round is terminal. Loop only. */
  exitWhen: z.string().optional(),
  /** Hard cap on loop rounds — reaching it without `exitWhen` caps the loop. */
  maxRounds: z.number().int().positive().optional(),
  /**
   * #4 A17 — whole-loop WALL-CLOCK bound in seconds, a durable-alarm safety net
   * ALONGSIDE the `maxRounds` count. When the timeout elapses while the loop is
   * still `active` (any round), the container FAILS with reason `timeout` and
   * fires its outer failure edge — so an `until`-loop gated on a human/external
   * event that never arrives is time-bounded, not merely round-bounded. Armed
   * ONCE at container-enter (consumes the #5 S1 alarm, like `wait`), so it caps
   * the loop's TOTAL wall-clock, not each round. Loop only (a `stage`/`foreach`
   * does not re-round, so a wall-clock bound is meaningless there — refused by
   * `validateDoc`). A STATIC number (unlike `wait`'s `${}` `seconds`): it is
   * resolved at enter, before the loop body has run, so a `${}` over child
   * outputs could not resolve anyway.
   */
  timeout: z.number().int().positive().optional(),
  /**
   * `${}` whole-value expression resolving to an ARRAY over the container's OUTER
   * scope (params/trigger/upstream outputs — NOT its own children, which have not
   * run when it is evaluated). Foreach only: the body runs once per element with
   * `${item}` bound to that element. A4a runs items SEQUENTIALLY (one per round);
   * parallel `batchCount` is deferred to A4b.
   */
  items: z.string().optional(),
  /** Readiness rule over the container's own incoming OUTER edges (default `all`). */
  join: z.enum(['all', 'any']).optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

export const PipelineSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  name: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const NewPipelineSchema = PipelineSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
// z.input, not z.infer/z.output — see the note on NewConnection in
// connection.ts for why every insert type in this package uses it.
export type NewPipeline = z.input<typeof NewPipelineSchema>;

/**
 * IMMUTABLE once written: a pipeline's graph, params, and outputs at a
 * specific `version`. Runs and triggers bind a specific version id, never
 * "latest" — there is deliberately no update path for this schema/table; a
 * new version is always a new row (see the repository layer).
 */
export const PipelineVersionSchema = z.object({
  id: z.string().min(1),
  pipelineId: z.string().min(1),
  version: z.number().int().positive(),
  params: z.array(ParamSchema),
  outputs: z.array(OutputSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  /** Control-flow containers (loop/stage). Default `[]` — backward-tolerant so
   * a pre-P2c doc with no `containers` key still parses. */
  containers: z.array(ContainerSchema).default([]),
  catalogVersion: z.number().int(),
  createdAt: z.number().int(),
});
export type PipelineVersion = z.infer<typeof PipelineVersionSchema>;

/**
 * Insert shape: server sets `id`, auto-increments `version` per `pipelineId`,
 * and stamps `createdAt`. `catalogVersion` defaults to the current
 * `CATALOG_VERSION` so callers authoring a brand-new version don't have to
 * name it explicitly (an import/upgrade path can still set an older value).
 */
export const NewPipelineVersionSchema = PipelineVersionSchema.omit({
  id: true,
  version: true,
  createdAt: true,
}).extend({
  catalogVersion: z.number().int().default(CATALOG_VERSION),
  // The WRITE path is strict (#1 F13a) — `PipelineVersionSchema` above stays
  // read-tolerant. See `StrictNodeSchema` for why the asymmetry is deliberate.
  nodes: z.array(StrictNodeSchema),
  // Duplicate pipeline-level param/output NAMES are refused on write (#458) —
  // the twin of the node-level `config.outputs` rule (F13a). Same asymmetry: the
  // read schema above stays tolerant so an already-stored duplicate-carrying row
  // (immutable, unrepairable-in-place) can still be opened in the UI to re-author.
  params: z.array(ParamSchema).superRefine(refuseDuplicateNames('param', 'within the pipeline')),
  outputs: z.array(OutputSchema).superRefine(refuseDuplicateNames('output', 'within the pipeline')),
});
export type NewPipelineVersion = z.input<typeof NewPipelineVersionSchema>;
