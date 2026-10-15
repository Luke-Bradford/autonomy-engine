import type { Node } from '../schemas/pipeline.js';
import { protectEscapes, scanTemplateRefs } from '../engine/expr.js';
import { copyFilesConfigSchema } from './copy-files-config.js';
import { getActivity } from './registry.js';
import {
  COPY_FILES_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
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
 *   `connectionIds`, datasets, a call);
 * - its destination is wholly an expression, which could resolve to an absolute
 *   path that `sinkFileName` refuses;
 * - the lowered config does not pass `copy_files`' schema (a half-filled node).
 *
 * PURE and copy-on-write: an unchanged node is returned by reference.
 */
export interface RetiredLowering {
  /** The type the retired node becomes. */
  to: string;
  /**
   * §8's output aliases: each retired output name → the replacement's output
   * that answers it. A test checks every retired name is here and exists on
   * the replacement with the same type.
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
 * outside every `${…}`, so `${dir}/out.csv` splits and `out/${name}` does too.
 * `undefined` when no such `/` exists and the path holds an expression: a
 * whole-expression destination may be absolute or relative, which only the
 * run knows.
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
  if (cut === -1) {
    return matches.length === 0 ? { folder: undefined, name: dest } : undefined;
  }
  const folder = unprotect(s.slice(0, cut));
  return { folder: folder === '' ? '/' : folder, name: unprotect(s.slice(cut + 1)) };
}

/** `file_copy` and `file_move` → Copy · Files as-is, one file, After copy Keep or Delete source. */
function lowerFileTransfer(afterCopy: 'keep' | 'delete') {
  return (node: Node): Node | undefined => {
    if (
      node.connectionParams !== undefined ||
      node.connectionIds !== undefined ||
      node.datasetIds !== undefined ||
      node.datasetParams !== undefined ||
      node.call !== undefined
    ) {
      return undefined;
    }
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
    config['outputs'] = replacement.outputs.map((o) => ({ ...o }));
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
};

/** Present every retired-type node that can be lowered faithfully as its replacement. */
export function lowerRetiredTypes(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    const lowering = Object.hasOwn(RETIRED_LOWERINGS, node.type)
      ? RETIRED_LOWERINGS[node.type]
      : undefined;
    return lowering?.lower(node) ?? node;
  });
}
