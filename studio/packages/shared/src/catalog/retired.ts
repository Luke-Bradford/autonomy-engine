import type { Container, Node } from '../schemas/pipeline.js';
import { protectEscapes, scanTemplateRefs } from '../engine/expr.js';
import { renameNodeOutputRefs } from '../engine/nodeRefs.js';
import { copyFilesConfigSchema } from './copy-files-config.js';
import { deleteConfigSchema } from './delete-config.js';
import { getMetadataConfigSchema } from './get-metadata-config.js';
import { catalogOutputs } from './lower.js';
import { getActivity } from './registry.js';
import {
  HTTP_SECRET_HEADERS_FIELD,
  WEB_MAX_RESPONSE_BYTES,
  webConfigSchema,
} from './web-config.js';
import {
  COPY_FILES_ACTIVITY_TYPE,
  DELETE_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  GET_METADATA_ACTIVITY_TYPE,
  HTTP_REQUEST_ACTIVITY_TYPE,
  WEB_ACTIVITY_TYPE,
} from './types.js';

/**
 * #1600 OR41 C1b — the activity catalogue's §8 lowerings: a stored node of a
 * RETIRED type, presented as its replacement. One entry per retired type; the
 * later slices (C7–C12) add theirs here.
 *
 * ## Where it runs, and where it does not
 *
 * Only on the web canvas's LOAD (`canvasStore.loadVersion`), so the author sees
 * the one Copy and the next Save writes it — §8's "the saved document is not
 * rewritten until the author saves it again". It is deliberately NOT part of
 * `lowerPipelineNodes`, which the server also runs on every write: that path
 * mints rows for workspace-git apply and portable import too, which keep a
 * file's version id and re-mint history. Lowering there would make a re-pulled
 * branch file differ from its own stored row and change what an imported OLD
 * version does. The server keeps accepting the retired types, which still run.
 *
 * A stored version keeps its type and dispatches through that type's own arm,
 * so an old version runs exactly as it did. Dispatching it as `copy_files`
 * would change four results (the catalogue doc's §8 lists them), and §8 says a
 * lowering must not change a running pipeline's result.
 *
 * ## Fail-safe
 *
 * A node is lowered only when the lowering is faithful. Otherwise it is
 * returned unchanged, still a valid runnable node of its retired type:
 * - it carries something a paired node refuses (`connectionParams`,
 *   `connectionIds`, datasets, a call). #1600 C11b — Web is a single-connection
 *   node, as `http_request` is, so it keeps `connectionParams`;
 * - its destination splits in a way only the run could judge (`splitDestination`);
 * - the lowered config does not pass its replacement's schema (a half-filled node);
 * - #1600 C8b — an output it renames (`entries` → `childItems`) is read
 *   somewhere the rename cannot rewrite faithfully (`renameNodeOutputRefs`).
 *
 * PURE and copy-on-write: an unchanged node is returned by reference.
 */
export interface RetiredLowering {
  /** The type the retired node becomes. */
  to: string;
  /**
   * §8's output aliases: each retired output name → the replacement's output
   * that answers it. A test checks every retired name is here and exists on
   * the replacement with the same type. Where a name changes, every
   * `${nodes.<id>.output.<old>}` in the doc is rewritten to the new one as the
   * node is lowered (`lowerRetiredTypes`).
   */
  outputs: Readonly<Record<string, string>>;
  /** The lowered node, or `undefined` when it cannot be lowered faithfully. */
  lower: (node: Node) => Node | undefined;
}

/** `protectEscapes`' sentinel for a `$${` escape, put back AS WRITTEN (not as the `${` it evaluates to). */
const ESCAPE = protectEscapes('$${');
const unprotect = (s: string) => s.split(ESCAPE).join('$${');

/**
 * Split a destination path into its folder and its file name at the last `/`
 * outside every `${…}`: `/data/${day}/out.csv` and `report_${day}.csv` split.
 *
 * `undefined` where only the run could say what the split means, so the node
 * stays its retired type:
 * - the file name BEGINS with an expression (`out/${name}`, `${dest}`): it may
 *   resolve to an absolute path, or to a number (a whole `${}` keeps its type),
 *   which *File name* refuses where the old string join wrote it;
 * - the folder is ONE bare expression (`${dir}/a.csv`): it may resolve empty
 *   or to a number, where the old join made `/a.csv` or `5/a.csv`.
 */
