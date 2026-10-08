import { ZodError } from 'zod';
import {
  ConnectionPublicSchema,
  GlobalParamCreateBodySchema,
  ImportError,
  capIssueList,
  globalParamResourceId,
  TriggerPublicSchema,
  parseAndUpgradeEnvelope,
  formatZodIssues,
  parseBundle,
  windowBindingErrors,
  type Connection,
  type ExportEnvelope,
  type ImportAttentionItem,
  type ImportBundleResult,
  type ImportResult,
  type NewPipelineVersion,
  type Node,
  type NodeExport,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createDataset,
  createGlobalParam,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  InvalidPipelineDocError,
  getConnectionByResourceId,
  listOwnerGlobalParams,
} from '../repo/index.js';
import type { Db } from '../repo/types.js';

/** The inverse of `export.ts`'s connection-ref stripping, for BOTH bindings: a
 * `null` ref becomes an OMITTED key, since the live-row `NodeSchema` fields are
 * `optional()`, never `null`. The singular is always present-and-nulled by
 * export; the M1 (#1104) pair is present only when the node binds one, and
 * carries its two ends independently. */
function toDbNode(node: NodeExport): Node {
  // M3 (#1117) — `datasetIds` MUST be destructured out alongside the connection
  // fields: `rest` is spread straight into a live `Node`, and an export-shaped
  // pair (ends `string | null`) riding through would put a `null` where
  // `NodeSchema.datasetIds` requires a string. It is rebuilt below.
  // #1144 — `datasetParams` rides with the dataset pair: re-attached below only
  // when the pair survives, because bindings for a dropped pair are refused by
  // the write gate and would roll the whole import back.
  const { connectionId, connectionIds, datasetIds, datasetParams, ...rest } = node;
  const base = connectionId === null ? rest : { ...rest, connectionId };
  // M1 (#1104) — the paired binding's inverse. An end nulled by export is
  // UNBOUND on import, and `NodeSchema.connectionIds` requires BOTH ends, so a
  // pair with either end nulled drops the whole key: the importer rebinds it
  // (the node is flagged in `strippedConnectionRefs`). Keeping a half pair would
  // be unsavable, and manufacturing an id for the missing end is the fail-open
  // this codebase refuses. A fully-`${}` pair survives intact.
  const withConn =
    connectionIds === undefined || connectionIds.source === null || connectionIds.sink === null
      ? base
      : { ...base, connectionIds: { source: connectionIds.source, sink: connectionIds.sink } };
  // M3 (#1117) — the dataset pair's inverse, on the identical drop-whole rule and
  // applied to the RESULT rather than inside the connection branch: the two
  // fields are orthogonal (a copy binds both), so returning early on one would
  // drop the other. An end nulled by export is unbound, so a pair with a nulled
  // end drops whole — keeping one end would be unsavable and inventing the other
  // is the fail-open this codebase refuses. The node is reported as an
  // `unresolvedDatasetRef`. A fully-`${}` pair survives intact and is correctly
  // not reported.
  //
  // M12 slice 1 (#1220) — the rule now distinguishes NULL from ABSENT, which the
  // clause "`NodeSchema.datasetIds` requires both" used to make unnecessary:
  //
  //   sink null   -> a sink WAS bound and export stripped it. Still drops whole:
  //                  unchanged, still reported, and the node still needs a rebind.
  //   sink absent -> no sink was ever bound (a source-only reader). SURVIVES as
  //                  `{source}`, which `NodeSchema` now accepts. Not reported —
  //                  nothing was stripped, so there is nothing to re-bind.
  //
  // Reading absent as null here is the silent one: a source-only node would lose
  // its dataset binding on every export/import round-trip and be reported as
  // needing a repair it cannot express. A null SOURCE always drops whole, on
  // either shape — an address with no source names no data to read.
  if (datasetIds === undefined || datasetIds.source === null || datasetIds.sink === null) {
    return withConn;
  }
  const { source, sink } = datasetIds;
  return {
    ...withConn,
    datasetIds: { source, ...(sink === undefined ? {} : { sink }) },
    ...(datasetParams === undefined ? {} : { datasetParams }),
  };
}

