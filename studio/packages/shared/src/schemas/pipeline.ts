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
 * A node's `config.outputs` declaration — the SSOT for what a VALID contract
 * looks like, used by BOTH the write-path schema (`StrictNodeSchema` below,
 * which refuses a corrupt one at save) and the run-time reader
 * (`engine/outputs.ts` `outputContract`, which fails the node on a corrupt one).
 * One schema so the two can never disagree about what "valid" means.
 */
const NodeOutputsSchema = z.array(OutputSchema).superRefine((outputs, ctx) => {
  const seen = new Set<string>();
  for (const [i, o] of outputs.entries()) {
    if (!NODE_OUTPUT_NAME_RE.test(o.name)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'name'],
        message:
          `output name '${o.name}' is not addressable: a \${nodes.<id>.output.<name>} ` +
          'reference takes a single identifier segment',
      });
    }
    // `storeOutputs` (engine/reduce.ts) builds the stored record with
    // Object.fromEntries(decl.map(...)) — duplicate names silently collapse
    // last-wins, so a duplicate is state corruption, not a style nit.
    if (seen.has(o.name)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'name'],
        message: `duplicate output name '${o.name}' (output names must be unique within a node)`,
      });
    }
    seen.add(o.name);
  }
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
});
export type Node = z.infer<typeof NodeSchema>;

/**
 * `NodeSchema` + the semantic checks a node must pass to be SAVED (#1 F13a).
 * Today: `config.outputs`, if present, must be a valid `NodeOutputsSchema`.
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
export const StrictNodeSchema = NodeSchema.superRefine((node, ctx) => {
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
 * satisfied, `validateDoc` reports it (advisory only — see #444), and the
 * reducer emits a diagnostic rather than stranding the downstream silently.
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
 * A control-flow CONTAINER (P2c): a `loop` or `stage` grouping child nodes into
 * a namespace with its own lifecycle. `children` are node ids (unique within the
 * container, disjoint across containers — validated at save time). `exitWhen` (a
 * `${}` boolean over child outputs, loop only) and `maxRounds` bound a loop; a
 * `stage` exits once all children are terminal. `join` gates the container's own
 * readiness from its incoming OUTER edges (default `all`), mirroring a node's.
 */
export const ContainerKindSchema = z.enum(['loop', 'stage']);
export type ContainerKind = z.infer<typeof ContainerKindSchema>;

export const ContainerSchema = z.object({
  id: z.string().min(1),
  kind: ContainerKindSchema,
  children: z.array(z.string().min(1)),
  /** `${}` boolean over child outputs; evaluated only when a round is terminal. Loop only. */
  exitWhen: z.string().optional(),
  /** Hard cap on loop rounds — reaching it without `exitWhen` caps the loop. */
  maxRounds: z.number().int().positive().optional(),
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
});
export type NewPipelineVersion = z.input<typeof NewPipelineVersionSchema>;
