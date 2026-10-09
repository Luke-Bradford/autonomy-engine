import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FieldCell, FieldGrid } from './FieldGrid';

describe('FieldGrid (#1477 OR29)', () => {
  it('is a named group only when given a label', () => {
    const { rerender } = render(
      <FieldGrid className="field-stack">
        <FieldCell span="short">a</FieldCell>
      </FieldGrid>,
    );
    expect(screen.queryByRole('group')).toBeNull();
    rerender(
      <FieldGrid label="Config">
        <FieldCell span="long">a</FieldCell>
      </FieldGrid>,
    );
    expect(screen.getByRole('group', { name: 'Config' })).toBeDefined();
  });

  it('marks each cell with its span, as a direct child of the grid', () => {
    const { container } = render(
      <FieldGrid className="field-stack">
        <FieldCell span="short">a</FieldCell>
        <FieldCell span="long">b</FieldCell>
      </FieldGrid>,
    );
    const grid = container.querySelector('.config-editor.field-stack')!;
    expect(
      Array.from(grid.children, (c) => [c.className, c.getAttribute('data-field-span')]),
    ).toEqual([
      ['config-cell', 'short'],
      ['config-cell', 'long'],
    ]);
  });
});
