import {
  CATALOG_VERSION,
  ConnectionExportDataSchema,
  DatasetExportDataSchema,
  ExportEnvelopeSchema,
  PipelineExportDataSchema,
  RESOURCE_KINDS,
  SCHEMA_VERSION,
  TriggerExportDataSchema,
  WebhookPublicConfigSchema,
  canonicalStringify,
  interpolationMode,
  pipelineVersionContentForm,
  resourceFilePaths,
  type Connection,
  type Dataset,
  type ExportEnvelope,
  type Node,
  type NodeExport,
  type Pipeline,
  type PipelineVersion,
  type PipelineVersionExport,
  type ResourceKind,
  type Trigger,
} from '@autonomy-studio/shared';
import {
  getLatestPipelineVersion,
  listConnections,
  listDatasets,
  listPipelineVersions,
  listPipelines,
  listTriggers,
} from '../repo/index.js';
import type { Db } from '../repo/types.js';

/**
 * #3 G3a — the workspace-git EXPORT fork: turn a workspace's DB working copy
 * into the canonical JSON files a Commit lands in the managed checkout. This
 * is DISTINCT from `portability/export.ts` (the PORTABLE, cross-workspace copy
 * primitive) in two load-bearing ways, both from Foundation Spec #3:
 *
 * 1. **Latest version only.** Per the settled working-copy model (#662 (a)):
 *    Commit serializes each pipeline's LATEST immutable version, not the whole
 *    DB version trail — git history IS the version trail, so bundling all
 *    versions would double-track it.
 * 2. **Internal refs are PRESERVED and remapped to `resourceId`s**, not nulled.
 *    A same-workspace re-import mints a NEW DB version id under the SAME
 *    `resourceId` (G1: "workspace-git import PRESERVES ids"), so a ref stored
 *    as a concrete DB id would dangle on the first round-trip. Literal
 *    `node.connectionId` → the connection's `resourceId`; literal
 *    `node.call.pipelineVersionId` / `trigger.pipelineVersionId` → that
 *    version's `resourceId`. A `${}` DYNAMIC ref (classified by the SSOT
 *    `interpolationMode`, exactly as export.ts does for `connectionId`) is
 *    PRESERVED verbatim — it routes on run values, not an env-specific row.
 *
 * The remap resolves every id through OWNER-SCOPED maps built from the owner's
 * own resources; a non-null id that fails to resolve to an owned row FAILS the
 * Commit loudly (never coerced to `null` — #473: an absent fact is not a benign
 * default). `null`-stays-`null` only when the source was already absent.
 *
 * `exportedAt` — the one volatile envelope field (`Date.now()` in export.ts) —
 * is normalized to `0` here (a valid `int`, so the file still re-parses through
 * `ExportEnvelopeSchema`) so identical DB content serializes to identical
 * bytes: the git file writer diffs these files and the G4/G5 import classifier
 * will hash them (the G1 built-block "exportedAt churn trap").
 */

/**
 * #1043 — WHICH ref of a resource could not be put in resourceId-space, and what
 * it names. Structured rather than a formatted string because four callers need
 * to say it in their own voice: a drift/preview diagnostic, an apply disclosure,
 * and the Commit refusal.
 *
 * `danglingId` is the raw stored DB id, never a name: the row it named is GONE,
 * so there is no name left to look up and inventing one would assert a fact
 * nobody measured. `nodeId` is `null` for a resource-level ref (a trigger's
 * binding), which has no node to blame.
 */
export interface UnserializableRefDetail {
  ref:
    | 'connection'
    | 'connectionSource'
    | 'connectionSink'
    | 'call'
    | 'binding'
    // #1114 (M2) — a DATASET's ref to the connection it lives in. Resource-level
    // like `binding` (so `nodeId` is null), not node-level.
    | 'store';
  nodeId: string | null;
  danglingId: string;
}

/**
 * #1043 — a whole RESOURCE that cannot be serialized, i.e. its detail plus the
 * identity a caller needs to name it. `path` is the path this resource WOULD
 * have occupied, so a diagnostic can key on it exactly as a branch-side one does.
 */
export interface UnserializableResource extends UnserializableRefDetail {
  kind: 'pipeline' | 'trigger' | 'dataset';
  resourceId: string;
  name: string;
  path: string;
}

/** #1043 — the human sentence for one unserializable ref. The ids in it are the
 * OWNER'S OWN DB data (an authored node id, a stored row id), never bytes read
 * from a committed file — so this does not cross the rule that keeps arbitrary
 * branch content out of API responses (`workspace-parse.ts`'s DIAGNOSTIC_MESSAGE). */
