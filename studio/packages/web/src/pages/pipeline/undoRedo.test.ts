import { describe, expect, it } from 'vitest';
import {
  arrangeDisabledReason,
  clipboardCommandFor,
  historyCommandFor,
  isDeleteKeystroke,
  isTextEntryTarget,
  redoDisabledReason,
  undoDisabledReason,
} from './undoRedo';

/** A keydown as `historyCommandFor` reads one, defaulting to "no modifiers". */
function key(
  k: string,
  over: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    target: EventTarget | null;
  }> = {},
) {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: document.createElement('div'),
    ...over,
  };
}

describe('undo/redo control state (U17)', () => {
  it('a live stack gives no reason — the control is enabled', () => {
    expect(undoDisabledReason({ available: true, previewing: null, busy: false })).toBeNull();
    expect(redoDisabledReason({ available: true, previewing: null, busy: false })).toBeNull();
  });

  it('an empty stack says so', () => {
    expect(undoDisabledReason({ available: false, previewing: null, busy: false })).toBe(
      'Nothing to undo.',
    );
    expect(redoDisabledReason({ available: false, previewing: null, busy: false })).toBe(
      'Nothing to redo.',
    );
  });

  it('a preview takes the controls away, and says which document it means', () => {
    expect(undoDisabledReason({ available: true, previewing: 3, busy: false })).toMatch(
      /working graph/,
    );
    expect(redoDisabledReason({ available: true, previewing: 3, busy: false })).toMatch(
      /working graph/,
    );
  });

  it('a save or restore in flight takes both controls away', () => {
    // The working graph is mid-comparison inside the save: an undo here makes
    // the save conclude the operator kept editing, rebase onto the new version
    // and leave the canvas reporting itself CLEAN over a pre-edit graph.
    expect(undoDisabledReason({ available: true, previewing: null, busy: true })).toBe(
      'Wait for the save or restore to finish.',
    );
    expect(redoDisabledReason({ available: true, previewing: null, busy: true })).toBe(
      'Wait for the save or restore to finish.',
    );
  });

  it('the busy reason outranks both others — it is the one that is about to change', () => {
    expect(undoDisabledReason({ available: false, previewing: 3, busy: true })).toMatch(/Wait for/);
  });

  it('the preview reason WINS over the empty-stack one — it is the actionable half', () => {
    expect(undoDisabledReason({ available: false, previewing: 3, busy: false })).toMatch(
      /Leave the preview/,
    );
  });
});

describe('isTextEntryTarget (U17)', () => {
  it('names the controls whose undo the browser owns', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTextEntryTarget(document.createElement(tag)), tag).toBe(true);
    }
  });

  it('a contenteditable is text entry whatever its tag', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    // jsdom does not derive `isContentEditable` from the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isTextEntryTarget(el)).toBe(true);
  });

  it('the canvas surface is not text entry', () => {
    expect(isTextEntryTarget(document.createElement('div'))).toBe(false);
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false);
  });

  it('an SVG element is not text entry either — a focused EDGE is one', () => {
    // React Flow's edge wrapper is an SVG `<g>` with a tabindex. Reading it as
    // text entry made every canvas keystroke dead while an edge had focus,
    // which is how U21's delete key silently stopped deleting edges.
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    expect(isTextEntryTarget(g)).toBe(false);
  });

  it('fails CLOSED — a target that is not an element is left alone', () => {
    expect(isTextEntryTarget(null)).toBe(true);
    expect(isTextEntryTarget(new EventTarget())).toBe(true);
  });
});

