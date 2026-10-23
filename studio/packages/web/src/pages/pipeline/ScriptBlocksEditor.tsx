import { useId, useState, type ReactNode } from 'react';
import {
  SCRIPT_MAX_BLOCKS,
  sqlBindNames,
  type ScriptParameterDirection,
  type SqlDialect,
} from '@autonomy-studio/shared';
import { Toolbar } from '../../lib/PageHeader';
import { AboutHelp } from '../../lib/HelpDisclosure';
import { RequiredMark } from '../../lib/form/RequiredMark';
import { RemoveRowButton, RowList } from '../../lib/form/RowTable';
import { BindValueRow, ImportFromStatement, LiteralSqlField } from './BindValues';
import { ConfigFieldControl, type FieldPicker, type PickerTarget } from './ConfigFieldControl';
import {
  emptyControlValue,
  isRowList,
  placeRowCandidate,
  rowActionName,
  rowCellName,
  rowTitle,
  type ConfigField,
  type FieldSize,
  type ObjectListRow,
} from './configForm';
import { bindColumns, freshBindName, reconcileKeyOrder } from './inlineSource';
import {
  addBlockParam,
  blockParamNames,
  importBlockParams,
  readBlockParams,
  removeBlockParam,
  renameBlockParam,
  setBlockParamDirection,
  setBlockParamValue,
  unboundBlockNames,
  writeBlockParams,
  type ScriptBlockParams,
} from './scriptBlocks';
import { useRowMoves } from './useRowMoves';

const DIRECTION_LABELS: Record<ScriptParameterDirection, string> = {
  in: 'In',
  out: 'Out',
  inOut: 'In-out',
};

const PARAM_COLUMNS = bindColumns(false, [
  { key: 'direction', header: 'Direction', width: 'short' },
]);

const BLOCK_ABOUT =
  'Each block is one statement, literal: ${} is not evaluated in the SQL. ' +
  'Parameters give a value for each :name in the SQL, keyed without the colon; a value may be ${...}. ' +
  'Out and In-out are read back by column name from the row a CALL returns, into outputParameters ' +
  '(PostgreSQL only); an Out value is not sent. Import from statement adds a row for each :name the SQL uses.';

/**
 * #1600 OR41 C10c (catalogue §4.5) — a Script's blocks, each its own group:
 * its Type, its SQL in the C1q statement editor (one line at rest, ⤢ for more,
 * literal under §8), and a Name · Value · Direction table in place of the row
 * table's two JSON cells.
 *
 * It edits the same row-list DRAFT the generic list does (`ObjectListControl`),
 * so Apply, the JSON view and the save gate are unchanged: Type and SQL are the
 * row's own cells, and the table rewrites the `parameters` and
 * `parameterDirections` JSON cells (`scriptBlocks.ts`). A block whose cells
 * cannot be shown as rows keeps them as JSON, latched for its mount so it never
 * swaps controls under the author mid-typing.
 */
export function ScriptBlocksEditor({
  field,
  label,
  required,
  describedBy,
  rows,
  onChange,
  picker,
  help,
  dialect,
}: {
  field: ConfigField;
  label: string;
  required: boolean;
  describedBy: string | undefined;
  rows: readonly ObjectListRow[];
  onChange: (next: readonly ObjectListRow[]) => void;
  picker: FieldPicker | undefined;
  help: ReactNode;
  /** The bound connection's store, for *Import from statement* and SQLite's notes. */
  dialect: SqlDialect | undefined;
}) {
  const cells = field.elementFields ?? [];
  const { moves, move, groupRef } = useRowMoves(rows, onChange, (index, direction) =>
    rowActionName(field, index, direction),
  );
  const noteId = useId();
  const full = rows.length >= SCRIPT_MAX_BLOCKS;
  return (
    <div
      className="config-field object-list script-blocks"
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      ref={groupRef}
    >
      <div className="object-list-label help-row">
        <span>{label}</span>
        {required && <RequiredMark />}
        {/* ONE `?` for the list, as the row table had: each block's SQL and
            Parameters are explained here rather than by a `?` per block. */}
        <AboutHelp name={label} noteId={noteId}>
          {help !== null && <>{help} </>}
          {BLOCK_ABOUT}
        </AboutHelp>
      </div>
      <Toolbar align="start">
        <button type="button" disabled={full} onClick={() => onChange([...rows, {}])}>
          Add block
        </button>
        {full && (
          <span className="page-hint" role="status">
            {`A script holds at most ${String(SCRIPT_MAX_BLOCKS)} blocks`}
          </span>
        )}
      </Toolbar>
      {rows.length === 0 && <p className="page-hint">No blocks.</p>}
      {rows.map((row, index) => (
        <ScriptBlock
          // Remounted on add, remove and move, as the generic list's cells are.
          key={`${String(index)}:${String(rows.length)}:${String(moves)}`}
          field={field}
          cells={cells}
          rows={rows}
          index={index}
          picker={picker}
          dialect={dialect}
          onRow={(next) => onChange(rows.map((r, i) => (i === index ? next : r)))}
          onMove={(to) => move(index, to)}
          onRemove={() => onChange(rows.filter((_, i) => i !== index))}
        />
      ))}
    </div>
  );
}