export function describeUnserializable(detail: UnserializableRefDetail): string {
  // #1114 — `store` needs its own arm rather than riding the fallthrough: the
  // tail of this chain is `pipeline version`, so a new ref kind added without
  // one is not merely unlabelled, it is labelled WRONG.
  const what =
    detail.ref === 'connection' || detail.ref === 'store'
      ? `connection "${detail.danglingId}"`
      : detail.ref === 'connectionSource'
        ? `source connection "${detail.danglingId}"`
        : detail.ref === 'connectionSink'
          ? `sink connection "${detail.danglingId}"`
          : `pipeline version "${detail.danglingId}"`;
  return detail.nodeId === null
    ? `binds ${what}, which no longer exists`
    : `node "${detail.nodeId}" references ${what}, which no longer exists`;
}

/**
 * A resource references (via a NON-null, LITERAL id) another resource that is no
 * longer in this owner's workspace — a ref the serializer refuses to paper over
 * with a `null` (#473: an absent fact is not a benign default).
 *
 * #1043 corrected what this MEANS. It was documented as "a corrupt/cross-owner
 * id … not user input", surfaced as an internal 500. It is reachable by two
 * ORDINARY acts: author a node using a connection (which mints an IMMUTABLE
 * version holding that connection's db id), then delete the connection — a hard
 * delete, deliberately, since there is no FK from versions. So it is a state the
 * operator can produce and must be told how to fix, not an internal fault.
 *
 * `offenders` carries EVERY resource that failed, not just the first: a message
 * naming one of three broken pipelines sends the operator back round the loop
 * twice more. The MESSAGE names at most `MAX_NAMED_OFFENDERS` of them and counts
 * the rest — an unbounded list-into-one-string is the shape `capIssues` exists
 * to avoid in `errors.ts`, and a sentence naming forty pipelines helps nobody.
 * The full set stays on `offenders` for any caller that wants it. That completeness is BETWEEN resources, not within one — a node's
 * remap throws at the first bad ref, so a pipeline with two dangling refs
 * reports only the first, and the second surfaces once the first is fixed.
 * Pre-existing, and left alone deliberately: collecting per-ref would mean
 * restructuring the remap, for a second sentence about a pipeline the operator
 * is already being sent to edit.
 */
const MAX_NAMED_OFFENDERS = 5;

export class WorkspaceSerializeError extends Error {
  readonly offenders: UnserializableResource[];

  constructor(offenders: UnserializableResource[]) {
    const named = offenders.slice(0, MAX_NAMED_OFFENDERS);
    const rest = offenders.length - named.length;
    super(
      `${offenders.length} resource(s) cannot be committed: ` +
        named.map((o) => `"${o.name}" ${describeUnserializable(o)}`).join('; ') +
        (rest > 0 ? `; and ${rest} more` : ''),
    );
    this.name = 'WorkspaceSerializeError';
    this.offenders = offenders;
  }
}

/** #1043 — thrown by `remapRef` for ONE ref; the per-resource catch in
 * `serializeWorkspaceTolerant` is what turns it into an `UnserializableResource`
 * by adding the identity of the resource being serialized. Never escapes this
 * module. */
class UnserializableRefError extends Error {
  readonly detail: UnserializableRefDetail;

  constructor(detail: UnserializableRefDetail) {
    super(describeUnserializable(detail));
    this.name = 'UnserializableRefError';
    this.detail = detail;
  }
}

/** One serialized file: its repo-relative path and its canonical JSON bytes.
 *
 * `blobSha` (#3 G6b) is the git blob SHA of this file at the read ref — present
 * ONLY when the file came from the git reader (`readWorkspaceFilesAtRef`), so the
 * import can stamp a minted version's `source_blob_sha` provenance. It is absent
 * on the DB-snapshot path (`serializeWorkspace`, which never touches git); that
 * snapshot is only ever the reconcile BASELINE and never mints, so absent is
 * fine — no consumer of the snapshot reads `blobSha`. */
export interface WorkspaceFile {
  path: string;
  contents: string;
  blobSha?: string;
}

export interface OwnerRefMaps {
  /** Every owned pipeline VERSION's DB id → its stable `resourceId`. */
  versionResourceId: Map<string, string>;
  /** Every owned connection's DB id → its stable `resourceId`. */
  connectionResourceId: Map<string, string>;
}

