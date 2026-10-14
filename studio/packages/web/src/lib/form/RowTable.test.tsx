import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RowList } from './RowTable';

function list(count: number, addDisabled: boolean) {
  return render(
    <RowList
      columns={[{ key: 'name', header: 'Name' }]}
      label="Things"
      count={count}
      addLabel="Add thing"
      onAdd={() => {}}
      addDisabled={addDisabled}
      addTitle="Up to 2"
      addDisabledNote="Limit of 2 reached"
    >
      <tr>
        <td>a</td>
      </tr>
    </RowList>,
  );
}

describe('RowList (#1694 OR42)', () => {
  it('says why Add is disabled in a visible status, not only in its hover', () => {
    list(2, true);
    expect(screen.getByRole('button', { name: 'Add thing' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Limit of 2 reached');
  });

  it('shows no note while Add is enabled, keeping the hover', () => {
    list(1, false);
    expect(screen.getByRole('button', { name: 'Add thing' })).toHaveAttribute('title', 'Up to 2');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('puts Add above the rows', () => {
    const { container } = list(1, false);
    const add = screen.getByRole('button', { name: 'Add thing' });
    const table = container.querySelector('table')!;
    expect(add.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
