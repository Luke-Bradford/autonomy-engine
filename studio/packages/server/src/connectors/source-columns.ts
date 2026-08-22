import { DatasetIoError } from './dataset-io-error.js';

/**
 * #1215 M11 slice 2 -- the column-NAMING rules a tabular file source obeys,
 * shared by `delimited-io.ts` (M7) and `excel-io.ts` (M11).
 *
 * LIFTED rather than copied, which #1215 asked for by name. All four were
 * module-private in `delimited-io.ts` and excel needs every one with the SAME
 * semantics: the duplicate-header refusal, the interior-empty-header refusal,
 * `column1..N` positional naming, and the no-rows sentence. Two copies of one
 * refusal message is precisely the drift `delimitedCoercionFor`'s docblock
 * refuses -- an operator would get two different sentences for one rule
 * depending on which file format they happened to point at, and the second
 * would rot the first time either was reworded (#1175 did that once already,
 * across every connector).
 *
 * `bindRow` is DELIBERATELY NOT HERE. Its ragged-row policy looks shared and is
 * not: a CSV's short row binds `undefined` (which lands on `coerce.ts`'s
 * `absent_value` and fails that row), where an Excel blank cell is a genuine
 * `null` that every target accepts. Lifting it would have forced a flag, and a
 * flag on a rule this load-bearing is two rules wearing one name.
 *
 * THE ONE CHANGE MADE WHILE LIFTING: these take an already-quoted SUBJECT
 * rather than a path, because excel's subject is a SHEET within a file
 * (`sheet "Sales" of '/d/book.xlsx'`) and delimited's is the file. `delimited-io`
 * passes `` `'${path}'` ``, so every message it emits is byte-identical to
 * before -- which its own tests pin.
 */

/**
 * The column names, from the header row.
 *
 * TWO REFUSALS, and the first is the opposite of what the `sqlite` source does
 * with the same shape, which is worth stating because it reads as an
 * inconsistency and is not. `describeSqliteDatasetColumns` COLLAPSES a duplicate
 * (`SELECT i, i` reports `['i','i']` while the row carries `i` once, so
 * collapsing loses nothing). A CSV row carries BOTH values, so folding
 * `a,b,a` to `['a','b']` would silently drop a column of real data — and there
 * is no dispatch-time gate to delegate to, because `indexSourceColumns`
 * (`datamove/schema-drift.ts`) collapses exact duplicates before
 * `checkSourceDrift` ever sees them. This reader is the only place it can be
 * caught, so it is caught in BOTH entry points rather than only in the one that
 * happens to run first.
 *
 * AN INTERIOR EMPTY NAME IS REFUSED — `a,,c` has a column with data and no way
 * for a mapping to name it. The alternative, falling back to `column<N>` for
 * just that one, was rejected because a synthesised name for a column the file
 * DOES have is a name that changes the moment the header is fixed: a mapping
 * authored against `column2` would silently stop matching, which is the failure
 * class this backlog keeps paying for. (`header: false` is different in kind,
 * not degree: there NO column is named, so positional naming is total and
 * stable rather than a patch over one hole.)
 *
 * A TRAILING run of empty cells is NOT refused — it is not a column at all. See
 * {@link trimTrailingEmpty}.
 */
export function headerNames(rawCells: readonly string[], subject: string): string[] {
  const cells = trimTrailingEmpty(rawCells);
  if (cells.length === 0) {
    throw new DatasetIoError('permanent', `${subject} has a header that names no columns`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < cells.length; index += 1) {
    const name = cells[index]!;
    if (name === '') {
      throw new DatasetIoError(
        'permanent',
        `${subject} has no name for header column ${index + 1} — every column a mapping can name must be named`,
      );
    }
    if (seen.has(name)) {
      throw new DatasetIoError(
        'permanent',
        `${subject} names the header column '${name}' more than once, so a row cannot carry both`,
      );
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Drop a trailing run of EMPTY cells.
 *
 * A trailing delimiter (`a,b,`) is a spreadsheet-export artifact, not a third
 * column: it names nothing and carries nothing. Applied to the HEADER here and,
 * in the excess-only form {@link bindRow} needs, to every data row — ONE rule,
 * so a file whose header ends with a delimiter and whose rows do too is not
 * accepted on one line and refused on the next.
 *
 * It is a TRAILING run and never an interior cell: `a,,c` keeps its hole, which
 * is what lets {@link headerNames} still refuse an unnamed column that has data.
 */
export function trimTrailingEmpty(cells: readonly string[]): readonly string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end -= 1;
  return end === cells.length ? cells : cells.slice(0, end);
}

/**
 * Positional names for a headerless file: `column1`…`columnN`, 1-indexed
 * because that is how an operator counts columns in a spreadsheet.
 *
 * The width comes from the FIRST row, and slice 1 already owes the statement
 * this makes true: a headerless source is the one case where §7's "without
 * reading a row" cannot hold, because learning the width needs a row. It is
 * stated rather than quietly excepted.
 */
export function positionalNames(width: number): string[] {
  return Array.from({ length: width }, (_, index) => `column${index + 1}`);
}

/** The refusal for a source that yields no rows at all, shared by both entry points. */
export function noRowsError(subject: string, header: boolean): DatasetIoError {
  return new DatasetIoError(
    'permanent',
    header
      ? `${subject} contains no rows, so it has no header row to name its columns`
      : `${subject} contains no rows, so its columns cannot be counted`,
  );
}