export function splitDestination(
  dest: string,
): { folder: string | undefined; name: string } | undefined {
  const s = protectEscapes(dest);
  const { matches, unterminatedAt } = scanTemplateRefs(s);
  if (unterminatedAt !== null) return undefined;
  const inside = (i: number) => matches.some((m) => i >= m.start && i <= m.end);
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] === '/' && !inside(i)) {
      cut = i;
      break;
    }
  }
  const startsWithRef = (from: number) => matches.some((m) => m.start === from);
  if (startsWithRef(cut + 1)) return undefined;
  if (cut === -1) return { folder: undefined, name: unprotect(s) };
  if (matches.some((m) => m.start === 0 && m.end === cut - 1)) return undefined;
  const folder = unprotect(s.slice(0, cut));
  return { folder: folder === '' ? '/' : folder, name: unprotect(s.slice(cut + 1)) };
}

/** Anything a single-connection replacement would refuse or a lowering would drop. */
const carriesUnlowerable = (node: Node) =>
  node.connectionParams !== undefined ||
  node.connectionIds !== undefined ||
  node.datasetIds !== undefined ||
  node.datasetParams !== undefined ||
  node.inlineDatasets !== undefined ||
  node.call !== undefined;

/** `file_copy` and `file_move` → Copy · Files as-is, one file, After copy Keep or Delete source. */
function lowerFileTransfer(afterCopy: 'keep' | 'delete') {
  return (node: Node): Node | undefined => {
    if (carriesUnlowerable(node)) return undefined;
    const { source, dest } = node.config;
    if (typeof source !== 'string' || typeof dest !== 'string') return undefined;
    const split = splitDestination(dest);
    if (split === undefined) return undefined;
    const config: Record<string, unknown> = {
      pathType: 'file',
      sourcePath: source,
      ...(split.folder === undefined ? {} : { sinkFolder: split.folder }),
      sinkFileName: split.name,
      afterCopy,
      // `file_copy` and `file_move` both replace an existing destination.
      ifExists: 'overwrite',
    };
    if (!copyFilesConfigSchema.safeParse(config).success) return undefined;
    const replacement = getActivity(COPY_FILES_ACTIVITY_TYPE);
    if (replacement === undefined) return undefined;
    // The replacement's contract, deep-copied: every retired output name is in
    // it (`RETIRED_LOWERINGS[*].outputs`), so a `${nodes.x.output.dest}` still
    // resolves.
    config['outputs'] = catalogOutputs(replacement);
    const { connectionId, ...rest } = node;
    return {
      ...rest,
      type: COPY_FILES_ACTIVITY_TYPE,
      config,
      ...(connectionId === undefined
        ? {}
        : { connectionIds: { source: connectionId, sink: connectionId } }),
    };
  };
}

/**
 * A retired node with one `path` on its one connection → `to`, the same node
 * with `config(path)` as its config: the shape `file_list` and `file_delete`
 * share. Undefined where the config fails `to`'s schema.
 */
function lowerPathNode(
  to: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  build: (path: string) => Record<string, unknown>,
) {
  return (node: Node): Node | undefined => {
    if (carriesUnlowerable(node)) return undefined;
    const { path } = node.config;
    if (typeof path !== 'string') return undefined;
    const config = build(path);
    if (!schema.safeParse(config).success) return undefined;
    const replacement = getActivity(to);
    if (replacement === undefined) return undefined;
    config['outputs'] = catalogOutputs(replacement);
    return { ...node, type: to, config };
  };
}

/**
 * #1600 C8b — `file_list` → Get metadata · Child items, on the same connection
 * and path. Get metadata's child item defaults (Filter `*`, which matches a
 * dotfile, and All entries, no modified window) list what List directory
 * listed. The `entries` → `childItems` rename is `lowerRetiredTypes`' job.
 */