/** M3 (#1117) — the node ids whose exported `datasetIds` has at least one end
 * nulled, i.e. the pairs `toDbNode` dropped. Derived from the envelope's own
 * nodes rather than from a stripped-refs list the exporter carries: the key is
 * emitted only when the node binds a pair, so a null end can only mean "export
 * stripped a literal" and a second SSOT would be a list that can disagree with
 * the thing it describes.
 *
 * DEDUPED across versions, and that is the whole reason this returns a `Set`'s
 * contents rather than a plain push-list. An export carries EVERY immutable
 * version of the pipeline, a node id is stable across them, and a binding that
 * was never re-authored appears identically in each — so a per-version push
 * would repeat one repair instruction once per version the node survived in,
 * rendered verbatim by `ImportPanel`. `strippedConnectionRefs` gets this for
 * free by being a `Set` threaded through all versions in `export.ts`; deriving
 * the fact here means doing it explicitly. */
function unresolvedDatasetNodeIds(versions: readonly { nodes: NodeExport[] }[]): string[] {
  const ids = new Set<string>();
  for (const version of versions) {
    for (const node of version.nodes) {
      const pair = node.datasetIds;
      if (pair !== undefined && (pair.source === null || pair.sink === null)) ids.add(node.id);
    }
  }
  return Array.from(ids);
}

/**
 * ATOMIC (#459): a pipeline import is many writes — one `pipelines` row plus a
 * version row per exported version — and any version can be REFUSED, either by
 * `NewPipelineVersionSchema` or (as of #444) by the doc gate. Without a
 * transaction the refusal lands mid-way, leaving an orphan pipeline and the
 * versions that happened to precede it: an import that "failed" but still
 * changed the database. (#1492 narrowed what refuses: a HISTORICAL version that
 * fails only #1480's activity check is admitted and reported, not refused.) #444 is what makes that likely rather than exotic, so
 * the two ship together.
 *
 * `createPipelineVersion` opens its OWN `db.transaction`; better-sqlite3 drops
 * a nested one to a `SAVEPOINT` and commits it with the outer scope, so passing
 * the same `db` handle down composes and needs no tx threading. (Note this is
 * NOT `scheduler/alarms.ts`'s idiom, which threads the `tx` handle into its
 * callee; here the callee takes `db` and relies on better-sqlite3's native
 * nesting instead. Both are safe — the rollback is verified by the test below.)
 */
function importPipelineEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'pipeline' }>,
): ImportResult {
  return db.transaction(() => importPipelineEnvelopeInTx(db, ownerId, envelope));
}

