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

export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * An activity instance on the canvas. `type` names an entry in the Activity
 * Catalog (validated against the catalog elsewhere — this schema only checks
 * shape, not that `type` is a currently-known catalog entry, since an
 * imported pipeline authored on an older catalog must still *parse*; the
 * upgrade/validate pass is a separate concern). `config` is the typed
 * activity settings blob for that `type`.
 */
export const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  connectionId: z.string().min(1).optional(),
  position: PositionSchema,
});
export type Node = z.infer<typeof NodeSchema>;

export const EdgeOnSchema = z.enum(['success', 'failure', 'completion']);
export type EdgeOn = z.infer<typeof EdgeOnSchema>;

export const EdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  on: EdgeOnSchema,
  /** Traversal-only back-edge (loop), enforced against `maxBounces`. */
  back: z.boolean().optional(),
  maxBounces: z.number().int().nonnegative().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

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
});
export type NewPipelineVersion = z.input<typeof NewPipelineVersionSchema>;
