import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AutoGrowTextarea } from './AutoGrowTextarea';

/*
 * jsdom does no layout, so the browser's part is stubbed: `scrollHeight` reads
 * 20px per line of the value, and the computed style is a 20px line with 4px
 * padding and a 1px border, border-box. What is under test is the sizing rule.
 */
const LINE = 20;
const proto = HTMLTextAreaElement.prototype;

function stubLayout() {
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split('\n').length * LINE + 8;
    },
  });
}

function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AutoGrowTextarea
      aria-label="description"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="grow-under-test"
    />
  );
}

describe('AutoGrowTextarea', () => {
  afterEach(() => {
    cleanup();
    document.head.querySelectorAll('style[data-grow]').forEach((el) => el.remove());
    vi.unstubAllGlobals();
    // The layout stubs are own properties of the textarea prototype; deleting
    // them puts back jsdom's own (inherited from Element).
    delete (proto as { scrollHeight?: number }).scrollHeight;
    delete (proto as { clientWidth?: number }).clientWidth;
  });

  function mount(initial?: string) {
    stubLayout();
    const style = document.createElement('style');
    style.dataset.grow = '';
    style.textContent =
      '.grow-under-test { line-height: 20px; padding: 4px 0; border: 1px solid; box-sizing: border-box; }';
    document.head.appendChild(style);
    render(<Controlled initial={initial} />);
    return screen.getByLabelText('description') as HTMLTextAreaElement;
  }

  it('is one line tall when empty', () => {
    const box = mount();
    expect(box.rows).toBe(1);
    expect(box.style.height).toBe('30px');
    expect(box.style.overflowY).toBe('hidden');
  });

  it('grows a line at a time with what is typed', () => {
    const box = mount();
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.style.height).toBe('70px');
    expect(box.style.overflowY).toBe('hidden');
  });

  it('stops at four lines and scrolls past them', () => {
    const box = mount();
    fireEvent.change(box, { target: { value: 'a\nb\nc\nd\ne\nf' } });
    // 4 lines × 20 + 8 padding + 2 border.
    expect(box.style.height).toBe('90px');
    expect(box.style.overflowY).toBe('auto');
  });

  it('shrinks again when lines are removed', () => {
    const box = mount('a\nb\nc\nd\ne');
    expect(box.style.height).toBe('90px');
    fireEvent.change(box, { target: { value: 'a' } });
    expect(box.style.height).toBe('30px');
  });

  it('hidden, with nothing to measure, keeps its natural row rather than a height of nothing', () => {
    const box = mount('a\nb');
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => 0,
    });
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.style.height).toBe('auto');
  });

  it('measures again when its width changes — a box shown after mounting hidden', () => {
    let observed: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    let width = 0;
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get: () => width,
    });
    const box = mount('a\nb');
    // Hidden at mount: nothing to measure.
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => 0,
    });
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.style.height).toBe('auto');
    // Shown: it has a width now, and is sized to what it holds.
    stubLayout();
    width = 300;
    act(() => observed?.());
    expect(box.style.height).toBe('70px');
  });

  it('puts back the scroll of an ancestor the measure collapsed', () => {
    const box = mount('a');
    const pane = box.parentElement!;
    pane.scrollTop = 120;
    let collapsedAt: number | undefined;
    // jsdom does not clamp, so the browser's clamp is played here: the moment
    // the box collapses, its pane's scroll is lost.
    const style = box.style;
    const orig = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), 'height')!;
    Object.defineProperty(style, 'height', {
      configurable: true,
      get: () => orig.get!.call(style) as string,
      set: (v: string) => {
        orig.set!.call(style, v);
        if (v === 'auto') {
          collapsedAt = pane.scrollTop;
          pane.scrollTop = 0;
        }
      },
    });
    fireEvent.change(box, { target: { value: 'a\nb' } });
    expect(collapsedAt).toBe(120);
    expect(pane.scrollTop).toBe(120);
  });

  it('caps at the rows it is given', () => {
    stubLayout();
    const style = document.createElement('style');
    style.dataset.grow = '';
    style.textContent =
      '.grow-two { line-height: 20px; padding: 4px 0; border: 1px solid; box-sizing: content-box; }';
    document.head.appendChild(style);
    render(
      <AutoGrowTextarea
        aria-label="two"
        className="grow-two"
        maxRows={2}
        value={'a\nb\nc'}
        readOnly
      />,
    );
    // content-box: the height is the lines alone, padding and border outside it.
    expect((screen.getByLabelText('two') as HTMLTextAreaElement).style.height).toBe('40px');
  });

  describe('expand on edit (restRows)', () => {
    function Editing({ initial, restRows = 1 }: { initial: string; restRows?: number }) {
      const [value, setValue] = useState(initial);
      return (
        <AutoGrowTextarea
          aria-label="expression"
          className="grow-under-test"
          restRows={restRows}
          maxRows={8}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }

    function mountEditing(initial: string, restRows?: number) {
      stubLayout();
      const style = document.createElement('style');
      style.dataset.grow = '';
      style.textContent =
        '.grow-under-test { line-height: 20px; padding: 4px 0; border: 1px solid; box-sizing: border-box; }';
      document.head.appendChild(style);
      render(<Editing initial={initial} restRows={restRows} />);
      return screen.getByLabelText('expression') as HTMLTextAreaElement;
    }

    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${String(i)}`).join('\n');
    const press = (type: string, init: { button?: number; ctrlKey?: boolean } = {}) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { button: init.button ?? 0, ctrlKey: init.ctrlKey ?? false });
      fireEvent(document.body, e);
    };
    const settle = () =>
      act(() => {
        vi.runAllTimers();
      });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rests at one line, its rest out of sight, and grows to eight while focused', () => {
      const box = mountEditing(lines(12));
      expect(box.style.height).toBe('30px');
      expect(box.style.overflowY).toBe('hidden');
      expect(box.dataset.grow).toBe('edit');
      fireEvent.focus(box);
      // 8 lines × 20 + 8 padding + 2 border, and it scrolls past them.
      expect(box.style.height).toBe('170px');
      expect(box.style.overflowY).toBe('auto');
    });

    it('collapses a task after a blur with no press in progress, back on its first line', () => {
      const box = mountEditing(lines(12));
      fireEvent.focus(box);
      box.scrollTop = 100;
      fireEvent.blur(box);
      // A tap's click follows its focus change in the same task.
      expect(box.style.height).toBe('170px');
      settle();
      expect(box.style.height).toBe('30px');
      expect(box.scrollTop).toBe(0);
    });

    it('a blur during a press collapses only after the press ends and its click is dispatched', () => {
      const box = mountEditing(lines(3));
      fireEvent.focus(box);
      expect(box.style.height).toBe('70px');
      press('pointerdown');
      fireEvent.blur(box);
      settle();
      // Still tall: the control under the pointer has not moved.
      expect(box.style.height).toBe('70px');
      press('pointerup');
      expect(box.style.height).toBe('70px');
      settle();
      expect(box.style.height).toBe('30px');
    });

    it('a cancelled press, or one that opens a context menu, still collapses', () => {
      for (const end of ['pointercancel', 'contextmenu']) {
        const box = mountEditing(lines(3));
        fireEvent.focus(box);
        press('pointerdown');
        fireEvent.blur(box);
        press(end);
        settle();
        expect(box.style.height, end).toBe('30px');
        cleanup();
      }
    });

    it('a secondary or ctrl press is not held for: its pointerup may never come', () => {
      for (const init of [{ button: 2 }, { ctrlKey: true }]) {
        const box = mountEditing(lines(3));
        fireEvent.focus(box);
        press('pointerdown', init);
        fireEvent.blur(box);
        settle();
        expect(box.style.height, JSON.stringify(init)).toBe('30px');
        cleanup();
      }
    });

    it('focus returning before the deferred collapse keeps it open', () => {
      const box = mountEditing(lines(3));
      fireEvent.focus(box);
      press('pointerdown');
      fireEvent.blur(box);
      press('pointerup');
      fireEvent.focus(box);
      settle();
      expect(box.style.height).toBe('70px');
    });

    it('unmounting with a collapse pending leaves no timer behind', () => {
      const box = mountEditing(lines(3));
      fireEvent.focus(box);
      fireEvent.blur(box);
      cleanup();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a rest cap above the edit cap is clamped to it', () => {
      const box = mountEditing(lines(12), 20);
      expect(box.style.height).toBe('170px');
    });

    it('passes the caller its element through `ref`', () => {
      stubLayout();
      const ref = { current: null as HTMLTextAreaElement | null };
      render(<AutoGrowTextarea aria-label="reffed" ref={ref} value="" readOnly />);
      expect(ref.current).toBe(screen.getByLabelText('reffed'));
    });
  });

  it('without restRows a blur leaves its height alone', () => {
    const box = mount('a\nb\nc');
    fireEvent.focus(box);
    fireEvent.blur(box);
    expect(box.style.height).toBe('70px');
    expect(box.hasAttribute('data-grow')).toBe(false);
  });
});