function buildOwnerRefMaps(db: Db, pipelines: Pipeline[], connections: Connection[]): OwnerRefMaps {
  const versionResourceId = new Map<string, string>();
  for (const pipeline of pipelines) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      versionResourceId.set(version.id, version.resourceId);
    }
  }
  const connectionResourceId = new Map<string, string>();
  for (const connection of connections) {
    connectionResourceId.set(connection.id, connection.resourceId);
  }
  return { versionResourceId, connectionResourceId };
}

/**
 * Remap a STORED DB node's concrete ids back to stable `resourceId`s (the
 * forward direction serialize uses), so a stored version can be compared to a
 * branch version in the SAME resourceId-space. `${}` dynamic refs stay verbatim;
 * an absent `connectionId` becomes `null` (the export shape). An id absent from
 * the owner-scoped reverse map is kept as-is (defensive — an owned row's refs
 * always map; a mismatch just makes the content forms differ, never a false
 * "unchanged"). Reads no DB — pure over the passed maps.
 *
 * That defensiveness is load-bearing rather than belt-and-braces, and it is why
 * this lives here rather than being re-derived from `serializePipeline`: a
 * HISTORIC version can name a connection that has since been hard-deleted, and
 * `remapRef` (the commit-direction path) THROWS on an unmapped literal. Throwing
 * is right when writing a branch — a commit must not emit a dangling ref — and
 * wrong when merely comparing two versions, where the honest answer is "these
 * forms differ".
 */
function forwardRemapNode(
  node: Node,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): NodeExport {
  const { connectionId, connectionIds, call, ...rest } = node;
  // The three-way (absent / dynamic / literal-mapped) rule, as ONE function, so
  // the singular and each end of the M1 (#1104) pair cannot drift apart —
  // divergence here manufactures a false "changed" in the stored-vs-branch
  // compare, which is worse than a loud failure because it silently mints a
  // version nobody authored.
  const forwardRef = (id: string): string =>
    interpolationMode(id).mode !== 'literal' ? id : (connRidByDbId.get(id) ?? id);
  const connExport: string | null = connectionId === undefined ? null : forwardRef(connectionId);

  const exported: NodeExport = { ...rest, connectionId: connExport };
  if (connectionIds !== undefined) {
    exported.connectionIds = {
      source: forwardRef(connectionIds.source),
      sink: forwardRef(connectionIds.sink),
    };
  }
  if (call) {
    const ref = call.pipelineVersionId;
    const refExport =
      interpolationMode(ref).mode !== 'literal' ? ref : (versionRidByDbId.get(ref) ?? ref);
    exported.call = { ...call, pipelineVersionId: refExport };
  }
  return exported;
}

/** The content form of a STORED DB version, in resourceId-space — the baseline
 * the branch's incoming version is compared against to decide "mint a new
 * version vs no-op vs a divergent-content contradiction". Uses the reverse maps
 * so archived pipelines' versions (omitted from the serialize snapshot) are
 * comparable too.
 *
 * #983 — lives here, beside the export direction it inverts, because the reconcile
 * PREVIEW and the reconcile APPLY both have to answer "is the branch's version
 * byte-identical to the row its id names", and two implementations of that
 * question could disagree about the one comparison the whole `superseded`
 * decision turns on. Exported for the same reason `serializeTrigger` is.
 */
export function dbVersionForm(
  version: PipelineVersion,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): string {
  const exportForm = {
    ...version,
    nodes: version.nodes.map((n) => forwardRemapNode(n, connRidByDbId, versionRidByDbId)),
  } as PipelineVersionExport;
  return pipelineVersionContentForm(exportForm);
}

/**
 * #1018 — the sentinel a ref is masked to when it cannot be expressed in
 * resourceId-space. Its only job is to compare equal to itself on both sides of
 * `compareStoredVersion`.
 *
 * Its safety does NOT rest on being unguessable, which is worth stating because
 * the obvious argument for that ("ids are `[A-Za-z0-9_-]`") is not one the
 * schemas actually enforce — `resourceId` is `z.string().min(1)`, and an
 * imported branch supplies its own. The real guarantee is structural: WHICH
 * fields are masked is decided entirely by the STORED row and the owner-scoped
 * reverse map, never by the incoming file, so a branch choosing this exact
 * string for a ref gets it compared like any other value and cannot buy itself
 * an excuse. */
const UNDECIDABLE_REF = ' undecidable';

