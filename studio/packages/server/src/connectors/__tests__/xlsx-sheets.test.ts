import { mkdir, symlink, writeFile } from 'node:fs/promises';

// Only `openConfinedFd` becomes a spy; every other export passes through to the
// real implementation. `excel-io.test.ts`'s idiom, for its stated reason — this
// module's subject IS real filesystem behaviour (confinement, `O_NOFOLLOW`,
// descriptors), and a fake would only test itself. The spy exists so a test can
// prove a refusal happened BEFORE a descriptor was ever taken.
vi.mock('../confine.js', async (importActual) => {
  const actual = await importActual<typeof import('../confine.js')>();
  return { ...actual, openConfinedFd: vi.fn(actual.openConfinedFd) };
});
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openConfinedFd } from '../confine.js';
import { listSheetsForConnection } from '../xlsx-sheets.js';
import { buildXlsx } from './xlsx-fixtures.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * #1218 — the authoring-time "what does this workbook hold" read.
 *
 * Its whole contract is that it NEVER THROWS: it is called from a route whose
 * every failure is an ordinary authoring condition, so each one has to arrive as
 * `{ ok: false, error }` and be renderable in one place. The three tests that
 * matter most are therefore the ones that would previously have been a 500 —
 * a path that does not exist, a directory, and an unreadable parent — because
 * `resolveWithinRoots` and `openConfinedFd` BOTH throw on those by design
 * (`confine.ts`'s docblock says every caller owes the wrapper).
 */

let root: string;

beforeEach(() => {
  root = tempRoot('xlsx-sheets-');
});

afterEach(() => {
  cleanupTempRoots();
  vi.mocked(openConfinedFd).mockClear();
});

const twoSheetBook = () =>
  buildXlsx({
    sheets: [
      { name: 'People', rows: [[{ kind: 'inline', text: 'name' }]] },
      { name: 'Costs', rows: [[{ kind: 'inline', text: 'amount' }]] },
    ],
    // The order Excel itself writes — strings and styles AFTER the sheet.
    order: 'excel',
  });

describe('listSheetsForConnection', () => {
  it('returns every sheet name in workbook order', async () => {
    await writeFile(join(root, 'book.xlsx'), twoSheetBook());

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'book.xlsx'),
    });

    // Order is the contract, not a coincidence: index N of this list is
    // `sheetIndex` N+1, so a reordering would silently re-point the operator's
    // alternative way of naming the same sheet.
    expect(result).toEqual({ ok: true, sheets: ['People', 'Costs'] });
  });

  it('refuses a connection that is not an fs connection, before any descriptor', async () => {
    const result = await listSheetsForConnection({
      connection: { kind: 'postgres', config: { host: 'db' } },
      path: join(root, 'book.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/fs connection/);
    expect(openConfinedFd).not.toHaveBeenCalled();
  });

  it('refuses an fs connection whose config does not parse', async () => {
    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [] } },
      path: join(root, 'book.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/invalid fs connection config/);
    expect(openConfinedFd).not.toHaveBeenCalled();
  });

  it('opens a path containing ${} as the literal filename it is', async () => {
    // #1218 asked for a `${}` degrade branch, and its premise is FALSE: nothing
    // substitutes a dataset `path` (`excel-io.ts`'s `prepareRead` reads
    // `dataset.config` verbatim), so this IS a filename. Refusing it would make
    // the picker decline a workbook the runtime reader opens without complaint —
    // a disagreement that would surface only as "the sheet list is broken for
    // this dataset".
    await writeFile(join(root, '${literal}.xlsx'), twoSheetBook());

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, '${literal}.xlsx'),
    });

    expect(result).toEqual({ ok: true, sheets: ['People', 'Costs'] });
  });

  it('refuses a path outside the connection roots', async () => {
    const outside = tempRoot('xlsx-sheets-outside-');
    await writeFile(join(outside, 'book.xlsx'), twoSheetBook());

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(outside, 'book.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/outside the allowed roots/);
    expect(openConfinedFd).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable path without echoing the raw errno', async () => {
    const outside = tempRoot('xlsx-sheets-outside-');

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(outside, 'no-such-dir', 'book.xlsx'),
    });

    // `resolveWithinRoots` realpaths the PARENT before it checks containment, so
    // a missing parent THROWS where a present one returns a policy refusal —
    // which is why a caller owes it a try/catch at all. The raw errno is not
    // echoed (it tells an author nothing, and names paths they did not ask
    // about); the sentence stays honest about an unresolvable path rather than
    // claiming a containment verdict it could not reach.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/could not be resolved/);
    expect(result.ok === false && result.error).not.toMatch(/ENOENT|no such file/i);
  });

  it('refuses a file inside the roots that does not exist, without throwing', async () => {
    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'not-here.xlsx'),
    });

    // `openConfinedFd` leaves `open` OUTSIDE its try, so every errno — ENOENT
    // included — propagates. This is the ticket's own headline degrade case
    // (a file an upstream node has not produced yet); unwrapped it is a 500.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/could not be opened|not be read/);
  });

  it('refuses a directory rather than reporting an empty workbook', async () => {
    await mkdir(join(root, 'a-folder.xlsx'));

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'a-folder.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not a regular file/);
  });

  it('refuses a symlinked workbook', async () => {
    const outside = tempRoot('xlsx-sheets-outside-');
    await writeFile(join(outside, 'real.xlsx'), twoSheetBook());
    await symlink(join(outside, 'real.xlsx'), join(root, 'link.xlsx'));

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'link.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/symlink/);
    expect(openConfinedFd).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a workbook, without throwing', async () => {
    await writeFile(join(root, 'notes.xlsx'), 'this is not a zip container');

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'notes.xlsx'),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
  });

  it('reports an empty sheet name truthfully rather than dropping it', async () => {
    // A container Excel cannot author. The reader tells the truth; the FORM is
    // what declines to offer an unselectable option, so the two decisions stay
    // separable.
    await writeFile(
      join(root, 'odd.xlsx'),
      buildXlsx({ sheets: [{ name: '', rows: [[{ kind: 'inline', text: 'a' }]] }] }),
    );

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: join(root, 'odd.xlsx'),
    });

    expect(result).toEqual({ ok: true, sheets: [''] });
  });

  it('names the path the operator TYPED, not the realpath it resolved to', async () => {
    await writeFile(join(root, 'book.xlsx'), twoSheetBook());
    // A `..` segment that still lands inside the root: the refusal (and any
    // reader message) should quote what was asked for, matching
    // `resolveWithinRoots`'s own refusals, and disclose no canonicalised path.
    const requested = join(root, 'sub', '..', 'missing.xlsx');
    await mkdir(join(root, 'sub'));

    const result = await listSheetsForConnection({
      connection: { kind: 'fs', config: { roots: [root] } },
      path: requested,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(requested);
  });
});
