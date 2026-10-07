import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { AutoGrowTextarea } from './AutoGrowTextarea';

/*
 * jsdom does no layout, so the browser's part is stubbed: `scrollHeight` reads
 * 20px per line of the value, and the computed style is a 20px line with 4px
 * padding and a 1px border, border-box. What is under test is the sizing rule.
 */
const LINE = 20;
function stubLayout() {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
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
  afterEach(cleanup);

  function mount(initial?: string) {
    stubLayout();
    const style = document.createElement('style');
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
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 0,
    });
    fireEvent.change(box, { target: { value: 'a\nb\nc' } });
    expect(box.style.height).toBe('auto');
  });
});