/** #1018 — the outcome of judging a branch version against the STORED row whose
 * `resourceId` it names.
 *
 * `identical` is decided over the two content forms with every UNDECIDABLE ref
 * masked out ON BOTH SIDES, so a difference that exists only because the reverse
 * map lost an entry does not read as a difference in content. `undecidableRefs`
 * counts the masks: it is how much of the comparison could NOT be made, and it
 * must be reported rather than folded into `identical`, because `identical` with
 * a non-zero count means "differs nowhere we can decide", not "byte-identical".
 * Manufacturing the stronger claim from the weaker fact is the #473 shape.
 */
export interface StoredVersionComparison {
  identical: boolean;
  undecidableRefs: number;
}

/**
 * #1018 — compare a branch version against the stored row its id names, tolerant
 * of refs that no longer resolve and of nothing else.
 *
 * A stored version is IMMUTABLE, so a ref it holds outlives the thing it names: a
 * connection can be hard-deleted (`repo/connections.ts` — deliberately, since
 * there is no FK from versions) while a historic version still points at its DB
 * id. `forwardRemapNode` then keeps that id verbatim, the branch file carries the
 * `resourceId` recorded when it still existed, and the two forms differ for a
 * reason that is not an edit. Comparing the raw forms therefore answers
 * "different content" to a question that is really undecidable — which the apply
 * used to report as a hand-edit of an immutable row, wedging every future pull
 * with an accusation the operator could neither act on nor undo.
 *
 * The mask is per-NODE-REF, never per-version, and that is the whole point: only
 * the fields that genuinely cannot be judged are excused, so a hand-edit anywhere
 * else in the same version is still caught. The residual it does accept is
 * narrow and worth naming — a branch that rewrites the connection ref OF THE
 * NODE whose stored ref is already dangling compares as identical. Nothing is
 * written either way (the version is immutable and already materialised), so the
 * cost is a silent no-op on one field, not a bad write.
 */
export function compareStoredVersion(
  stored: PipelineVersion,
  branch: PipelineVersionExport,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): StoredVersionComparison {
  const masks: NodeRefMasks = {
    connection: new Set<string>(),
    source: new Set<string>(),
    sink: new Set<string>(),
    call: new Set<string>(),
  };
  for (const node of stored.nodes) {
    if (isUndecidableRef(node.connectionId, connRidByDbId)) masks.connection.add(node.id);
    // M1 (#1104) — each END of a pair is judged on its own. Folding both into
    // one per-node flag would over-mask: a node whose source is dangling and
    // whose sink is fine would have its (decidable) sink blanked too, hiding a
    // real hand-edit to that end behind the other end's undecidability.
    if (isUndecidableRef(node.connectionIds?.source, connRidByDbId)) masks.source.add(node.id);
    if (isUndecidableRef(node.connectionIds?.sink, connRidByDbId)) masks.sink.add(node.id);
    if (isUndecidableRef(node.call?.pipelineVersionId, versionRidByDbId)) masks.call.add(node.id);
  }
  const undecidableRefs =
    masks.connection.size + masks.source.size + masks.sink.size + masks.call.size;
  if (undecidableRefs === 0) {
    return {
      identical:
        dbVersionForm(stored, connRidByDbId, versionRidByDbId) ===
        pipelineVersionContentForm(branch),
      undecidableRefs,
    };
  }
  const storedForm = pipelineVersionContentForm({
    ...stored,
    nodes: stored.nodes.map((n) =>
      maskNode(forwardRemapNode(n, connRidByDbId, versionRidByDbId), masks),
    ),
  } as PipelineVersionExport);
  const branchForm = pipelineVersionContentForm({
    ...branch,
    nodes: branch.nodes.map((n) => maskNode(n, masks)),
  });
  return { identical: storedForm === branchForm, undecidableRefs };
}

/** #1018 — a stored ref that cannot be expressed in resourceId-space: LITERAL
 * (a `${}` ref is portable already and never consults the map, so it is always
 * decidable) and absent from the owner-scoped reverse map. */
function isUndecidableRef(ref: string | undefined, ridByDbId: Map<string, string>): boolean {
  if (ref === undefined) return false;
  if (interpolationMode(ref).mode !== 'literal') return false;
  return !ridByDbId.has(ref);
}

/** #1018 — the node ids whose ref at each POSITION is undecidable. One set per
 * position rather than per node, because a node carries up to three refs
 * (`connectionId` OR the M1 pair's two ends, plus `call`) and each is decidable
 * on its own. */
