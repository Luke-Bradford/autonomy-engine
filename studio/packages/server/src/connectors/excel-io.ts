import { stat } from 'node:fs/promises';
import {
  excelDatasetConfigSchema,
  formatZodIssues,
  type CoercionOptions,
  type DatasetAddress,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { openConfinedFd, resolveWithinRoots } from './confine.js';
import { DatasetIoError } from './dataset-io-error.js';
import { classifyFsError, fsConnectionConfigSchema, isAbortError } from './fs-connection.js';
import { yieldToEventLoop } from './scheduling.js';
import { headerNames, noRowsError, positionalNames } from './source-columns.js';
import { readXlsxRowBatches, XlsxReadError, type XlsxCell, type XlsxRow } from './xlsx-read.js';
import { COPY_BATCH_ROWS } from '../limits.js';

/**
 * #996 M11 slice 2 (#1215) — the READER for an `excel` dataset over an `fs`
 * connection: `delimited-io.ts`'s shape, pointed at a workbook.
 *
 * Slice 1 (#1213) built the container + sheet grammar in `xlsx-read.ts` — no
 * confinement, no dataset config, no `CopyIo` — and shipped with NO PRODUCTION
 * CALLER on purpose. This module is that caller, and the binding and the reader
 * land in one commit because M5's four-way split exists for exactly that: a
 * catalog entry without a resolved dispatch path is a user-visible activity
 * that always fails.
 *
 * ── WHAT THIS OWNS THAT `xlsx-read.ts` DOES NOT ─────────────────────────────
 *
 * **1. Confinement.** `resolveWithinRoots` then `openConfinedFd` — the raw
 * descriptor exists because `yauzl` opens the file ITSELF given a path, which
 * `confine.ts`'s docblock names as the case its `lstat` cannot cover. Ownership
 * of the descriptor TRANSFERS to `readXlsxRowBatches`; see {@link openSheet}.
 *
 * **2. Naming**, from the sheet's own rows. `xlsx-read.ts` yields positional
 * rows and never names them, on the same argument `delimited`'s grammar makes.
 * The four naming RULES (duplicate refusal, interior-empty refusal, trailing
 * trim, `column1..N`) are `source-columns.ts`'s, shared with `delimited-io.ts`
 * rather than re-worded here.
 *
 * **3. The row policy**, and it is where the two readers genuinely differ — see
 * {@link bindExcelRow} and {@link isBlankRow}.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT OWN ─────────────────────────────────────
 *
 * `nullValue` and `dateFormat` are NOT applied here, exactly as `delimited-io`
 * does not apply them: they are `CoercionOptions` the pump applies before type
 * dispatch, and {@link excelCoercionFor} is the projection they travel through.
 * Doing it here would also make `bytesRead` under-count, for that module's
 * stated reason.
 *
 * `<dimension ref="A1:D100">` is IGNORED, and by construction rather than
 * oversight: `xlsx-read.ts` has no handler for it, so a width comes only from
 * cells that actually arrive. That is the safe direction — a declared range is
 * a hint writers get wrong, and honouring it could pad a row with columns no
 * cell backs or truncate one that a cell does.
 *
 * ── SECURITY (§8) ──────────────────────────────────────────────────────────
 *
 * The path is confined through the ONE shared guard and the file is opened
 * `O_NOFOLLOW`. BOTH configs are re-validated here rather than threaded in
 * pre-parsed: `routes/datasets.ts` and `routes/connections.ts` store `config`
 * verbatim, so "a file-backed dataset must re-validate at dispatch and must not
 * assume the stored connection is well-formed". Every bound on untrusted bytes
 * (`XLSX_MAX_*`) is slice 1's and already shipped; this slice adds no new
 * parsing of attacker-controlled input. No message here echoes a cell VALUE —
 * `coerce.ts`'s non-echoing rule, because §6.1 can resolve a SECRET into a
 * source value.
 */

/** What one `excel` dataset read needs to know. */
export interface ExcelDatasetRead {
  /** The `fs` connection's stored config — RE-PARSED here, never trusted (§8). */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** Rows per yielded batch, and per event-loop yield. Defaults to `COPY_BATCH_ROWS`. */
  readonly batchRows?: number;
  /** Honoured at every batch boundary and inside the reader's own chunk loop. */
  readonly signal?: AbortSignal;
}

/** The parsed `excel` dataset config — §2.6's row, defaults applied. */
type ExcelConfig = ReturnType<typeof excelDatasetConfigSchema.parse>;

/**
 * Map any throw to a `DatasetIoError` carrying a real failure `kind`.
 *
 * The arm ORDER is the contract rather than a preference — see the comments in
 * the body, which is where the reasoning has to survive an edit.
 *
 * The `XlsxReadError` arm reads `err.permanent` rather than hardcoding
 * `'permanent'`. Every code the reader raises today IS permanent, so this
 * changes no behaviour — but hardcoding it would make that flag decorative, and
 * #1216 kept it precisely because it answers a different question from `code`.
 *
 * The `code` decides WHICH THING THE SENTENCE NAMES, which is the whole reason
 * #1216 exists: a refusal about the dataset's own CONFIG must point at the key
 * an operator can fix, and one about the file must name the file. Deciding that
 * by matching on `.message` is the drift the bounded code replaces.
 */
function readFailure(
  err: unknown,
  signal: AbortSignal | undefined,
  subject: string,
): DatasetIoError {
  // An error this module already classified is trusted, on `delimited-io`'s
  // ordering: it was raised with the facts to hand.
  if (err instanceof DatasetIoError) return err;
  // THEN the abort arm, and its position ahead of `XlsxReadError` is the
  // contract rather than a preference. `xlsx-read.ts`'s `entryChunks` re-throws
  // only errors whose `name` is `AbortError` and WRAPS everything else, so a
  // cancel that surfaced as an errno — an `EBADF` on a handle closed out from
  // under an in-flight read is the ordinary way — would arrive here already
  // wrapped, and the arm below would call it `permanent`. §10 turns on the
  // opposite ("`cancelled` never retries"), and `classifyFsError`'s docblock
  // states the abort arm is part of the contract and names `fs.ts` as always
  // having checked it first.
  if (isAbortError(err, signal)) {
    return new DatasetIoError('cancelled', 'dataset read aborted', { cause: err });
  }
  if (err instanceof XlsxReadError) {
    const kind = err.permanent ? 'permanent' : 'transient';
    const context =
      err.code === 'no_such_sheet' || err.code === 'bad_option'
        ? "this dataset's config does not fit the workbook"
        : `${subject} could not be read`;
    return new DatasetIoError(kind, `${context}: ${err.message}`, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(classifyFsError(err, signal), `${subject}: ${message}`, { cause: err });
}

/**
 * Validate both configs and confine the path — everything decidable before a
 * byte is read.
 *
 * The kind guard is the literal `'excel'` and NOT `datasetKindIsImplemented`,
 * on `delimited-io.ts`'s argument, which this slice makes sharper rather than
 * weaker: as of M11 that set spans ALL FOUR kinds across two stores, so a store
 * consulting it would accept a `table` dataset it cannot read. The refusal
 * names THIS READER rather than the store, because by the time control is here
 * `fs.ts`'s fork has already chosen — a caller that arrived with a `delimited`
 * dataset has a routing fault, not a store one. The store-level sentence (for a
 * kind NEITHER fs reader handles) is `fs-connection.ts`'s `notAnFsKind`.
 */
async function prepareRead(read: ExcelDatasetRead): Promise<{
  readonly path: string;
  readonly config: ExcelConfig;
}> {
  if (read.datasetKind !== 'excel') {
    throw new DatasetIoError(
      'permanent',
      `the excel reader reads 'excel' datasets; this one is '${read.datasetKind}'`,
    );
  }
  const cfg = fsConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid fs connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  const config = excelDatasetConfigSchema.safeParse(read.datasetConfig);
  if (!config.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid excel dataset config: ${formatZodIssues(config.error.issues)}`,
    );
  }

  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await resolveWithinRoots(cfg.data.roots, config.data.path, 'fs');
  } catch (err) {
    // `resolveWithinRoots` leaves `realpath` on the target's PARENT unguarded on
    // purpose, so a missing or unreadable directory arrives as a raw errno; its
    // docblock says every caller owes this wrapper.
    throw readFailure(err, read.signal, `the excel file '${config.data.path}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return { path: confined.path, config: config.data };
}

/** How the refusals name the source: the SHEET within the file, because a
 * workbook holds several and "'/d/book.xlsx' has no header row" would not say
 * which one. `source-columns.ts` takes an already-quoted subject for this. */
function subjectOf(path: string, config: ExcelConfig): string {
  const which = config.sheet !== undefined ? `"${config.sheet}"` : `#${config.sheetIndex ?? 1}`;
  return `sheet ${which} of '${path}'`;
}

/**
 * Open the confined workbook and hand its rows back, descriptor and all.
 *
 * OWNERSHIP TRANSFERS at the moment `readXlsxRowBatches` runs `openZip`, which
 * it does on the first `next()` of the generator it returns — and which it
 * discharges in a `finally` that AWAITS the real close (slice 1 measured that
 * `zip.close()` returns before the fd is gone). So every caller here must
 * either drain the generator or `break` out of a `for await`, which invokes
 * `.return()` and reaches that `finally`. Neither may simply drop it.
 *
 * `batchRows` IS PRE-VALIDATED HERE, duplicating the reader's own check, and
 * the duplication is load-bearing: that check is the ONE throw inside
 * `readXlsxRowBatches` that happens BEFORE `openZip`, so a bad value would
 * reject with the descriptor already open and never handed over — a leak on the
 * one path the transfer contract cannot cover. Refusing before the open makes
 * the window not exist.
 */
async function openSheet(
  path: string,
  config: ExcelConfig,
  batchRows: number,
  signal: AbortSignal | undefined,
): Promise<AsyncGenerator<readonly XlsxRow[]>> {
  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new DatasetIoError('permanent', `batchRows must be a positive integer, got ${batchRows}`);
  }
  // Before the descriptor, matching `readDelimitedDatasetBatches`: an
  // already-cancelled read should not pay for an `open` + `fstat`, which is
  // cheap locally and is not on a wedged mount.
  if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  let opened: Awaited<ReturnType<typeof openConfinedFd>>;
  try {
    opened = await openConfinedFd(path);
  } catch (err) {
    throw readFailure(err, signal, `the excel file '${path}'`);
  }
  if (!opened.ok) throw new DatasetIoError('permanent', opened.error);

  return readXlsxRowBatches({
    filePath: path,
    fd: opened.fd,
    batchRows,
    // Exactly one of these is set — `excelDatasetConfigSchema`'s `superRefine`
    // refuses both and refuses neither, which is what makes `resolveSheet`'s
    // own first-sheet fallback unreachable from a dataset.
    //
    // THE OPERATOR TYPES THE NAME BLIND, and that is a real gap rather than an
    // oversight: `xlsx-read.ts`'s `listXlsxSheetNames` could answer "what does
    // this workbook hold" without streaming a worksheet, and still has no
    // production caller. Wiring it needs a ROUTE that opens an
    // operator-supplied path — a new surface owing the same confinement this
    // module does — so it is #1218 rather than this slice. The refusal path
    // does list the sheets, so a wrong name is caught with the right names in
    // the message; it is caught at run time instead of at authoring time.
    ...(config.sheet === undefined ? {} : { sheet: config.sheet }),
    ...(config.sheetIndex === undefined ? {} : { sheetIndex: config.sheetIndex }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Whether a row carries nothing at all.
 *
 * MEASURED, and it is the fact that shaped the whole scan. A wholly blank row
 * is NOT absent from the sheet XML: Excel writes a bare `<row r="2"/>` for any
 * row whose height, fill or format was ever touched, and it arrives here as
 * `cells: []`. A row of styled-but-empty cells arrives as all-`null`.
 *
 * Such rows are SKIPPED, on `delimited`'s rule that a blank line is not a row.
 * The alternative is not neutral: binding one would emit an all-`null` record
 * for every formatting artifact in the file, so the same logical data copied as
 * a CSV and as a workbook would produce different `rowsRead` — and against a
 * `nullable: false` sink column it would abort the whole transaction on a row
 * the operator never authored.
 *
 * It is applied ONLY BELOW THE HEADER. A blank row AT `headerRow` must refuse
 * ("names no columns"), never be skipped: skipping it would silently promote
 * the next row — real data — into the column names.
 */
function isBlankRow(row: XlsxRow): boolean {
  return row.cells.every((cell) => cell === null);
}

/** The width of a row, ignoring a trailing run of blanks — the positional-naming
 * input, computed from a BLANK PREDICATE over raw cells rather than through
 * {@link headerCellName}, which refuses shapes that are perfectly legal as data. */
function widthOf(cells: readonly XlsxCell[]): number {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === null) end -= 1;
  return end;
}

/**
 * One header cell as a column NAME, or a refusal.
 *
 * A column name is what a mapping's `source` binds to, so it has to be a string
 * that survives being written down. Text is itself; a number or boolean gets
 * `coerce.ts`'s CANONICAL text form (`String(n)`, `'true'`), never a locale one.
 * A blank becomes `''`, which hands the two shared refusals — trailing trim and
 * interior-empty — the exact input they expect.
 *
 * A DATE-TYPED HEADER IS REFUSED, and it is the one judgement call in this
 * module worth defending, because monthly date headers are real. The reader
 * consumes the cell's format code to CLASSIFY it and does not carry it out, so
 * there is no "as authored" text to recover: any name studio produced would be
 * an invention — `2026-01-01T00:00:00.000Z` at best — and an invention that
 * every mapping in the workspace would then depend on. Worse, deriving it from
 * `dateFormat` would make a key whose documented job is reading VALUES silently
 * RENAME columns. So it refuses, and the message names all three real fixes.
 * An error cell refuses for the same reason with less to argue about.
 *
 * This fires from `describeExcelDatasetColumns` too, so it lands at the drift
 * gate — before the first row moves — and not mid-copy.
 */
function headerCellName(cell: XlsxCell, subject: string, column: number): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  const what = cell instanceof Date ? 'a date' : 'an error';
  throw new DatasetIoError(
    'permanent',
    `${subject} has ${what} cell in header column ${column}, which has no name a mapping ` +
      'could bind to — format that row as text, point headerRow at a text row, or set header: false',
  );
}

/** The column names for a sheet's first meaningful row, under either header mode. */
function namesFrom(header: boolean, row: XlsxRow, subject: string): readonly string[] {
  if (!header) return positionalNames(widthOf(row.cells));
  return headerNames(
    row.cells.map((cell, index) => headerCellName(cell, subject, index + 1)),
    subject,
  );
}

/**
 * Bind one row to the column names — the RAGGED-ROW policy, and where the two
 * fs readers genuinely part company.
 *
 * Every name is assigned on every row, so the key set is UNIFORM. That is a
 * contract with the pump and not tidiness: `planColumns` (`datamove/pump.ts`)
 * resolves the plan ONCE from the first row's `Object.keys`, so a row that
 * omitted its missing keys could change the plan depending on which row arrived
 * first.
 *
 * A MISSING CELL BINDS `null`, WHERE A CSV'S BINDS `undefined`. That is the
 * whole reason `bindRow` was not lifted into `source-columns.ts`. `undefined`
 * lands on `coerce.ts`'s `absent_value` and fails the row, which is right for a
 * CSV — a short line is a malformed line. A workbook is different in kind:
 * Excel omits a blank cell from the XML entirely, so on a sheet that is SPARSE
 * BY CONSTRUCTION `undefined` would fail one row per blank. Slice 1 pinned
 * `null` as the value for that reason and this is the binding half of it.
 *
 * THE COST, stated rather than implied, because it is a real fidelity residual:
 * a genuinely TRUNCATED row is indistinguishable from a row of trailing blanks
 * — the format does not record the difference — so it is padded and written
 * rather than counted as a failure. And a blank against a `nullable: false`
 * sink column is a constraint violation raised mid-transaction rather than a
 * counted `rowsFailed`, exactly as a real NULL from a SQL source already is.
 *
 * A row with an extra cell THAT CARRIES SOMETHING is refused, and the copy with
 * it — `delimited`'s asymmetry unchanged, for its stated reason: the reader has
 * no per-row error channel, so the honest options are refuse or silently
 * discard fields the file contains, and discarding is unrecoverable data loss
 * nothing would report. An extra BLANK is not refused, because it is not data;
 * a styled-but-empty cell past the last column is a formatting artifact and
 * appears on every row of the files that have it.
 *
 * The message names the sheet's OWN 1-BASED ROW NUMBER, which is an improvement
 * on `delimited`'s data-row ordinal rather than a copy of it: a workbook row
 * has a real number the operator can see in Excel, and blank rows are skipped
 * so an ordinal would diverge from it exactly where it is most needed.
 */
function bindExcelRow(
  names: readonly string[],
  row: XlsxRow,
  subject: string,
): Record<string, unknown> {
  if (row.cells.length > names.length) {
    const extra = row.cells.slice(names.length);
    if (extra.some((cell) => cell !== null)) {
      throw new DatasetIoError(
        'permanent',
        `${subject} row ${row.rowNumber} carries ${row.cells.length} cells but the source has ` +
          `${names.length} columns — the extra cells have no column to be written to`,
      );
    }
  }
  const bound: Record<string, unknown> = {};
  for (let index = 0; index < names.length; index += 1) {
    // `?? null`, so an absent cell and a blank one are ONE fact. Both mean
    // "this row says nothing here", and the format cannot tell them apart.
    bound[names[index]!] = row.cells[index] ?? null;
  }
  return bound;
}

/** The refusal for a `headerRow` the sheet never reaches — its own sentence,
 * because `noRowsError`'s ("contains no rows") would be FALSE for a sheet that
 * has rows and simply has fewer than the config asked for. */
function noHeaderRowError(subject: string, headerRow: number, lastSeen: number): DatasetIoError {
  return new DatasetIoError(
    'permanent',
    `${subject} has no row ${headerRow} to name its columns` +
      (lastSeen === 0 ? '' : `; its last row is ${lastSeen}`),
  );
}

/**
 * Walk a sheet, deriving the column names and then binding data rows.
 *
 * ONE traversal shared by both entry points, so the drift gate and the scan
 * cannot disagree about which row named the columns — a describe that named
 * them from row 3 while the read named them from row 4 would gate on columns
 * the copy never sees, which is the failure the gate exists to prevent.
 *
 * Header-row selection is a SCAN and not an index, because the rows that arrive
 * are the rows the sheet HAS: title rows above the header are skipped by
 * number, and a `headerRow` the sheet steps straight over — or never reaches —
 * refuses rather than falling through to the next row, which would name the
 * columns after DATA while succeeding.
 */
async function* namedRows(
  rows: AsyncGenerator<readonly XlsxRow[]>,
  config: ExcelConfig,
  subject: string,
  signal: AbortSignal | undefined,
  /** Fired ONCE, the moment the columns are named — before any row is bound.
   * `describeExcelDatasetColumns` needs the names for a sheet that HAS a header
   * and no data rows, which yields no batch at all and so could never learn
   * them from a yield. A callback rather than a second traversal: re-walking
   * would re-open the container and re-materialise its shared strings. */
  onNames?: (names: readonly string[]) => void,
): AsyncGenerator<{ names: readonly string[]; bound: Record<string, unknown>[] }> {
  let names: readonly string[] | undefined;
  let lastSeen = 0;
  let first = true;

  for await (const batch of rows) {
    const bound: Record<string, unknown>[] = [];
    for (const row of batch) {
      // THE HEADER BRANCH IS SEPARATE, and that is the whole reason for the
      // shape: below this, ONE blank-row skip serves both the data rows and the
      // headerless width row, because they want the same rule. Up here the rule
      // is the opposite — a blank row AT `headerRow` must REFUSE (which
      // `namesFrom` does, via the shared "names no columns" message) rather than
      // be skipped, since skipping it would silently promote the next row, real
      // data, into the column names.
      if (names === undefined && config.header) {
        if (row.rowNumber < config.headerRow) {
          lastSeen = row.rowNumber;
          continue; // a title row above the header
        }
        if (row.rowNumber > config.headerRow) {
          throw noHeaderRowError(subject, config.headerRow, lastSeen);
        }
        lastSeen = row.rowNumber;
        names = namesFrom(true, row, subject);
        onNames?.(names);
        continue; // the header row is consumed, never copied
      }

      lastSeen = row.rowNumber;
      if (isBlankRow(row)) continue;
      if (names === undefined) {
        // Headerless: the width comes from the first row that CARRIES
        // something, and this row is DATA as well, so it falls through. Taking
        // it from a LEADING BLANK row instead would name zero columns and then
        // refuse every real row below as "carries 2 cells but the source has 0
        // columns" — a whole sheet rejected because somebody once set a row
        // height.
        names = namesFrom(false, row, subject);
        onNames?.(names);
      }
      bound.push(bindExcelRow(names, row, subject));
    }

    if (bound.length === 0) continue;
    // Cancellation and the yield are BOTH at the batch boundary (§9, §10) — the
    // abort unconditionally, the yield only BETWEEN batches, so a copy does not
    // pay a macrotask before it has produced anything.
    if (!first) await yieldToEventLoop();
    if (signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
    first = false;
    yield { names: names as readonly string[], bound };
  }

  if (names === undefined) {
    // THREE different facts, three different sentences — a sheet that has rows
    // must never be told it has none, because that sends an operator looking
    // for an empty file when the file is not empty.
    //
    // With `header: true`, reaching here with any row seen means the sheet
    // stopped SHORT of `headerRow`; a sheet that stepped over it already threw
    // inside the loop, and one that reached it has names.
    if (config.header && lastSeen > 0) {
      throw noHeaderRowError(subject, config.headerRow, lastSeen);
    }
    // With `header: false`, it means every row present was blank.
    if (lastSeen > 0) {
      throw new DatasetIoError(
        'permanent',
        `${subject} has rows but every one of them is blank, so its columns cannot be counted`,
      );
    }
    throw noRowsError(subject, config.header);
  }
}

/**
 * Stream an `excel` dataset out of an `fs` store in bounded batches, yielding
 * to the event loop between them (§9's batch-yield).
 *
 * A sheet with a header row and NO data rows succeeds over zero rows — the
 * well-formed empty source, distinct from a sheet with no rows at all, which
 * cannot say what its columns are and is refused.
 */
export async function* readExcelDatasetBatches(
  read: ExcelDatasetRead,
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  const { path, config } = await prepareRead(read);
  const subject = subjectOf(path, config);
  const rows = await openSheet(path, config, read.batchRows ?? COPY_BATCH_ROWS, read.signal);
  try {
    for await (const { bound } of namedRows(rows, config, subject, read.signal)) {
      yield bound;
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the excel source ${subject}`);
  }
}

/**
 * #1148 M6 (§7) — the source's ACTUAL column names, for the drift gate that
 * runs BEFORE the first row moves.
 *
 * The same `namedRows` traversal, stopped at the first batch: `break` out of a
 * `for await` invokes the generator's `.return()`, which is what reaches
 * `readXlsxRowBatches`'s `finally` and closes the descriptor. Dropping the
 * generator instead would leak one per describe, and a copy calls this once per
 * source.
 *
 * IT IS NOT AS CHEAP AS `delimited`'s, and the difference is worth naming
 * because §7 promises "without reading a row". A workbook is a zip: before any
 * row can be produced, `xlsx-read.ts` indexes the central directory and
 * materialises `sharedStrings.xml` and `styles.xml` (bounded by
 * `XLSX_MAX_SHARED_STRINGS_BYTES` / `XLSX_MAX_SMALL_PART_BYTES`, so it is
 * bounded — not free). `copy.ts` calls this and then `readBatches`, so that
 * prologue is paid twice per copy. That is the price of random access, which is
 * also the property that makes the reader correct on Excel's own entry order.
 *
 * THE HONEST EXCEPTION survives from `delimited`: with `header: false` the
 * width can only be learnt from a row, so one is read. Nothing is copied from
 * it, but the sheet IS touched.
 *
 * `batchRows` is deliberately the DEFAULT rather than 1. The two derivations
 * agree because they share `namedRows`, not because they share a batch size —
 * and at 1, a `headerRow: 40` sheet would pay forty macrotasks to reach a row
 * one batch already contains.
 */
export async function describeExcelDatasetColumns(
  read: ExcelDatasetRead,
): Promise<readonly string[]> {
  const { path, config } = await prepareRead(read);
  const subject = subjectOf(path, config);
  const rows = await openSheet(path, config, read.batchRows ?? COPY_BATCH_ROWS, read.signal);
  let captured: readonly string[] | undefined;
  try {
    for await (const named of namedRows(rows, config, subject, read.signal, (names) => {
      captured = names;
    })) {
      // `return` out of a `for await` is what invokes `.return()` on the chain,
      // which reaches `readXlsxRowBatches`'s `finally` and closes the
      // descriptor. Dropping the generator instead would leak one per describe.
      return named.names;
    }
  } catch (err) {
    throw readFailure(err, read.signal, `the excel source ${subject}`);
  }
  // No batch was yielded: a sheet whose header named columns and whose data
  // rows were all blank — the well-formed empty source. The names still exist,
  // because `namedRows` throws rather than completing without them.
  if (captured !== undefined) return captured;
  /* c8 ignore next -- unreachable: namedRows either fires onNames or throws. */
  throw noRowsError(subject, config.header);
}

/**
 * #996 M7 slice 3's address seam (§2.1), for the other fs kind — where an
 * `excel` dataset PHYSICALLY is, so a dispatch can RECORD it and the self-copy
 * gate can compare it.
 *
 * `resolveDelimitedDatasetAddress`'s body, and identical on purpose: for a flat
 * file the store and the object are the same physical thing, so `store` and
 * `object` are BOTH the confined path. `object` must not be `null` —
 * `sameDatasetAddress` states that "a `null` object never matches, not even
 * another `null`" — and the path is NOT folded, because filesystem paths are
 * case-sensitive where SQL identifiers are not.
 *
 * THE SHEET IS DELIBERATELY NOT PART OF THE ADDRESS. Two datasets naming two
 * sheets of one workbook are the same physical object, and an address is about
 * the object a write would land on. Putting the sheet in would make them
 * compare unequal, which is only a difference the day a writer exists — and on
 * that day it would be WRONG, because writing either sheet rewrites the whole
 * container.
 *
 * A THIRD RESIDUAL joins the two `delimited` records, and it is this slice's
 * own: a `delimited` and an `excel` dataset on the SAME `path` now produce
 * identical addresses. Unreachable for the same reason as the others — there is
 * no fs writer, so two `fs` ends cannot both exist in one copy — and it belongs
 * on the same list for whichever writer lands first.
 *
 * A `stat` failure yields `null` UNIFORMLY across errno: every way it can fail
 * leaves the READ unable to proceed anyway, so the degraded comparison cannot
 * admit a copy that would otherwise be refused, and an unidentifiable store
 * must never become a `permanent` refusal.
 */
export async function resolveExcelDatasetAddress(args: {
  readonly connectionConfig: Record<string, unknown>;
  readonly dataset: { readonly kind: DatasetKind; readonly config: Record<string, unknown> };
}): Promise<DatasetAddress> {
  // Through `prepareRead`, not beside it: the kind guard, both config parses and
  // the confinement are the same facts the read needs, and a second copy would
  // be a second place for the address and the read to disagree about which file
  // they mean. Nothing is opened — §2.1's "a pure read".
  const { path } = await prepareRead({
    connectionConfig: args.connectionConfig,
    datasetKind: args.dataset.kind,
    datasetConfig: args.dataset.config,
  });

  let storeIdentity: string | null = null;
  try {
    const stats = await stat(path);
    storeIdentity = `${stats.dev}:${stats.ino}`;
  } catch {
    // Unidentifiable — recorded as such, never a refusal and never a FALSE
    // identity. See the docblock's uniform-across-errno argument.
  }

  return { kind: 'fs', store: path, storeIdentity, object: path };
}

/**
 * §6.4's per-source-dataset format facts as the pump wants them, projected off
 * an `excel` dataset's own config — the `CopyIo.sourceCoercion` half.
 *
 * `delimitedCoercionFor`'s shape and its polarity: a parse failure THROWS
 * rather than degrading to `{}`, because `{}` would run the copy with the
 * operator's declared sentinel silently doing nothing, which is exactly what
 * the REQUIRED channel exists to prevent.
 *
 * Only the DECLARED keys are returned. `exactOptionalPropertyTypes` is on, so
 * an absent `nullValue` must be an absent PROPERTY and not `undefined` —
 * `coerceValue` tests `opts.nullValue !== undefined`, and `''` is a meaningful
 * declaration.
 */
export function excelCoercionFor(datasetConfig: Record<string, unknown>): CoercionOptions {
  const parsed = excelDatasetConfigSchema.safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid excel dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  const { nullValue, dateFormat } = parsed.data;
  return {
    ...(nullValue === undefined ? {} : { nullValue }),
    ...(dateFormat === undefined ? {} : { dateFormat }),
  };
}