function importPipelineEnvelopeInTx(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'pipeline' }>,
): ImportResult {
  const {
    pipeline: exportedPipeline,
    versions: exportedVersions,
    strippedConnectionRefs,
  } = envelope.data;
  // #5 S6b — `concurrency` rides the round-trip (the #473 lesson: a field the
  // import silently drops is destroyed data). `createPipeline`'s WRITE schema
  // is strict, so an envelope carrying a corrupted cap (the read schema is
  // lenient) is REFUSED here rather than laundered into a fresh row.
  const pipeline = createPipeline(db, {
    ownerId,
    name: exportedPipeline.name,
    concurrency: exportedPipeline.concurrency,
    // #1380 — absent (top level, or a pre-#1380 file) and `null` both mean no folder.
    folder: exportedPipeline.folder ?? null,
  });

  // Only nodes actually recorded here HAD a connection stripped on export —
  // every node's `connectionId` is nulled by export regardless (see
  // `stripNodeConnectionId`), so checking `connectionId === null` here would
  // false-positive-flood nodes that never referenced a connection at all.
  const attention: ImportAttentionItem[] = strippedConnectionRefs.map((nodeId) => ({
    type: 'unresolvedConnectionRef',
    nodeId,
  }));
  // M3 (#1117) — one item per node whose dataset pair was dropped. A node may
  // legitimately appear in BOTH lists (its connection and its datasets were each
  // stripped); they are separate repairs, so both are reported.
  for (const nodeId of unresolvedDatasetNodeIds(exportedVersions)) {
    attention.push({ type: 'unresolvedDatasetRef', nodeId });
  }
  const versions = exportedVersions.map((exportedVersion, index) => {
    // SPREAD, not a field-by-field rebuild (#473). Listing the fields by hand
    // is what silently dropped `containers` on import: every field of
    // `NewPipelineVersion` that has a `.default()` is OPTIONAL in `z.input`, so
    // forgetting one type-checks cleanly and loses data at run time. Spreading
    // keeps this in step with `PipelineVersionExportSchema` (which derives from
    // `PipelineVersionSchema`) by construction, so a field added to the domain
    // model imports without a change here. `id`/`version`/`createdAt` ride along
    // harmlessly — `NewPipelineVersionSchema` omits them and Zod strips unknown
    // keys, so the server still assigns all three (`createPipelineVersion`);
    // the import tests pin that, since it is what keeps the module's
    // "never reuses an exported id" invariant true under a spread.
    const input: NewPipelineVersion = {
      ...exportedVersion,
      pipelineId: pipeline.id,
      nodes: exportedVersion.nodes.map(toDbNode),
    };
    // #1492 — the LAST version minted is the head here, whatever number the file
    // gave it (versions renumber 1..n in file order), so it is always refused if
    // invalid: importing it would mint a head that can never run.
    const isHead = index === exportedVersions.length - 1;
    try {
      return createPipelineVersion(db, input);
    } catch (err) {
      if (isHead || !(err instanceof InvalidPipelineDocError)) throw err;
      // A HISTORICAL version saved before #1480 may fail its activity check, and
      // nothing can repair it (versions are immutable). Admit it if that check is
      // ALL it fails, and say so; any structural fault still refuses the import,
      // with the first, complete diagnostics. Only a second validation refusal is
      // swapped for the first: any other fault propagates as itself.
      let admitted;
      try {
        admitted = createPipelineVersion(db, input, { skipActivityChecks: true });
      } catch (retryErr) {
        throw retryErr instanceof InvalidPipelineDocError ? err : retryErr;
      }
      // ECHO: the issues quote node ids and config key paths from the file the
      // caller just sent, back to that caller, on the same owner-scoped request —
      // the argument `errors.ts` makes for `InvalidPipelineDocError`'s 400. They
      // are the same strings, clipped the same way, as that 400 would carry.
      attention.push({
        type: 'unrunnableVersion',
        version: admitted.version,
        ...capIssueList(err.issues),
      });
      return admitted;
    }
  });

  return { kind: 'pipeline', pipeline, versions, attention };
}

function importConnectionEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'connection' }>,
): ImportResult {
  const {
    id,
    createdAt,
    updatedAt,
    ownerId: exportedOwnerId,
    requiresSecret,
    ...rest
  } = envelope.data;
  void id;
  void createdAt;
  void updatedAt;
  void exportedOwnerId;

  // Never import a secret: `secretRef` was never in the export (see
  // `ConnectionExportDataSchema`), so the imported connection always starts
  // with none — `requiresSecret` just tells the caller whether the ORIGINAL
  // connection had one, so they know to enter a fresh one.
  const created = createConnection(db, { ...rest, ownerId, secretRef: null });
  const attention: ImportAttentionItem[] = requiresSecret ? [{ type: 'requiresSecret' }] : [];

  return { kind: 'connection', connection: ConnectionPublicSchema.parse(created), attention };
}

function importTriggerEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'trigger' }>,
): ImportResult {
  const {
    id,
    createdAt,
    updatedAt,
    ownerId: exportedOwnerId,
    pipelineVersionId: exportedPipelineVersionId,
    webhook: exportedWebhook,
    ...rest
  } = envelope.data;
  void id;
  void createdAt;
  void updatedAt;
  void exportedOwnerId;
  void exportedPipelineVersionId;

  const attention: ImportAttentionItem[] = [{ type: 'unboundPipelineVersion' }];
  if (exportedWebhook !== null) attention.push({ type: 'requiresWebhookSecret' });

  // #5 S11b — `${trigger.windowStart/End}` bindings are tumbling-only (the
  // route's `assertWindowBindingsConsistent`, which this path bypasses). Unlike
  // `event`/`window` below, params CANNOT be forced consistent (they are user
  // content — surgically rewriting expressions is worse than refusing), so a
  // mode-inconsistent envelope is REFUSED outright: importing it would create a
  // row whose every subsequent PATCH — including the mandatory rebind this
  // import contract directs the operator to make — 400s on the cross-field
  // rule. No legal write path produces such an envelope; only a hand-crafted
  // one reaches here.
  if (rest.mode !== 'tumbling') {
    const offending = windowBindingErrors(rest.params);
    if (offending.length > 0) {
      throw new ImportError(
        `trigger envelope binds \${trigger.windowStart/End} on a '${rest.mode}' trigger — ` +
          `window-field bindings are only valid on a 'tumbling' trigger: ${offending.join('; ')}`,
      );
    }
  }

  // Cross-entity refs ALWAYS stay null on import, regardless of what the
  // envelope carried — the importer re-binds via the normal PATCH route.
  // `webhook` is likewise always null: a webhook trigger's `secretRef` is
  // never exported/imported (same reasoning as a connection secret), so
  // there is no valid `WebhookConfigSchema` value to reconstruct here.
  //
  // `enabled` is ALSO forced false here, regardless of what the envelope
  // carried: an imported trigger is unbound (`pipelineVersionId: null`)
  // by construction, so `enabled: true` + unbound would otherwise rest
  // solely on the future P4 scheduler's null-check to never fire it.
  // Defense-in-depth — the importer must explicitly rebind + re-enable via
  // the normal routes before this trigger can run. The P4 scheduler must
  // STILL refuse to fire a null-bound trigger; that null-check remains the
  // primary guarantee, this is a belt-and-braces second line of defense.
  const created = createTrigger(db, {
    ...rest,
    ownerId,
    pipelineVersionId: null,
    webhook: null,
    // #5 S8 — an event subscription only makes sense on an `event` trigger
    // (`assertEventConsistent`, the route guard this path bypasses): force it
    // null on any other mode, or a hand-crafted envelope could create a row
    // whose every subsequent PATCH 400s on the cross-field rule. An event-mode
    // trigger keeps its subscription verbatim (no secret in it).
    event: rest.mode === 'event' ? (rest.event ?? null) : null,
    // #5 S9 — a window geometry only makes sense on a `tumbling` trigger
    // (`assertWindowConsistent`, the route guard this path bypasses): force it
    // null on any other mode, exactly as `event` above. A tumbling trigger
    // keeps its geometry verbatim (no secret in it).
    window: rest.mode === 'tumbling' ? (rest.window ?? null) : null,
    enabled: false,
  });

  return { kind: 'trigger', trigger: TriggerPublicSchema.parse(created), attention };
}

/**
 * #1143 — a dataset from a single file. `Dataset.connectionId` is NOT NULL (a
 * dataset with no store is not a dataset), so this is the one kind with no
 * "import now, rebind later" state: the store is resolved HERE or the import is
 * refused, and nothing is created on a refusal.
 *
 * Resolution, in order:
 *  1. `store` — the connection the caller CHOSE, resolved and owner-checked
 *     by the route (`requireOwnedConnection`) through `resolveStore`.
 *  2. IDENTITY — the importer's own connection whose `resourceId` is the one the
 *     export wrote (`exportDataset` remaps the store to its resourceId, exactly
 *     as the git form does). Owner-scoped by `getConnectionByResourceId`, so a
 *     resourceId in the file can never reach another owner's connection. This
 *     hits in the exporting workspace and in one synced from the same git repo.
 *  3. otherwise REFUSE. Never guess by name or kind.
 *
 * Why both 1 and 2 rather than #1114's resolve-or-refuse alone: a portable
 * import MINTS a fresh resourceId (#3 G1), so a connection that arrived by file
 * never shares identity with its datasets' files, and identity alone would
 * refuse every cross-workspace move. The explicit choice is what makes that
 * move possible; identity keeps the same-workspace case one click.
 *
 * Kind compatibility is ADVISORY, exactly as on `POST /api/datasets` (the
 * list's "kind mismatch" marker), so it is not enforced here either.
 */
function importDatasetEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'dataset' }>,
  store: Connection | undefined,
): ImportResult {
  const {
    id,
    resourceId,
    createdAt,
    updatedAt,
    ownerId: exportedOwnerId,
    connectionId: exportedStore,
    ...rest
  } = envelope.data;
  void id;
  void resourceId;
  void createdAt;
  void updatedAt;
  void exportedOwnerId;

  const connection = store ?? getConnectionByResourceId(db, ownerId, exportedStore);
  if (connection === null) {
    throw new ImportError(
      `dataset "${rest.name}" names a store connection (${exportedStore}) that is not in this ` +
        'workspace — choose the connection to store it in, and import it again',
    );
  }

  const created = createDataset(db, { ...rest, ownerId, connectionId: connection.id });
  return { kind: 'dataset', dataset: created, attention: [] };
}

/**
 * #844 GL6 — a global parameter from a single file, created under exactly the
 * rules `POST /api/global-params` applies (a `ZodError` is a 400). A global holds
 * no reference, so nothing is left to rebind.
 *
 * A name this owner already holds, in any case, is refused by name rather than
 * left to the unique index's generic conflict: an import never overwrites a live
 * global's value (a pull from git is the path that updates one). The check and
 * the insert run in one synchronous turn (better-sqlite3 does not yield), so
 * no other write lands between them; the NOCASE unique index stays the backstop.
 */
function importGlobalParamEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'global-param' }>,
): ImportResult {
  const body = GlobalParamCreateBodySchema.parse(envelope.data);
  const identity = globalParamResourceId(body.name);
  const held = listOwnerGlobalParams(db, ownerId).find(
    (g) => globalParamResourceId(g.name) === identity,
  );
  if (held !== undefined) {
    throw new ImportError(
      `a global parameter named "${held.name}" already exists — an import does not overwrite ` +
        'one; edit its value in Manage → Global parameters instead',
    );
  }
  const created = createGlobalParam(db, { ...body, ownerId });
  return { kind: 'global-param', globalParam: created, attention: [] };
}

/** #1143 — what the caller of `importEnvelope` may decide for the file. */
export interface ImportOptions {
  /** The store a DATASET lands in, resolved AND owner-checked by the caller.
   * A thunk, so it runs only once the envelope is known to be a dataset: only a
   * dataset has a store, and a store chosen for any other kind is refused as
   * such rather than silently ignored — or answered with a lookup error about a
   * connection that was never going to be used. */
  resolveStore?: () => Connection;
}

/**
 * The one import entry point: `parseAndUpgradeEnvelope`s `raw` (throws
 * `ImportError` — mapped to a 400 by the global error handler — on anything
 * it refuses), then creates the entity/entities it describes with BRAND-NEW
 * ids, owned by `ownerId`, via the same repo functions every CRUD route uses
 * (so every repo invariant + Zod parse applies exactly as it would for a
 * hand-authored create). Never reuses an exported id, never imports a
 * secret, and leaves cross-entity refs (a pipeline node's `connectionId`, a
 * trigger's `pipelineVersionId`) null for the importer to rebind afterward via
 * the normal routes — with ONE exception, a dataset's store, which cannot be
 * null and is resolved or refused here (see `importDatasetEnvelope`).
 */
export function importEnvelope(
  db: Db,
  ownerId: string,
  raw: unknown,
  opts: ImportOptions = {},
): ImportResult {
  const envelope = parseAndUpgradeEnvelope(raw);
  if (opts.resolveStore !== undefined && envelope.kind !== 'dataset') {
    throw new ImportError(
      `a store connection was chosen, but this is a ${envelope.kind} export — only a dataset ` +
        'lives in a store',
    );
  }
  return importParsedEnvelope(db, ownerId, envelope, opts.resolveStore?.());
}

