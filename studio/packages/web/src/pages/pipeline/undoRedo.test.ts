import { describe, expect, it } from 'vitest';
import {
  historyCommandFor,
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
    expect(undoDisabledReason({ available: false, previewing: null, busy: false })).toBe('Nothing to undo.');
    expect(redoDisabledReason({ available: false, previewing: null, busy: false })).toBe('Nothing to redo.');
  });

  it('a preview takes the controls away, and says which document it means', () => {
    expect(undoDisabledReason({ available: true, previewing: 3, busy: false })).toMatch(/working graph/);
    expect(redoDisabledReason({ available: true, previewing: 3, busy: false })).toMatch(/working graph/);
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
    expect(undoDisabledReason({ available: false, previewing: 3, busy: false })).toMatch(/Leave the preview/);
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