describe('historyCommandFor (U17)', () => {
  it('⌘Z and Ctrl+Z undo', () => {
    expect(historyCommandFor(key('z', { metaKey: true }))).toBe('undo');
    expect(historyCommandFor(key('z', { ctrlKey: true }))).toBe('undo');
  });

  it('⇧⌘Z, Ctrl+Shift+Z and Ctrl+Y redo', () => {
    expect(historyCommandFor(key('z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(historyCommandFor(key('z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(historyCommandFor(key('y', { ctrlKey: true }))).toBe('redo');
  });

  it('an upper-case Z (which is what shift reports) still reads as Z', () => {
    expect(historyCommandFor(key('Z', { metaKey: true, shiftKey: true }))).toBe('redo');
  });

  it('a bare Z is not ours', () => {
    expect(historyCommandFor(key('z'))).toBeNull();
  });

  it('a keystroke inside a text field is not ours — the browser undoes the text', () => {
    expect(
      historyCommandFor(key('z', { metaKey: true, target: document.createElement('input') })),
    ).toBeNull();
  });

  it('Alt+⌘Z is some other app’s shortcut, not ours', () => {
    expect(historyCommandFor(key('z', { metaKey: true, altKey: true }))).toBeNull();
  });

  it('an unrelated key with the same modifiers is not ours', () => {
    expect(historyCommandFor(key('s', { metaKey: true }))).toBeNull();
  });
});

describe('clipboardCommandFor (U21)', () => {
  it('⌘C/⌘V/⌘D and their Ctrl forms read as copy, paste and duplicate', () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(clipboardCommandFor(key('c', mod))).toBe('copy');
      expect(clipboardCommandFor(key('v', mod))).toBe('paste');
      expect(clipboardCommandFor(key('d', mod))).toBe('duplicate');
    }
  });

  it('an upper-case key still reads', () => {
    expect(clipboardCommandFor(key('C', { metaKey: true }))).toBe('copy');
  });

  it('a bare C is not ours', () => {
    expect(clipboardCommandFor(key('c'))).toBeNull();
  });

  it('a keystroke inside a text field is the FIELD’s copy, never the canvas’s', () => {
    expect(
      clipboardCommandFor(key('c', { metaKey: true, target: document.createElement('input') })),
    ).toBeNull();
    expect(
      clipboardCommandFor(key('v', { metaKey: true, target: document.createElement('textarea') })),
    ).toBeNull();
  });

  it('Alt or Shift with the same key belongs to something else', () => {
    expect(clipboardCommandFor(key('c', { metaKey: true, altKey: true }))).toBeNull();
    expect(clipboardCommandFor(key('d', { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('⌘X is deliberately NOT read — cut is a later slice', () => {
    expect(clipboardCommandFor(key('x', { metaKey: true }))).toBeNull();
  });

  it('an unrelated key with the same modifiers is not ours', () => {
    expect(clipboardCommandFor(key('s', { metaKey: true }))).toBeNull();
  });
});

describe('isDeleteKeystroke (U21)', () => {
  it('Backspace and Delete both ask to delete the selection', () => {
    expect(isDeleteKeystroke(key('Backspace'))).toBe(true);
    expect(isDeleteKeystroke(key('Delete'))).toBe(true);
  });

  it('a keystroke inside a text field is not ours — Backspace edits the text', () => {
    // The reach is the whole document (the canvas cannot rely on where focus
    // is), so this guard is the entire reason that reach is safe.
    expect(isDeleteKeystroke(key('Backspace', { target: document.createElement('input') }))).toBe(
      false,
    );
    expect(
      isDeleteKeystroke(key('Backspace', { target: document.createElement('textarea') })),
    ).toBe(false);
  });

  it('a MODIFIED Backspace belongs to the browser, not to us', () => {
    // ⌘⌫ is "delete to start of line" in a field and history-back in some
    // browsers; ⌥⌫ deletes a word. Claiming them would break both.
    expect(isDeleteKeystroke(key('Backspace', { metaKey: true }))).toBe(false);
    expect(isDeleteKeystroke(key('Backspace', { ctrlKey: true }))).toBe(false);
    expect(isDeleteKeystroke(key('Backspace', { altKey: true }))).toBe(false);
  });

  it('any other key is not ours', () => {
    expect(isDeleteKeystroke(key('d'))).toBe(false);
    expect(isDeleteKeystroke(key('Escape'))).toBe(false);
  });
});

describe('arrangeDisabledReason', () => {
  const live = { ready: true, available: true, previewing: null, busy: false };

  it('is live on a loaded pipeline with activities', () => {
    expect(arrangeDisabledReason(live)).toBeNull();
  });

  it('refuses while a save or restore is in flight', () => {
    expect(arrangeDisabledReason({ ...live, busy: true })).toBe(
      'Wait for the save or restore to finish.',
    );
  });

  it('refuses while a version is previewed, naming the working graph', () => {
    // The same hazard undo carries: the canvas is showing a version, but the
    // store still holds the working graph — so arranging would rewrite a
    // document the operator cannot see, and move `dirty` under the preview's
    // own Restore button.
    expect(arrangeDisabledReason({ ...live, previewing: 3 })).toBe(
      'Leave the preview to arrange your working graph.',
    );
  });

  it('says the pipeline is still loading rather than that it is empty', () => {
    // A canvas that has not loaded also has no nodes. Answering "Nothing to
    // arrange." there would tell an operator their pipeline is empty when it
    // is merely not here yet.
    expect(arrangeDisabledReason({ ...live, ready: false, available: false })).toBe(
      'Wait for the pipeline to load.',
    );
  });

  it('says there is nothing to arrange on a loaded, empty canvas', () => {
    expect(arrangeDisabledReason({ ...live, available: false })).toBe('Nothing to arrange.');
  });
});