function ScriptBlock({
  field,
  cells,
  rows,
  index,
  picker,
  dialect,
  onRow,
  onMove,
  onRemove,
}: {
  field: ConfigField;
  cells: readonly ConfigField[];
  rows: readonly ObjectListRow[];
  index: number;
  picker: FieldPicker | undefined;
  dialect: SqlDialect | undefined;
  onRow: (next: ObjectListRow) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const row = rows[index] ?? {};
  const cell = (name: string) => cells.find((c) => c.name === name);
  const params = readBlockParams(row);
  // Latched: once a cell could not be shown as rows, this mount keeps it JSON.
  const [raw, setRaw] = useState(params === null);
  if (!raw && params === null) setRaw(true);
  const cellTarget = (name: string): PickerTarget => ({
    place: (node, value) => ({
      ...node,
      config: { ...node.config, [field.name]: placeRowCandidate(field, rows, index, name, value) },
    }),
    baseline: 'probed',
  });
  const cellControl = (c: ConfigField | undefined) =>
    c === undefined ? null : (
      <ConfigFieldControl
        field={c}
        name={rowCellName(field, index, c)}
        value={row[c.name] ?? emptyControlValue(c)}
        picker={picker}
        target={cellTarget(c.name)}
        onChange={(next) => {
          if (!isRowList(next)) onRow({ ...row, [c.name]: next });
        }}
      />
    );
  const typeCell = cell('type');
  const sqlCell = cell('sql');
  const sql = typeof row['sql'] === 'string' ? row['sql'] : '';
  const blockName = `${rowTitle(field)} row ${String(index + 1)}`;
  return (
    <div className="script-block" role="group" aria-label={`Block ${String(index + 1)}`}>
      <div className="script-block__head">
        <span className="script-block__title">{`Block ${String(index + 1)}`}</span>
        <span data-size={'m' satisfies FieldSize}>{cellControl(typeCell)}</span>
        <span className="script-block__actions">
          <button
            type="button"
            aria-label={rowActionName(field, index, 'up')}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={rowActionName(field, index, 'down')}
            disabled={index === rows.length - 1}
            onClick={() => onMove(index + 1)}
          >
            ↓
          </button>
          <RemoveRowButton label={rowActionName(field, index, 'remove')} onRemove={onRemove} />
        </span>
      </div>
      {sqlCell !== undefined && (
        <LiteralSqlField
          title={sqlCell.label?.title ?? 'SQL'}
          inputLabel={rowCellName(field, index, sqlCell)}
          about={undefined}
          value={sql}
          onChange={(next) => onRow({ ...row, sql: next })}
        />
      )}
      {raw || params === null ? (
        <>
          {cellControl(cell('parameters'))}
          {cellControl(cell('parameterDirections'))}
        </>
      ) : (
        <BlockParameters
          blockName={blockName}
          params={params}
          sql={sql}
          dialect={dialect}
          picker={picker}
          target={(name) => ({
            place: (node, value) => ({
              ...node,
              config: {
                ...node.config,
                [field.name]: placeRowCandidate(
                  field,
                  rows,
                  index,
                  'parameters',
                  writeBlockParams(row, setBlockParamValue(params, name, value))[
                    'parameters'
                  ] as string,
                ),
              },
            }),
            baseline: 'probed',
          })}
          write={(next) => onRow(writeBlockParams(row, next))}
        />
      )}
    </div>
  );
}

function BlockParameters({
  blockName,
  params,
  sql,
  dialect,
  picker,
  target,
  write,
}: {
  /** "Script blocks row 1": each control's name starts with it. */
  blockName: string;
  params: ScriptBlockParams;
  sql: string;
  dialect: SqlDialect | undefined;
  picker: FieldPicker | undefined;
  target: (name: string) => PickerTarget;
  write: (next: ScriptBlockParams) => void;
}) {
  // Shown in the rows' own order, not the record's (#1725, `reconcileKeyOrder`).
  const all = blockParamNames(params);
  const [shownNames, setShownNames] = useState<readonly string[]>(() => all);
  const names = reconcileKeyOrder(shownNames, all);
  if (names !== shownNames) setShownNames(names);
  const used = dialect === undefined ? undefined : sqlBindNames(sql, dialect);
  const unbound = used === undefined ? [] : unboundBlockNames(params, used);
  const title = `${blockName} parameters`;
  return (
    <>
      <div className="object-list-label">
        <span>Parameters</span>
      </div>
      <RowList
        columns={PARAM_COLUMNS}
        label={title}
        count={names.length}
        addLabel="Add parameter"
        addTitle="A :name in the SQL, and the value bound to it"
        onAdd={() => write(addBlockParam(params, freshBindName(names)))}
        actions={
          used !== undefined && (
            <ImportFromStatement
              used={used}
              unbound={unbound}
              onImport={() => write(importBlockParams(params, unbound))}
            />
          )
        }
      >
        {names.map((name, i) => {
          const label = `${blockName} parameter ${String(i + 1)}`;
          const direction = params.directions[name] ?? 'in';
          return (
            <BindValueRow
              // By position, so renaming a row does not remount it mid-typing.
              key={i}
              label={label}
              name={name}
              value={params.parameters[name]}
              others={names.filter((n) => n !== name)}
              typed={false}
              picker={picker}
              target={target(name)}
              advisory={parameterAdvisory(params, name, used, dialect)}
              columnCount={PARAM_COLUMNS.length}
              extra={
                <td>
                  <select
                    aria-label={`${label} direction`}
                    data-size={'s' satisfies FieldSize}
                    value={direction}
                    onChange={(e) =>
                      write(
                        setBlockParamDirection(
                          params,
                          name,
                          e.target.value as ScriptParameterDirection,
                        ),
                      )
                    }
                  >
                    {(Object.keys(DIRECTION_LABELS) as ScriptParameterDirection[]).map((d) => (
                      <option key={d} value={d}>
                        {DIRECTION_LABELS[d]}
                      </option>
                    ))}
                  </select>
                </td>
              }
              onRename={(to) => write(renameBlockParam(params, name, to))}
              onValue={(v) =>
                write(setBlockParamValue(params, name, typeof v === 'string' ? v : String(v ?? '')))
              }
              onRemove={() => write(removeBlockParam(params, name))}
            />
          );
        })}
      </RowList>
    </>
  );
}

/**
 * What a row's note says, after a name problem. The two "not in the SQL" cases
 * differ at run time: an unused In value is dropped (#1194), an Out or In-out
 * name the SQL never binds is refused before the session opens (C10b-2a).
 */
function parameterAdvisory(
  params: ScriptBlockParams,
  name: string,
  used: readonly string[] | undefined,
  dialect: SqlDialect | undefined,
): string | null {
  const direction = params.directions[name] ?? 'in';
  const readsBack = direction !== 'in';
  if (used !== undefined && !used.includes(name)) {
    return readsBack
      ? 'Not in the SQL: the run refuses an Out or In-out name the SQL never binds.'
      : 'Not in the SQL, so it is not bound.';
  }
  if (readsBack && dialect === 'sqlite') {
    return 'SQLite has no Out parameters: the run refuses this direction.';
  }
  const value = params.parameters[name];
  if (direction === 'out' && value !== undefined && value !== '') {
    return 'An Out parameter’s value is not sent.';
  }
  return null;
}
