import { z } from 'zod';
import { GlobalParamTypeSchema, type GlobalParamType } from './pipeline.js';
import { globalParamNameDefect, globalParamValueDefects } from '../engine/params.js';

/**
 * #844 GL1 — a workspace GLOBAL PARAMETER: an owner-scoped, mutable
 * `{ name, type, value }` that every pipeline of that owner will read as
 * `${global.<name>}` (GL3). Spec: `studio/docs/2026-09-27-foundation-global-params.md`
 * GL-D1. Cleartext configuration by design (GL-D5) — it lands in run logs,
 * exports and git, so it never holds a credential.
 *
 * Three schemas, deliberately separate:
 *  - `GlobalParamSchema` is the ROW. It decodes SHAPE only. The name and value
 *    rules are write rules, and checking them on read would make a row written
 *    under older rules undecodable, so it could be neither listed nor deleted
 *    (`DELETE` reads the row to owner-check it). It stays a plain object so
 *    `.pick`/`.partial` keep working (Zod refuses both on a refined object).
 *  - `GlobalParamCreateBodySchema` / `GlobalParamPatchBodySchema` are the
 *    WRITE boundary, and carry the rules.
 */
export const MAX_GLOBAL_PARAM_NAME_LEN = 128;
export const MAX_GLOBAL_PARAM_DESCRIPTION_LEN = 2000;

export const GlobalParamSchema = z.object({
  id: z.string().min(1),
  /** NEVER null, unlike the other resource tables: SQLite treats NULLs as
   * distinct, so a nullable owner would let the `(owner_id, name)` unique index
   * admit duplicate names (GL-D1). */
  ownerId: z.string().min(1),
  name: z.string().min(1),
  type: GlobalParamTypeSchema,
  value: z.unknown(),
  description: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type GlobalParam = z.infer<typeof GlobalParamSchema>;

/** The repo's INSERT shape: the row minus its server-minted id and stamps. */
export const NewGlobalParamSchema = GlobalParamSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type NewGlobalParam = z.infer<typeof NewGlobalParamSchema>;

/** Adds `globalParamValueDefects` as issues on the `value` path, so a form can
 * mark the field. The ONE bridge from the rule to Zod, for create and patch. */
function refineValue(type: GlobalParamType, value: unknown, ctx: z.RefinementCtx): void {
  for (const message of globalParamValueDefects(type, value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message });
  }
}

/**
 * `POST /api/global-params`. `value` is required (a JSON `null` is a value, and
 * legal for a `json` global); `description` defaults to empty. `.strict()` so an
 * unknown key is a loud 400, not a silent drop.
 */
export const GlobalParamCreateBodySchema = z
  .object({
    name: z.string().max(MAX_GLOBAL_PARAM_NAME_LEN),
    type: GlobalParamTypeSchema,
    value: z.unknown(),
    description: z.string().max(MAX_GLOBAL_PARAM_DESCRIPTION_LEN).default(''),
  })
  .strict()
  .superRefine((body, ctx) => {
    const name = globalParamNameDefect(body.name);
    if (name !== null) ctx.addIssue({ code: 'custom', path: ['name'], message: name });
    refineValue(body.type, body.value, ctx);
  });
export type GlobalParamCreateBody = z.infer<typeof GlobalParamCreateBodySchema>;

/**
 * `PATCH /api/global-params/:id` — `value` and `description` only. `name` and
 * `type` are IMMUTABLE (GL-D1): a pipeline version is immutable and types its
 * `${global.<name>}` reads at save, so a rename or retype in place would
 * silently change what an already-saved version means. `.strict()` refuses
 * either key with a 400; a rename is delete + create. The value's type rule
 * needs the STORED type, so the route applies it via `GlobalParamValueSchema`.
 */
export const GlobalParamPatchBodySchema = z
  .object({
    value: z.unknown().optional(),
    description: z.string().max(MAX_GLOBAL_PARAM_DESCRIPTION_LEN).optional(),
  })
  .strict();
export type GlobalParamPatchBody = z.infer<typeof GlobalParamPatchBodySchema>;

/** A value checked against a GIVEN type — the patch path, where the type is the
 * stored row's. A `ZodError`, so create and patch refuse in one error shape. */
export const GlobalParamValueSchema = z
  .object({ type: GlobalParamTypeSchema, value: z.unknown() })
  .superRefine((v, ctx) => refineValue(v.type, v.value, ctx));
