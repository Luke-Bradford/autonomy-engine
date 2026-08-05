import { z } from 'zod';

/**
 * RS2 — the `202` body of `POST /api/runs/:id/rerun-from-failed`: the id of the
 * NEW run (R2) the reseed created. Shared FE/BE for the reason `FireResultSchema`
 * (`fire-result.ts`) is: the server's reply is typed by this schema and the web
 * client parses with it, so the two ends cannot drift into a runtime Zod failure
 * in the browser that a build would have caught. Before #899 this shape lived in
 * `web/src/api/runs.ts` alone, checking one end of a contract with two.
 *
 * The route answers as soon as R2 is DURABLY created, not when it finishes — R2
 * drives in the background — so `runId` is a handle to navigate to, never an
 * outcome. There is no rerun-request counterpart here because a rerun takes no
 * body: R2 reuses R1's params and pinned version exactly, and a param override is
 * refused by design (the copied frontier outputs were computed under the old
 * params, so mixing them would be a silent inconsistency — override belongs to a
 * simple full rerun, F11).
 */
export const RerunAcceptedSchema = z.object({
  /** The created rerun's id (R2). */
  runId: z.string().min(1),
});
export type RerunAccepted = z.infer<typeof RerunAcceptedSchema>;