interface NodeRefMasks {
  connection: Set<string>;
  source: Set<string>;
  sink: Set<string>;
  call: Set<string>;
}

/** #1018 — blank the named node's undecidable ref(s) to the shared sentinel.
 * Applied to BOTH sides by node id, so the masked positions cancel and every
 * other field still speaks. A branch node that has no `call` where the stored one
 * did is left alone — that is a real structural difference, not an undecidable
 * ref; the same reasoning applies to a branch node with no `connectionIds`. */
function maskNode(node: NodeExport, masks: NodeRefMasks): NodeExport {
  let masked = node;
  if (masks.connection.has(node.id)) masked = { ...masked, connectionId: UNDECIDABLE_REF };
  if (masked.connectionIds !== undefined) {
    const pair = masked.connectionIds;
    masked = {
      ...masked,
      connectionIds: {
        source: masks.source.has(node.id) ? UNDECIDABLE_REF : pair.source,
        sink: masks.sink.has(node.id) ? UNDECIDABLE_REF : pair.sink,
      },
    };
  }
  if (masks.call.has(node.id) && masked.call !== undefined) {
    masked = { ...masked, call: { ...masked.call, pipelineVersionId: UNDECIDABLE_REF } };
  }
  return masked;
}

/** #983 — one owned pipeline version, as the reconcile preview needs to see it:
 * which pipeline owns it, and how a branch version compares to its stored form.
 *
 * #1018 turned the precomputed `contentForm` string into a `compare` closure over
 * the stored row and its maps. The comparison is no longer a plain equality on
 * two strings — it has to mask the refs that cannot be judged — and the preview
 * and the apply must not each grow their own copy of that rule, for exactly the
 * reason #983 lifted the form here in the first place. */
export interface OwnedVersionForm {
  pipelineResourceId: string;
  compare: (branch: PipelineVersionExport) => StoredVersionComparison;
}

/**
 * #983 — the owned pipeline VERSIONS named by `versionResourceIds`, keyed by
 * `resourceId`. This is the lookup the reconcile APPLY does inline
 * (`versionRowByRid`), lifted so the read-only PREVIEW can reach the same facts
 * and stop reporting `update` for a version this workspace already holds.
 *
 * Scoped to the ids the caller asks for — in practice the handful the incoming
 * BRANCH names — rather than every version ever authored: the identity walk is
 * the same one `buildOwnerRefMaps` already does, but a content form per owned
 * version would make the cost of previewing grow with a workspace's whole
 * history, for rows no preview will look at. The apply keeps that cost lazy for
 * the same reason.
 *
 * Covers ARCHIVED pipelines' versions too (`listPipelines` is unfiltered), so a
 * version is judged against the row that owns it even when the serialize
 * snapshot omits that row.
 */
export function ownedVersionForms(
  db: Db,
  ownerId: string,
  versionResourceIds: ReadonlySet<string>,
): Map<string, OwnedVersionForm> {
  const forms = new Map<string, OwnedVersionForm>();
  if (versionResourceIds.size === 0) return forms;

  const pipelines = listPipelines(db, ownerId);
  const maps = buildOwnerRefMaps(db, pipelines, listConnections(db, ownerId));
  for (const pipeline of pipelines) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      if (!versionResourceIds.has(version.resourceId)) continue;
      forms.set(version.resourceId, {
        pipelineResourceId: pipeline.resourceId,
        compare: (branch) =>
          compareStoredVersion(version, branch, maps.connectionResourceId, maps.versionResourceId),
      });
    }
  }
  return forms;
}

/**
 * Remaps a LITERAL DB id to a `resourceId` via an owner-scoped map. A `${}`
 * dynamic value is returned unchanged (portable already). `null` stays `null`.
 * A non-null literal absent from the map throws — never a silent `null`.
 */
function remapRef(
  value: string | null | undefined,
  map: Map<string, string>,
  describe: () => UnserializableRefDetail,
): string | null {
  if (value == null) return null;
  if (interpolationMode(value).mode !== 'literal') return value; // dynamic — preserve verbatim
  const resourceId = map.get(value);
  if (resourceId === undefined) throw new UnserializableRefError(describe());
  return resourceId;
}

