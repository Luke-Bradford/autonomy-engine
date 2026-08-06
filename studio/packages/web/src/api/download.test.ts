import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile, exportFileName } from './download';

/**
 * jsdom implements neither `URL.createObjectURL` nor `revokeObjectURL` (grep
 * the jsdom package — there is no such property), so `vi.spyOn` would throw on
 * an absent property. They are installed here as real stubs, per test, rather
 * than in `vitest.setup.ts`: a global stub would silently green-light every
 * future test that reaches the download path without saying so.
 *
 * `HTMLAnchorElement.prototype.click` is stubbed for a DIFFERENT reason and it
 * is not optional. jsdom's `_cannotNavigate` is `localName !== 'a' && !isConnected`
 * — for an `<a>` that is ALWAYS false, connected or not, and the `download`
 * attribute is never consulted — so a real click schedules a navigation on the
 * next tick, which jsdom reports as an unimplemented-feature error attributed
 * to whichever test happens to be running by then.
 */
function stubBrowserDownload() {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const clicked: HTMLAnchorElement[] = [];

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      created.push(blob);
      return `blob:stub/${created.length}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

  return { created, revoked, clicked, clickSpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadTextFile', () => {
  it('hands the browser the exact text, under the given file name', async () => {
    const { created, clicked } = stubBrowserDownload();
    const text = '{"a":1,\n  "b":[2,3]}';

    downloadTextFile('pipeline-x.json', text);

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('pipeline-x.json');
    expect(clicked[0]?.href).toBe('blob:stub/1');
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('application/json');
    // The bytes matter: an export is a canonical artifact (#3 G1), so the
    // helper must not reformat, re-encode or trim what it was handed.
    await expect(created[0]?.text()).resolves.toBe(text);
  });

  it('revokes the object URL it created', () => {
    const { revoked } = stubBrowserDownload();

    downloadTextFile('pipeline-x.json', '{}');

    expect(revoked).toEqual(['blob:stub/1']);
  });

  it('leaves no anchor behind in the document', () => {
    stubBrowserDownload();

    downloadTextFile('pipeline-x.json', '{}');

    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('exportFileName', () => {
  it('names the file after the resource, and always carries the id', () => {
    // The id is not decoration. `POST /api/import` mints a NEW id and does not
    // dedupe by name, so importing the same pipeline twice leaves two rows
    // called the same thing — and two exports that then collide on disk.
    expect(exportFileName('pipeline', 'My Pipeline', 'pl_123')).toBe(
      'pipeline-my-pipeline-pl_123.json',
    );
  });

  it('collapses punctuation and runs of whitespace to single hyphens', () => {
    expect(exportFileName('trigger', '  Nightly //  build!  ', 'trg_9')).toBe(
      'trigger-nightly-build-trg_9.json',
    );
  });

  it('falls back to the id alone when the name slugifies to nothing', () => {
    // A name that is entirely emoji/CJK/punctuation would otherwise produce
    // `pipeline--pl_1.json`, or `pipeline-.json` if the id were left out.
    expect(exportFileName('pipeline', '🎉🎉', 'pl_1')).toBe('pipeline-pl_1.json');
  });
});