function importParsedEnvelope(
  db: Db,
  ownerId: string,
  envelope: ExportEnvelope,
  store: Connection | undefined,
): ImportResult {
  switch (envelope.kind) {
    case 'pipeline':
      return importPipelineEnvelope(db, ownerId, envelope);
    case 'connection':
      return importConnectionEnvelope(db, ownerId, envelope);
    case 'trigger':
      return importTriggerEnvelope(db, ownerId, envelope);
    case 'dataset':
      return importDatasetEnvelope(db, ownerId, envelope, store);
    case 'global-param':
      return importGlobalParamEnvelope(db, ownerId, envelope);
  }
}

/**
 * #1586 — a bundle, ALL OR NOTHING. Every member is parsed and upgraded first
 * (`parseBundle`), so a malformed member refuses the file before any write;
 * then ONE transaction imports each through the same path a single pipeline
 * file takes, so a member refused mid-way (the doc gate, a write schema) rolls
 * back the members already written. The pipeline import's own transaction
 * nests as a SAVEPOINT inside this one (see `importPipelineEnvelope`).
 *
 * PIPELINES ONLY. The toolbar exports pipelines, and the other kinds would open
 * paths a bundle cannot honour yet: a dataset needs a store chosen per file, a
 * connection imported beside a dataset mints a fresh identity the dataset then
 * cannot resolve, and two global parameters of one name would refuse each
 * other with advice to edit a value that does not exist yet.
 *
 * The importer's refusals name the member — its position and pipeline name —
 * because "pipeline doc invalid" from a 40-pipeline file says nothing about
 * which: an `ImportError`, the doc gate and a write schema (`labelMemberError`).
 * The name is clipped, since a pipeline name has no length cap and the doc
 * gate's message is bounded at its source (`errors.ts`).
 */
export function importBundle(
  db: Db,
  ownerId: string,
  raw: unknown,
  opts: ImportOptions = {},
): ImportBundleResult {
  if (opts.resolveStore !== undefined) {
    throw new ImportError(
      'a store connection was chosen, but this is a bundle of pipelines — only a dataset lives in a store',
    );
  }
  const envelopes = parseBundle(raw).map((envelope, i) => {
    if (envelope.kind !== 'pipeline') {
      throw new ImportError(
        `Item ${i + 1}: a bundle carries pipelines only, and this is a ${envelope.kind} export — import it as its own file`,
      );
    }
    return envelope;
  });
  return db.transaction(() => ({
    kind: 'bundle' as const,
    items: envelopes.map((envelope, i) => {
      try {
        return importPipelineEnvelope(db, ownerId, envelope);
      } catch (err) {
        throw labelMemberError(
          err,
          `Item ${i + 1} (pipeline “${clip(envelope.data.pipeline.name, LABEL_NAME_CHARS)}”)`,
        );
      }
    }),
  }));
}

/** How much of a pipeline name a member label quotes. */
const LABEL_NAME_CHARS = 60;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A member's refusal, with the member named and its status kept: an
 * `ImportError` stays an `import_error`, the doc gate's refusal keeps its class
 * (and its `issues`) so `errors.ts` still answers `invalid_pipeline_doc`, and a
 * write-schema `ZodError` — whose paths would point into the member, not the
 * file — becomes an `ImportError` quoting the same value-free issues. Anything
 * else is not a refusal and passes through unlabelled.
 */
function labelMemberError(err: unknown, label: string): unknown {
  if (err instanceof ImportError) return new ImportError(`${label}: ${err.message}`);
  if (err instanceof ZodError) {
    return new ImportError(`${label}: ${formatZodIssues(err.issues)}`);
  }
  if (err instanceof InvalidPipelineDocError) {
    err.message = `${label}: ${err.message}`;
  }
  return err;
}
