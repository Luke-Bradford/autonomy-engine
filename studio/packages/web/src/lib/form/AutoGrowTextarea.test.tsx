import { describe, expect, it, afterEach, vi } from 'vitest';
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
});