const lowerFileList = lowerPathNode(
  GET_METADATA_ACTIVITY_TYPE,
  getMetadataConfigSchema,
  (path) => ({
    path,
    fieldList: ['childItems'],
  }),
);

/**
 * #1600 C9b — `file_delete` → Delete on the same connection and path, Path type
 * File, with Fail if nothing matched on: Delete file failed on a missing file,
 * and Delete's defaults (every modification time, one at a time) delete what it
 * deleted. `path` keeps its name. The run differences are in the catalogue's
 * §4.4.
 */
const lowerFileDelete = lowerPathNode(DELETE_ACTIVITY_TYPE, deleteConfigSchema, (path) => ({
  pathType: 'file',
  path,
  failIfNothingMatched: true,
}));

/** HTTP request's methods that send no body: it fails such a node that carries one. */
const BODILESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The config keys HTTP request reads, and its contract. */
const HTTP_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'url',
  'method',
  'headers',
  'body',
  HTTP_SECRET_HEADERS_FIELD,
  'outputs',
]);

/**
 * #1600 C11b — `http_request` → Web on the same connection, with Fail on HTTP
 * error off (a 4xx or 5xx still succeeds, read from `status`) and Parse as Text
 * (`body` stays the string it was), §8. Max size is the connections' read
 * ceiling, the closest to HTTP request's unbounded read: ADF's 4 MiB default is
 * a new node's. The method is upper-cased, as Web offers only the six upper-case
 * names. The run differences are in the catalogue's §4.6.
 *
 * Stays HTTP request where Web would change the result:
 * - a method outside Web's six, or an expression (only the run knows it);
 * - a body on GET or HEAD, even an empty one: HTTP request fails that node at
 *   every run, where Web sends `''` as no body and succeeds.
 * - a contract (`config.outputs`) declaring an output Web has no name for: the
 *   lowered node takes Web's contract, so a reader of that output would no
 *   longer resolve;
 * - a key HTTP request never read that is one of Web's settings (`parseAs`,
 *   `successStatusCodes`, …): Web would act on it.
 *
 * Any other key is carried over as it is, as the config form keeps a key it
 * has no control for: an API-authored or imported doc may hold one this build
 * does not know.
 */
function lowerHttpRequest(node: Node): Node | undefined {
  // Not `carriesUnlowerable`: Web binds one connection, so `connectionParams`
  // apply to it exactly as they did to HTTP request.
  if (
    node.connectionIds !== undefined ||
    node.datasetIds !== undefined ||
    node.datasetParams !== undefined ||
    node.inlineDatasets !== undefined ||
    node.call !== undefined
  ) {
    return undefined;
  }
  const replacement = getActivity(WEB_ACTIVITY_TYPE);
  if (replacement === undefined) return undefined;
  const { url, method, headers, body, outputs } = node.config;
  if (Array.isArray(outputs)) {
    const names = new Set(replacement.outputs.map((o) => o.name));
    const webHas = (o: unknown) =>
      typeof o === 'object' && o !== null && 'name' in o && names.has(o.name as string);
    if (!outputs.every(webHas)) return undefined;
  }
  const secretHeaders = node.config[HTTP_SECRET_HEADERS_FIELD];
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.config)) {
    if (HTTP_REQUEST_KEYS.has(key)) continue;
    if (Object.hasOwn(webConfigSchema.shape, key)) return undefined;
    unknown[key] = value;
  }
  if (method !== undefined && typeof method !== 'string') return undefined;
  const upper = method === undefined ? 'GET' : method.toUpperCase();
  if (BODILESS_METHODS.has(upper) && body !== undefined) return undefined;
  const config: Record<string, unknown> = {
    ...unknown,
    url,
    method: upper,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(secretHeaders === undefined ? {} : { [HTTP_SECRET_HEADERS_FIELD]: secretHeaders }),
    failOnHttpError: false,
    parseAs: 'text',
    maxResponseBytes: WEB_MAX_RESPONSE_BYTES,
  };
  // Refuses a missing or empty URL, and a method that is not one of the six
  // (an expression, OPTIONS, one with spaces).
  if (!webConfigSchema.safeParse(config).success) return undefined;
  config['outputs'] = catalogOutputs(replacement);
  return { ...node, type: WEB_ACTIVITY_TYPE, config };
}