function remapNode(node: Node, maps: OwnerRefMaps): NodeExport {
  const { connectionId, connectionIds, call, ...rest } = node;
  const mappedConnectionId = remapRef(connectionId, maps.connectionResourceId, () => ({
    ref: 'connection',
    nodeId: node.id,
    danglingId: connectionId!,
  }));

  const exported: NodeExport = { ...rest, connectionId: mappedConnectionId };
  if (connectionIds !== undefined) {
    // M1 (#1104) — each end remapped independently, and a dangling end names
    // WHICH end it is: "node X references a connection that no longer exists"
    // is not actionable on a node that binds two of them.
    exported.connectionIds = {
      source: remapRef(connectionIds.source, maps.connectionResourceId, () => ({
        ref: 'connectionSource',
        nodeId: node.id,
        danglingId: connectionIds.source,
      })),
      sink: remapRef(connectionIds.sink, maps.connectionResourceId, () => ({
        ref: 'connectionSink',
        nodeId: node.id,
        danglingId: connectionIds.sink,
      })),
    };
  }
  if (call) {
    // call.pipelineVersionId is non-nullable; remapRef never returns null for a
    // non-null literal input (it either maps it or throws), so the `!` is sound.
    exported.call = {
      ...call,
      pipelineVersionId: remapRef(call.pipelineVersionId, maps.versionResourceId, () => ({
        ref: 'call',
        nodeId: node.id,
        danglingId: call.pipelineVersionId,
      }))!,
    };
  }
  return exported;
}

function serializePipeline(
  pipeline: Pipeline,
  latest: PipelineVersion,
  maps: OwnerRefMaps,
): ExportEnvelope {
  const versionExport: PipelineVersionExport = {
    ...latest,
    nodes: latest.nodes.map((node) => remapNode(node, maps)),
  };
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'pipeline',
    exportedAt: 0,
    // A workspace-git file preserves refs (nothing is stripped), so nothing
    // needs a connection REBIND on import: strippedConnectionRefs is empty.
    data: PipelineExportDataSchema.parse({
      pipeline,
      versions: [versionExport],
      strippedConnectionRefs: [],
    }),
  });
}

function serializeConnection(connection: Connection): ExportEnvelope {
  const { secretRef, ...rest } = connection;
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'connection',
    exportedAt: 0,
    data: ConnectionExportDataSchema.parse({ ...rest, requiresSecret: secretRef !== null }),
  });
}

/**
 * #3 G5c-2 — EXPORTED (was module-private) so the reconcile APPLY can compute a
 * stored trigger's DB-side content form as `triggerContentForm(serializeTrigger(
 * existing, maps).data)` — the EXACT inverse it is reversing, webhook-secret
 * strip and binding remap included, guaranteed in lockstep with what Commit
 * emits (no parallel reimplementation to drift). For a VALID stored trigger the
 * binding is always in `maps.versionResourceId` (seeded from all versions, incl.
 * archived), so `remapRef` never throws on that path.
 */
/**
 * #1114 (M2) — a dataset, with the connection it lives in remapped from a LOCAL
 * db id to that connection's stable `resourceId`.
 *
 * This remap is the whole reason a dataset goes through `collect` rather than
 * being pushed straight into `files` the way a connection is. Committing
 * `connectionId` verbatim would put one workspace's private key into a shared
 * repo, where it resolves to nothing — or, worse, to a DIFFERENT connection —
 * on import, and nothing would throw (spec §3's finding, one layer up from the
 * node refs it was written about).
 *
 * A dataset's ref is always a literal: unlike a node's `connectionId` it is
 * never a `${}` expression, because a dataset is an address rather than a
 * dispatch. `remapRef` still handles that case correctly; there is simply no
 * interpolation mode to branch on here.
 */
export function serializeDataset(dataset: Dataset, maps: OwnerRefMaps): ExportEnvelope {
  const connectionId = remapRef(dataset.connectionId, maps.connectionResourceId, () => ({
    ref: 'store',
    nodeId: null,
    danglingId: dataset.connectionId,
  }));
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'dataset',
    exportedAt: 0,
    data: DatasetExportDataSchema.parse({ ...dataset, connectionId }),
  });
}

export function serializeTrigger(trigger: Trigger, maps: OwnerRefMaps): ExportEnvelope {
  const webhook = trigger.webhook ? WebhookPublicConfigSchema.parse(trigger.webhook) : null;
  const pipelineVersionId = remapRef(trigger.pipelineVersionId, maps.versionResourceId, () => ({
    ref: 'binding',
    nodeId: null,
    danglingId: trigger.pipelineVersionId!,
  }));
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'trigger',
    exportedAt: 0,
    data: TriggerExportDataSchema.parse({ ...trigger, pipelineVersionId, webhook }),
  });
}

