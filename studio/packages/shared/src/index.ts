import { z } from 'zod';

/**
 * The FE/BE contract for the `GET /api/hello` endpoint. Kept deliberately tiny
 * for the P0a skeleton: it exists only to prove that a Zod schema authored
 * once in `@autonomy-studio/shared` validates data on the server AND supplies
 * an inferred type consumed by the web client.
 */
export const HelloSchema = z.object({
  message: z.string(),
  ts: z.number(),
});

export type Hello = z.infer<typeof HelloSchema>;

// P1a data model — Connection/Pipeline+Version/Trigger/Run/RunEvent/Secret
// Zod schemas + inferred types, the single source of truth shared by
// `@autonomy-studio/server` and `@autonomy-studio/web`.
export * from './schemas/index.js';

// P1c — version-stamped JSON export/import envelope + upgrade framework.
export * from './portability/index.js';
