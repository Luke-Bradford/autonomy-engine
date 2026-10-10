import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OneLine } from './OneLine';

describe('OneLine', () => {
  it('cuts the text to one line and keeps the whole text in its tooltip', () => {
    render(<OneLine title="a very long connection name">a very long connection name</OneLine>);
    const cell = screen.getByText('a very long connection name');
    expect(cell.tagName).toBe('SPAN');
    expect(cell).toHaveClass('cell-one-line');
    expect(cell).not.toHaveClass('cell-one-line--wide');
    expect(cell).toHaveAttribute('title', 'a very long connection name');
  });

  it('keeps a value in the mono face and widens the one long column', () => {
    render(
      <OneLine as="code" wide title="data/in/2026/orders.csv">
        data/in/2026/orders.csv
      </OneLine>,
    );
    const cell = screen.getByText('data/in/2026/orders.csv');
    expect(cell.tagName).toBe('CODE');
    expect(cell).toHaveClass('cell-one-line', 'cell-one-line--wide');
  });
});