/**
 * Serializes an owner's whole workspace to canonical JSON files (see the module
 * doc). Pure over the DB — no filesystem or git effect; the Commit route writes
 * the returned files. A version-less pipeline (a shell with no committable
 * version yet) is skipped — there is nothing runnable to serialize; its file
 * appears once it has a version.
 *
 * #666 / #3 G5b — an ARCHIVED pipeline (soft-deleted, G5a) is OMITTED, and so
 * is every trigger bound to one of its versions. Git represents archive as file
 * ABSENCE (the G5b reconcile's delete-classification), so leaving an archived
 * pipeline (or its now-disabled dependent trigger) in the serialized set would
 * RESURRECT it on the next Commit → import round-trip. The version ref map is
 * still built over ALL pipelines (incl. archived), so a LIVE pipeline's
 * `call_pipeline` node or a live trigger that references an archived version
 * still remaps faithfully to that version's (real) `resourceId` — the resulting
 * dangling reference on import is G7's "absent → disabled" charter, not a
 * serialize-time drop.
 *
 * #1043 — a resource whose refs cannot be put in resourceId-space is OMITTED
 * from `files` and returned in `unserializable` instead of throwing. The
 * READ-ONLY callers (drift, import-preview, the apply's baseline) use this
 * directly and DISCLOSE what they could not compare; `serializeWorkspace`
 * (the Commit path) wraps it and refuses. See that wrapper for why the write
 * path cannot simply drop the resource, and `collect` below for what is and is
 * not caught.
 */
