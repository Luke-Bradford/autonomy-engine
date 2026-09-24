import { z } from 'zod';
import { ConnectionKindSchema } from './connection.js';

/**
 * #1211 — the connection→dependent-triggers REVERSE read behind
 * `GET /api/connections/:id/dependents`.
 *
 * WHY A SERVER ROUTE AT ALL. The ticket assumed there would not need to be one:
 * "`GET /api/triggers` carries the binding, so the count itself is cheap". That
 * is false, and it is the one premise the whole design rests on. A trigger row
 * carries `pipelineVersionId` and nothing connection-shaped (`TriggerSchema`);
 * the dependency link lives INSIDE the bound version's node JSON, which
 * `run/connection-readiness.ts` states outright — "there is no cheap
 * reverse-join: every enabled trigger's bound version is scanned." So this is
 * the same shape as M9's `GET /api/datasets/:id/references`, which needed a
 * route for exactly the same reason: the edge crosses pipeline VERSIONS and
 * cannot be answered from rows the client holds. #1174's dataset half genuinely
 * could be answered client-side (`GET /api/datasets` carries `connectionId`);
 * this half cannot.
 *
 * WHAT IT ANSWERS. Which of the caller's enabled triggers `regateTriggersForConnection`
 * would DISABLE if this connection stopped being ready — the state change a
 * `kind` PATCH and a DELETE both perform today without saying so. It REFUSES
 * NOTHING and gates nothing: the enable gate (G8b-1), the dispatch gate (G8a)
 * and the reverse gate (G8b-2) are unchanged and remain the only refusals.
 */

/** A trigger that a now-unready connection would switch off. */
export const DependentTriggerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type DependentTrigger = z.infer<typeof DependentTriggerSchema>;

/**
 * A trigger whose bound version reaches connections through a `${}` EXPRESSION,
 * so whether it depends on this connection is only knowable at dispatch.
 *
 * THE SECOND BUCKET IS THE POINT, and it is the same refusal M9 makes
 * (`DatasetDynamicReferenceSchema`: dropping a dynamic reference "would let the
 * page answer 'nothing references this' confidently and wrongly"). The readiness
 * scan SKIPS a `${}`-dynamic `connectionId` — correct there, because such a ref
 * cannot be statically resolved and so is never DISABLED by the reverse gate.
 * But a surface that inherited that skip silently would render an earned-looking
 * "no triggers would be disabled" over a trigger that may well address this very
 * connection. So the skip is REPORTED rather than swallowed, and the advisory is
 * never allowed to claim "none" while this array is non-empty — prevention-log
 * #18, the healthy verdict must be earned.
 */
export const DynamicDependentTriggerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Every node of this trigger's version whose connection reference is an expression. */
  nodeIds: z.array(z.string().min(1)).min(1),
});
export type DynamicDependentTrigger = z.infer<typeof DynamicDependentTriggerSchema>;

/**
 * #1252 — a pipeline NODE that names this connection outright.
 *
 * THE OTHER HALF OF "WHAT THIS EDIT BREAKS", and the worse silence of the two.
 * Kind-validity is deliberately outside readiness (`run/connection-readiness.ts`),
 * so a `kind` change that keeps the connection ready — `postgres` →
 * `anthropic_api` with its secret present — trips no reverse gate: every
 * dependent trigger stays ENABLED, fires on schedule, and fails every time with
 * `CONNECTION_KIND_INVALID`. The trigger buckets above cannot see that, because
 * nothing is being disabled. This one can, because it is a claim about nodes.
 *
 * `acceptedKinds` is what makes it answerable without a round-trip per Kind
 * select: the kinds dispatch would accept FOR THIS NODE'S USE of this
 * connection, so the form can test any candidate kind locally. It is the
 * INTERSECTION over every end of the node that names this connection — a paired
 * node with it on both source and sink dispatches only if BOTH ends accept the
 * kind. That is also the one way it can be empty (a declared sink kind set is
 * never empty, `catalog/types.ts`), meaning the node cannot dispatch against
 * this connection under any kind.
 */
export const DependentNodeSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineName: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int(),
  nodeId: z.string().min(1),
  nodeType: z.string().min(1),
  acceptedKinds: z.array(ConnectionKindSchema),
});
export type DependentNode = z.infer<typeof DependentNodeSchema>;

/**
 * #1252 — a node of a candidate version whose connection reference is a `${}`
 * EXPRESSION, so whether it uses this connection — and therefore whether a kind
 * change breaks it — only a run can say. Reported for the same reason
 * `DynamicDependentTriggerSchema` is: dropping it would let the advisory answer
 * "nothing breaks" confidently and wrongly. Its own bucket rather than a reuse
 * of `dynamic`, because that one only walks ENABLED triggers' versions, and a
 * pipeline's latest version with no enabled trigger is a real candidate here.
 */
export const DynamicDependentNodeSchema = DependentNodeSchema.omit({ acceptedKinds: true });
export type DynamicDependentNode = z.infer<typeof DynamicDependentNodeSchema>;

/**
 * OWNER-SCOPED, AND THEREFORE A LOWER BOUND — stated here because a reader will
 * otherwise assume it is exact.
 *
 * `regateTriggersForConnection` walks `listTriggers(tx)` UNFILTERED and scans
 * each trigger in its own owner scope, so it also disables a null-owner or
 * foreign trigger whose version references this connection (both fold to
 * `missing`). This read is owner-scoped, mirroring `GET /api/triggers` and M9's
 * route, so those rows are absent from `triggers` here.
 *
 * That under-report is deliberate and bounded. `auth/principal.ts` stamps one
 * local owner on every request and `listTriggers`' filter is a strict
 * `eq(ownerId)`, so such a row is invisible from EVERY owner-scoped list route
 * in the product: naming it would point the operator at a trigger they cannot
 * open, inspect, or re-enable, and would confirm the existence of another
 * owner's resource. The alternative — widening the scope — is the only one of
 * the two that leaks. Tracked rather than swallowed.
 */
export const ConnectionDependentsResponseSchema = z.object({
  /** Settled: these WILL be disabled. */
  triggers: z.array(DependentTriggerSchema),
  /**
   * Unsettled: only a run can say. DISJOINT from `triggers` — `dynamic` means
   * "could not be settled", so a trigger whose version names this connection
   * outright is never a member, however many `${}` nodes it also has. Without
   * that rule the advisory names one trigger twice as though they were two:
   * "switches off 1 enabled trigger (nightly) … 1 other enabled trigger
   * (nightly)".
   */
  dynamic: z.array(DynamicDependentTriggerSchema),
  /**
   * #1252 — nodes naming this connection literally, over the SAME candidate
   * versions as M9's dataset references (latest-of-each-pipeline ∪
   * active-published ∪ trigger-pinned; `repo/candidate-versions.ts`), with
   * ARCHIVED pipelines left out: the launcher refuses to dispatch them at all,
   * so no kind change can be what breaks them. Deliberately NOT the trigger
   * buckets' walk — those claim parity with a WRITE, and this has no write to be
   * at parity with.
   */
  nodes: z.array(DependentNodeSchema),
  /** #1252 — the unsettled half of `nodes`, over the same versions. */
  dynamicNodes: z.array(DynamicDependentNodeSchema),
});
export type ConnectionDependentsResponse = z.infer<typeof ConnectionDependentsResponseSchema>;