export const RETIRED_LOWERINGS: Readonly<Record<string, RetiredLowering>> = {
  [FILE_COPY_ACTIVITY_TYPE]: {
    to: COPY_FILES_ACTIVITY_TYPE,
    outputs: { bytesWritten: 'bytesWritten', source: 'source', dest: 'dest' },
    lower: lowerFileTransfer('keep'),
  },
  [FILE_MOVE_ACTIVITY_TYPE]: {
    to: COPY_FILES_ACTIVITY_TYPE,
    outputs: { source: 'source', dest: 'dest' },
    lower: lowerFileTransfer('delete'),
  },
  [FILE_LIST_ACTIVITY_TYPE]: {
    to: GET_METADATA_ACTIVITY_TYPE,
    outputs: { entries: 'childItems', path: 'path' },
    lower: lowerFileList,
  },
  [FILE_DELETE_ACTIVITY_TYPE]: {
    to: DELETE_ACTIVITY_TYPE,
    outputs: { path: 'path' },
    lower: lowerFileDelete,
  },
  [HTTP_REQUEST_ACTIVITY_TYPE]: {
    to: WEB_ACTIVITY_TYPE,
    // Web's `body` is json, which types as `any`, so a read typed against
    // HTTP request's string still types.
    outputs: { status: 'status', body: 'body', headers: 'headers' },
    lower: lowerHttpRequest,
  },
};

/**
 * Present every retired-type node that can be lowered faithfully as its
 * replacement, across a whole doc: an output it renames is read from other
 * nodes and from containers (a ForEach's `items`, a loop's `exitWhen`).
 *
 * Each node's rewrite is all or nothing. It runs over the doc as already
 * lowered, so a later node sees an earlier one's renames, and if any read of the
 * node cannot be rewritten, the node and every reader of it stay as they were.
 * A `description` is prose and never evaluated, so it is not rewritten (the
 * same exclusion as a pasted node's).
 */
export function lowerRetiredTypes<D extends { nodes: Node[]; containers: Container[] }>(doc: D): D {
  let { nodes, containers } = doc;
  // By index over the CURRENT doc, not `doc.nodes`: an earlier node's rename may
  // already have rewritten this one, and lowering the original would undo it.
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as Node;
    const lowering = Object.hasOwn(RETIRED_LOWERINGS, node.type)
      ? RETIRED_LOWERINGS[node.type]
      : undefined;
    const lowered = lowering?.lower(node);
    if (lowering === undefined || lowered === undefined) continue;
    let next = nodes.map((n, j) => (j === i ? lowered : n));
    let nextContainers = containers;
    const renames = new Map(Object.entries(lowering.outputs).filter(([from, to]) => from !== to));
    if (renames.size > 0) {
      const renamed = renameReads(next, containers, node.id, renames);
      if (renamed === undefined) continue;
      [next, nextContainers] = renamed;
    }
    nodes = next;
    containers = nextContainers;
  }
  return nodes === doc.nodes && containers === doc.containers ? doc : { ...doc, nodes, containers };
}

/** `renameNodeOutputRefs` over every node and container, `description` aside; `undefined` if any refuses. */
function renameReads(
  nodes: Node[],
  containers: Container[],
  id: string,
  renames: ReadonlyMap<string, string>,
): [Node[], Container[]] | undefined {
  const one = <T extends { description?: string | undefined }>(item: T): T | undefined => {
    const { description, ...rest } = item;
    const out = renameNodeOutputRefs(rest, id, renames);
    if (out === undefined) return undefined;
    if (out === rest) return item;
    return (description === undefined ? out : { ...out, description }) as T;
  };
  const outNodes: Node[] = [];
  for (const n of nodes) {
    const r = one(n);
    if (r === undefined) return undefined;
    outNodes.push(r);
  }
  const outContainers: Container[] = [];
  for (const c of containers) {
    const r = one(c);
    if (r === undefined) return undefined;
    outContainers.push(r);
  }
  return [outNodes, outContainers];
}