export function serializeWorkspaceTolerant(
  db: Db,
  ownerId: string,
): { files: WorkspaceFile[]; unserializable: UnserializableResource[] } {
  const allPipelines = listPipelines(db, ownerId);
  const connections = listConnections(db, ownerId);
  const datasets = listDatasets(db, ownerId);
  const triggers = listTriggers(db, { ownerId });
  // Ref map over ALL pipelines (incl. archived) so a live ref to an archived
  // version still resolves (faithful; dangle-on-import is G7's concern).
  const maps = buildOwnerRefMaps(db, allPipelines, connections);

  // Every version DB id that belongs to an archived pipeline — used to omit the
  // archived pipelines themselves and their dependent triggers.
  const archivedVersionIds = new Set<string>();
  for (const pipeline of allPipelines) {
    if (!pipeline.archived) continue;
    for (const version of listPipelineVersions(db, pipeline.id)) {
      archivedVersionIds.add(version.id);
    }
  }

  const livePipelines = allPipelines.filter((pipeline) => !pipeline.archived);
  // A trigger concretely bound to an archived pipeline's version is omitted
  // alongside it (a `null`/`${}` dynamic binding never matches a DB version id,
  // so it is kept). Slug-collision suffixing is computed over the EMITTED sets
  // only, so an archived resource can never perturb a kept resource's path.
  const liveTriggers = triggers.filter(
    (trigger) =>
      trigger.pipelineVersionId === null || !archivedVersionIds.has(trigger.pipelineVersionId),
  );

  const files: WorkspaceFile[] = [];
  const unserializable: UnserializableResource[] = [];

  /** Serialize one resource into `files`, or record it as unserializable.
   *
   * Only an `UnserializableRefError` is caught. Anything else — a Zod failure on
   * a row the current schema no longer validates, say — propagates: swallowing
   * it would report a dangling ref that was never the problem, which is the same
   * manufactured-fact defect this ticket exists to remove. */
  const collect = (
    identity: Pick<UnserializableResource, 'kind' | 'resourceId' | 'name'>,
    path: string,
    serialize: () => ExportEnvelope,
  ) => {
    try {
      files.push({ path, contents: canonicalStringify(serialize()) });
    } catch (err) {
      if (!(err instanceof UnserializableRefError)) throw err;
      unserializable.push({ ...err.detail, ...identity, path });
    }
  };

  // #1043 — paths are assigned over the FULL live set, deliberately BEFORE any
  // offender is dropped. `resourceFilePaths` suffixes a colliding slug with the
  // resourceId, counted over the set it is given: computing it over the kept
  // subset would let one pipeline's dangling ref silently move an UNRELATED
  // same-named pipeline from `report-<rid>.json` back to `report.json`, which
  // drift would then report as a rename nobody performed.
  // #1112 (M2, data-movement spec §2.3) — the per-kind emitters as an EXHAUSTIVE
  // `Record<ResourceKind, …>`, iterated in `RESOURCE_KINDS` order (the order the
  // three blocks already ran in, so the emitted `files` order is unchanged).
  //
  // This is the worst of the five silent sites the spec measured: a kind missing
  // from a spelled-out list compiles clean and is then simply NEVER COMMITTED to
  // git. Worse than a no-op — Commit's managed-dir reconcile stages the removal
  // of every previously committed managed file and re-adds only what this
  // returns (`routes/workspace-git.ts`), so a silently-skipped kind is committed
  // as a DELETION of every resource of that kind from the branch.
  //
  // The blocks keep their existing asymmetry deliberately: pipelines and
  // triggers go through `collect` (their serializers call `remapRef` and can
  // throw `UnserializableRefError`), while a connection is pushed directly
  // because `serializeConnection` holds no refs and so has no failure to catch.
  const emitters: Record<ResourceKind, () => void> = {
    pipeline: () => {
      const pipelinePaths = resourceFilePaths(
        'pipeline',
        livePipelines.map((p) => ({ resourceId: p.resourceId, name: p.name })),
      );
      for (const pipeline of livePipelines) {
        const latest = getLatestPipelineVersion(db, pipeline.id);
        if (!latest) continue;
        collect(
          { kind: 'pipeline', resourceId: pipeline.resourceId, name: pipeline.name },
          pipelinePaths.get(pipeline.resourceId)!,
          () => serializePipeline(pipeline, latest, maps),
        );
      }
    },
    connection: () => {
      const connectionPaths = resourceFilePaths(
        'connection',
        connections.map((c) => ({ resourceId: c.resourceId, name: c.name })),
      );
      for (const connection of connections) {
        files.push({
          path: connectionPaths.get(connection.resourceId)!,
          contents: canonicalStringify(serializeConnection(connection)),
        });
      }
    },
    // #1114 (M2) — a dataset goes through `collect`, like pipelines and
    // triggers and unlike connections: `serializeDataset` remaps the store ref
    // and so CAN throw `UnserializableRefError`. A dataset whose connection was
    // hard-deleted is therefore disclosed as unserializable rather than
    // committed with a dangling id — which is the whole point of the ref living
    // in a typed field instead of inside the opaque `config` blob.
    dataset: () => {
      const datasetPaths = resourceFilePaths(
        'dataset',
        datasets.map((d) => ({ resourceId: d.resourceId, name: d.name })),
      );
      for (const dataset of datasets) {
        collect(
          { kind: 'dataset', resourceId: dataset.resourceId, name: dataset.name },
          datasetPaths.get(dataset.resourceId)!,
          () => serializeDataset(dataset, maps),
        );
      }
    },
    trigger: () => {
      const triggerPaths = resourceFilePaths(
        'trigger',
        liveTriggers.map((t) => ({ resourceId: t.resourceId, name: t.name })),
      );
      for (const trigger of liveTriggers) {
        // A trigger's binding has no producer for this state — `triggers.
        // pipeline_version_id` is `onDelete: 'cascade'` (db/schema.ts), so deleting
        // the pipeline takes the trigger with it. It goes through the same seam for
        // uniformity, and to keep the write path fail-closed if that FK ever
        // changes; there is deliberately no test asserting a dangling binding,
        // because nothing can produce one.
        collect(
          { kind: 'trigger', resourceId: trigger.resourceId, name: trigger.name },
          triggerPaths.get(trigger.resourceId)!,
          () => serializeTrigger(trigger, maps),
        );
      }
    },
  };

  for (const kind of RESOURCE_KINDS) emitters[kind]();

  return { files, unserializable };
}

/**
 * The COMMIT-path serialize: every file, or a refusal naming every resource that
 * could not be put in resourceId-space.
 *
 * #1043 — refusing is the right polarity here and it is NOT merely "safer than
 * dropping". Commit's managed-dir reconcile stages the removal of every
 * previously committed managed file and re-adds only what this returns
 * (`routes/workspace-git.ts`), so quietly omitting an offender would commit it
 * as a DELETION of that pipeline from the branch — losing it from git over a
 * dangling ref in one node. Writing it is not an option either (a commit must
 * not emit a dangling ref). So the whole Commit refuses, by name, with the
 * remedy: re-point or remove the node and Save, which mints a fresh head.
 */
export function serializeWorkspace(db: Db, ownerId: string): WorkspaceFile[] {
  const { files, unserializable } = serializeWorkspaceTolerant(db, ownerId);
  if (unserializable.length > 0) throw new WorkspaceSerializeError(unserializable);
  return files;
}
