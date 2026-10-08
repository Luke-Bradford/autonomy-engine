import { afterEach, describe, expect, it } from 'vitest';
import { isDockDrawerEscape } from './dockExpand';

/**
 * #1477 OR29 — which Escape returns the expanded property dock to its place.
 * Built from real DOM, the way the dock's `onKeyDown` sees it: `currentTarget`
 * is the dock, `target` whatever had focus.
 */
function setup() {
  const dock = document.createElement('div');
  const field = document.createElement('input');
  dock.append(field);
  const outside = document.createElement('button');
  document.body.append(dock, outside);
  return { dock, field, outside };
}

function escape(
  dock: Element,
  target: EventTarget,
  init: { key?: string; defaultPrevented?: boolean; isComposing?: boolean } = {},
) {
  return isDockDrawerEscape({
    key: init.key ?? 'Escape',
    defaultPrevented: init.defaultPrevented ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false },
    target,
    currentTarget: dock,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('isDockDrawerEscape', () => {
  it('takes a plain Escape from a field in the dock', () => {
    const { dock, field } = setup();
    expect(escape(dock, field)).toBe(true);
  });

  it('ignores every other key', () => {
    const { dock, field } = setup();
    expect(escape(dock, field, { key: 'Enter' })).toBe(false);
    expect(escape(dock, field, { key: 'Esc' })).toBe(false);
  });

  it('leaves an Escape a control inside has already handled', () => {
    const { dock, field } = setup();
    expect(escape(dock, field, { defaultPrevented: true })).toBe(false);
  });

  it('leaves an Escape that ends an IME composition', () => {
    const { dock, field } = setup();
    expect(escape(dock, field, { isComposing: true })).toBe(false);
  });

  it('leaves an Escape that closes an open combobox list first', () => {
    const { dock, field } = setup();
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-expanded', 'true');
    expect(escape(dock, field)).toBe(false);
    // Closed, the next Escape is the dock's.
    field.setAttribute('aria-expanded', 'false');
    expect(escape(dock, field)).toBe(true);
  });

  it("does not mistake the dock's own expanded toggles for an open popup", () => {
    const { dock } = setup();
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-expanded', 'true');
    dock.append(toggle);
    expect(escape(dock, toggle)).toBe(true);
  });

  it('leaves a key whose target is not a DOM node', () => {
    const { dock } = setup();
    expect(escape(dock, new EventTarget())).toBe(false);
  });

  it('leaves an Escape that arrived through a portal (a menu outside the dock)', () => {
    const { dock, outside } = setup();
    expect(escape(dock, outside)).toBe(false);
  });

  it('leaves every Escape while a modal dialog is up', () => {
    const { dock, field } = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    expect(escape(dock, field)).toBe(false);
  });
});
