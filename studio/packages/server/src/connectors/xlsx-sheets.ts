import pLimit from 'p-limit';
import { type DatasetSheetsResult } from '@autonomy-studio/shared';
import { confineFsPath, openConfinedFd } from './confine.js';
import { listXlsxSheetNames } from './xlsx-read.js';

/**
 * #1218 — "what does this workbook hold", asked at AUTHORING time.
 *
 * An `excel` dataset must name exactly one of `sheet` or `sheetIndex`, and
 * neither is defaulted, for a reason §2.6 records: two sheets of one workbook
 * routinely share column names (`Jan`, `Feb`), so guessing the first would copy
 * the wrong month and SUCCEED. The cost was that the operator typed the name
 * blind into a free-text box. `listXlsxSheetNames` has been able to answer this
 * since #1213 and had no production caller; this module is that caller.
 *
 * THERE IS DELIBERATELY NO `${}` BRANCH HERE, and #1218 asked for one. Its
 * premise was measured and is FALSE: a dataset's `config` reaches the reader
 * VERBATIM (`excel-io.ts`'s `prepareRead` takes `read.datasetConfig`, handed to
 * it by `copy-sink.ts` and `postgres.ts` straight off `dataset.config`), so
 * nothing substitutes a dataset `path`, and a `${` in one is simply part of a
 * filename. The literal-only rule that DOES exist (`datamove/
 * dataset-references.ts`) governs a NODE's dataset REF — a different field on a
 * different resource. Refusing such a path here would make the picker disagree
 * with the runtime: it would decline to inspect a workbook a run opens without
 * complaint. The degrade case the ticket was really describing is a file that is
 * not there YET, and that one is real — it arrives as the ENOENT refusal below.
 *
 * THE CONTRACT IS THAT IT NEVER THROWS, and that is not politeness — it is what
 * makes the route renderable. Every way this fails is an ordinary authoring
 * condition (the path is half-typed, the file is not there yet, the workbook is
 * not a workbook), so each arrives as `{ ok: false, error }` and the form shows
 * all of them in one place. `probe.ts` holds the same discipline for the same
 * reason.
 *
 * WHAT BOUNDS IT. The path is operator-supplied, so this is a real surface:
 *   - confinement against the bound connection's own `roots`, plus `O_NOFOLLOW`
 *     — `confineFsPath` then `openConfinedFd`, the same pair the reader uses and
 *     deliberately not a second copy of it (§8);
 *   - the read itself is `xl/workbook.xml` ALONE, capped by
 *     `XLSX_MAX_SMALL_PART_BYTES` (16 MiB). `readWorkbookIndex`'s docblock has
 *     the argument: `walkXml` parses synchronously, so a backstop timer could
 *     not interrupt a hostile 64 MiB shared-string table anyway, and reading
 *     less is the only bound that actually holds. This is why there is no
 *     `PROBE_BACKSTOP_MS` analogue here;
 *   - {@link SHEETS_CONCURRENCY} bounds descriptors and resident memory, which
 *     is what a concurrency cap can honestly claim here — NOT CPU, since the
 *     parse is synchronous and four callers serialise on the event loop regardless.
 */

/**
 * How many workbooks may be open at once. `PROBE_CONCURRENCY`'s value and its
 * reason: a bound on descriptors and buffers, not on anything the event loop
 * would have interleaved anyway.
 */
const SHEETS_CONCURRENCY = 4;
const limit = pLimit(SHEETS_CONCURRENCY);

export interface ListSheetsArgs {
  /** The connection the dataset is bound to — its KIND and `config` only; this
   *  never sees a secret, and an `fs` connection carries none. */
  readonly connection: { readonly kind: string; readonly config: unknown };
  /** The path exactly as the operator typed it. */
  readonly path: string;
  readonly signal?: AbortSignal | undefined;
}

const refuse = (error: string): DatasetSheetsResult => ({ ok: false, error });

export async function listSheetsForConnection(args: ListSheetsArgs): Promise<DatasetSheetsResult> {
  // Ordered so that nothing is OPENED until everything cheap has agreed. The
  // suite asserts `openConfinedFd` was not reached on each of these branches,
  // which is the only way that ordering stays true as the module grows.
  if (args.connection.kind !== 'fs') {
    return refuse(
      `an excel dataset lives in an fs connection; this one is a '${args.connection.kind}' connection`,
    );
  }

  const confined = await confineFsPath(args.connection.config, args.path);
  if (!confined.ok) return refuse(confined.error);

  return limit(async () => {
    // `openConfinedFd` leaves its `open()` OUTSIDE the try, so every errno
    // propagates and only "not a regular file" returns. ENOENT is this route's
    // most ordinary outcome — the file an upstream node has not written yet, or
    // a half-typed path — so unwrapped it would be a 500 on the common case.
    let opened: Awaited<ReturnType<typeof openConfinedFd>>;
    try {
      opened = await openConfinedFd(confined.path);
    } catch {
      // The errno is deliberately not echoed: it adds nothing an author can act
      // on and it is the same disclosure `confineFsPath` declines to make.
      return refuse(`'${args.path}' could not be opened`);
    }
    if (!opened.ok) return refuse(opened.error);

    try {
      // The REQUESTED path, not `confined.path`: every `XlsxReadError` embeds it,
      // and `resolveWithinRoots` quotes `requested` in its own refusals, so the
      // sentences match and no canonicalised `/private/var/...` leaks into one.
      // The descriptor is what actually opens the container — ownership
      // transfers to `openZip`, which closes it in its own `finally`.
      const sheets = await listXlsxSheetNames(args.path, {
        fd: opened.fd,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      return { ok: true, sheets: [...sheets] };
    } catch (err) {
      return refuse(err instanceof Error ? err.message : `'${args.path}' could not be read`);
    }
  });
}
