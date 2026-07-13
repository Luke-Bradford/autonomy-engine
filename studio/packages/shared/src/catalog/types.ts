import type { z } from 'zod';
import type { ConnectionKind } from '../schemas/connection.js';
import type { Output } from '../schemas/pipeline.js';

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
}

/** The activity catalog: a read-only registry keyed by activity `type`. */
export type ActivityCatalog = ReadonlyMap<string, ActivityCatalogEntry>;
