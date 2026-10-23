import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SCRIPT_MAX_BLOCKS, scriptConfigSchema, type SqlDialect } from '@autonomy-studio/shared';
import { ScriptBlocksEditor } from './ScriptBlocksEditor';
import { deriveConfigFields, type ObjectListRow } from './configForm';

const blocksField = deriveConfigFields(scriptConfigSchema)!.find((f) => f.name === 'blocks')!;
const json = (v: unknown) => JSON.stringify(v, null, 2);

function setup(initial: readonly ObjectListRow[], dialect: SqlDialect | undefined = 'postgres') {
  const latest: { rows: readonly ObjectListRow[] } = { rows: initial };
  function Harness() {
    const [rows, setRows] = useState(initial);
    return (
      <ScriptBlocksEditor
        field={blocksField}
        label="Script blocks"
        required
        describedBy={undefined}
        rows={rows}
        onChange={(next) => {
          latest.rows = next;
          setRows(next);
        }}
        picker={undefined}
        help={null}
        dialect={dialect}
      />
    );
  }
  render(<Harness />);
  return latest;
}

const box = (name: string) => screen.getByLabelText(name, { exact: true });

describe('#1600 C10c — a Script’s blocks, each with a Name · Value · Direction table', () => {
  it('draws each block’s Type, SQL and parameters, with no JSON cell', () => {
    setup([
      {
        type: 'nonQuery',
        sql: 'CALL p(:a, :total)',
        parameters: json({ a: '${x}' }),
        parameterDirections: json({ total: 'out' }),
      },
      { type: 'query', sql: 'SELECT 1' },
    ]);
    expect(box('Script blocks row 1 type')).toHaveProperty('value', 'nonQuery');
    expect(box('Script blocks row 2 type')).toHaveProperty('value', 'query');
    expect(box('Script blocks row 1 SQL')).toHaveProperty('value', 'CALL p(:a, :total)');
    expect(box('Script blocks row 1 parameter 1 name')).toHaveProperty('value', 'a');
    expect(box('Script blocks row 1 parameter 1 value')).toHaveProperty('value', '${x}');
    expect(box('Script blocks row 1 parameter 1 direction')).toHaveProperty('value', 'in');
    // A name with only a direction is a row of its own: an Out needs no value.
    expect(box('Script blocks row 1 parameter 2 name')).toHaveProperty('value', 'total');
    expect(box('Script blocks row 1 parameter 2 direction')).toHaveProperty('value', 'out');
    expect(screen.queryByLabelText(/JSON/)).toBeNull();
  });

  it('writes a value, a direction and a rename back into the block’s cells', () => {
    const latest = setup([
      { type: 'nonQuery', sql: 'CALL p(:a, :b)', parameters: json({ a: '1', b: '2' }) },
    ]);
    fireEvent.change(box('Script blocks row 1 parameter 1 value'), { target: { value: '7' } });
    fireEvent.change(box('Script blocks row 1 parameter 2 direction'), {
      target: { value: 'inOut' },
    });
    fireEvent.change(box('Script blocks row 1 parameter 2 name'), { target: { value: 'c' } });
    expect(latest.rows[0]).toMatchObject({
      parameters: json({ a: '7', c: '2' }),
      parameterDirections: json({ c: 'inOut' }),
    });
    // In clears the entry: In is the default.
    fireEvent.change(box('Script blocks row 1 parameter 2 direction'), { target: { value: 'in' } });
    expect(latest.rows[0]?.['parameterDirections']).toBe('');
  });

  it('keeps a renamed row in place when its new name is integer-like (#1725)', () => {
    setup([{ type: 'query', sql: 'SELECT :a, :p1', parameters: json({ a: '', p1: '' }) }]);
    fireEvent.change(box('Script blocks row 1 parameter 2 name'), { target: { value: '1' } });
    expect(box('Script blocks row 1 parameter 1 name')).toHaveProperty('value', 'a');
    expect(box('Script blocks row 1 parameter 2 name')).toHaveProperty('value', '1');
  });

  it('imports the SQL’s unbound :names, counting a name with only a direction as bound', () => {
    const latest = setup([
      {
        type: 'nonQuery',
        sql: 'CALL p(:a, :total, :b)',
        parameterDirections: json({ total: 'out' }),
      },
    ]);
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Not bound: :a, :b');
    fireEvent.click(screen.getByRole('button', { name: 'Import from statement' }));
    expect(latest.rows[0]).toMatchObject({
      parameters: json({ a: '', b: '' }),
      parameterDirections: json({ total: 'out' }),
    });
  });

  it('tells an unused In from an unused Out, and says SQLite has no Out parameters', () => {
    setup(
      [
        {
          type: 'nonQuery',
          sql: 'UPDATE t SET x = :a',
          parameters: json({ a: '1', gone: '2' }),
          parameterDirections: json({ a: 'out', ghost: 'inOut' }),
        },
      ],
      'sqlite',
    );
    expect(
      screen.getByText('SQLite has no Out parameters: the run refuses this direction.'),
    ).toBeTruthy();
    expect(screen.getByText('Not in the SQL, so it is not bound.')).toBeTruthy();
    expect(
      screen.getByText(
        'Not in the SQL: the run refuses an Out or In-out name the SQL never binds.',
      ),
    ).toBeTruthy();
  });

  it('keeps a block whose cells are not rows as JSON, and does not swap it mid-typing', () => {
    const latest = setup([{ type: 'query', sql: 'SELECT :a', parameters: '{"a": ' }]);
    const cell = box('Script blocks row 1 parameters — JSON');
    expect(screen.queryByLabelText('Script blocks row 1 parameter 1 name')).toBeNull();
    fireEvent.change(cell, { target: { value: '{"a": "1"}' } });
    expect(latest.rows[0]?.['parameters']).toBe('{"a": "1"}');
    // Still the JSON cell: valid now, but the swap waits for a remount.
    expect(box('Script blocks row 1 parameters — JSON')).toBeTruthy();
    expect(screen.queryByLabelText('Script blocks row 1 parameter 1 name')).toBeNull();
  });

  it('adds a block with no Type chosen, moves and removes blocks', () => {
    const latest = setup([{ type: 'query', sql: 'SELECT 1' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    expect(latest.rows).toHaveLength(2);
    expect(latest.rows[1]).toEqual({});
    // Type is required with no default, so a new block picks nothing for the author.
    expect(box('Script blocks row 2 type')).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: 'Move script blocks row 1 down' }));
    expect(latest.rows[1]).toEqual({ type: 'query', sql: 'SELECT 1' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move script blocks row 2 up');
    fireEvent.click(screen.getByRole('button', { name: 'Remove script blocks row 1' }));
    expect(latest.rows).toEqual([{ type: 'query', sql: 'SELECT 1' }]);
  });

  it(`stops adding at ${String(SCRIPT_MAX_BLOCKS)} blocks`, () => {
    setup(Array.from({ length: SCRIPT_MAX_BLOCKS }, () => ({ type: 'query', sql: 'SELECT 1' })));
    expect(screen.getByRole('button', { name: 'Add block' })).toHaveProperty('disabled', true);
  });
});
