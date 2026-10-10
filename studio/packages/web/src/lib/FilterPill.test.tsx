import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterPill } from './FilterPill';

afterEach(cleanup);

describe('FilterPill', () => {
  it('marks an applied filter and has no ✕ without onRemove', () => {
    const { container } = render(
      <FilterPill name="Status" active>
        <select aria-label="Status" />
      </FilterPill>,
    );
    expect(container.querySelector('.filter-pill')).toHaveAttribute('data-active');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names its ✕ after the axis and calls onRemove', async () => {
    const onRemove = vi.fn();
    const { container } = render(
      <FilterPill name="Pipeline" active={false} onRemove={onRemove}>
        <select aria-label="Pipeline" />
      </FilterPill>,
    );
    expect(container.querySelector('.filter-pill')).not.toHaveAttribute('data-active');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Pipeline filter' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
