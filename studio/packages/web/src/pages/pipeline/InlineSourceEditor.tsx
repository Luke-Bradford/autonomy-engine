import { useState, type ReactNode } from 'react';
import {
  DATASET_CONNECTION_KINDS,
  INLINE_DATASET_KINDS,
  datasetConfigSchema,
  datasetConnectionKindAdvisory,
  type ConnectionKind,
  type DatasetKind,
  type InlineDataset,
  type InlineDatasetKind,
  type Node,
} from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { AutoGrowTextarea } from '../../lib/form/AutoGrowTextarea';
import {
  RemoveRowButton,
  RowActions,
  RowList,
  RowNotes,
  type RowTableColumn,
} from '../../lib/form/RowTable';
import { EDIT_ROWS, type FieldPicker, type PickerTarget } from './ConfigFieldControl';
import {
  configFieldTitle,
  deriveConfigFields,
  fieldSize,
  type ConfigField,
  type FieldSize,
} from './configForm';
import type { createCanvasStore } from './canvasStore';
import { ExpressionEditor } from './ExpressionEditor';
import { PickableInput } from './PickableInput';

type Use = 'saved' | InlineDatasetKind;

const USE_LABELS: Record<Use, string> = {
  saved: 'Saved dataset',
  table: 'Table',
  query: 'Query',
};

const PARAM_COLUMNS: readonly RowTableColumn[] = [
  { key: 'name', header: 'Name', width: 'short' },
  { key: 'value', header: 'Value', width: 'long' },
];

/** What a newly chosen Table or Query starts as: the fields to fill, nothing carried. */
const BLANK: Record<InlineDatasetKind, InlineDataset> = {
  table: { kind: 'table', config: { table: '' } },
  query: { kind: 'query', config: { sql: '' } },
};

/**
 * Each kind's fields, read from the dataset schema both a saved and an inline
 * source are checked against, so their titles, notes and sizes are the saved
 * dataset form's and cannot drift from it.
 */
const FIELDS: Record<InlineDatasetKind, ReadonlyMap<string, ConfigField>> = {
  table: fieldsOf('table'),
  query: fieldsOf('query'),
};

function fieldsOf(kind: InlineDatasetKind): ReadonlyMap<string, ConfigField> {
  return new Map((deriveConfigFields(datasetConfigSchema(kind)) ?? []).map((f) => [f.name, f]));
}

function field(kind: InlineDatasetKind, name: string): ConfigField {
  const found = FIELDS[kind].get(name);
  if (found === undefined) throw new Error(`the ${kind} dataset schema has no '${name}'`);
  return found;
}

/** A field's `?`: its schema note, then (for a name) that it is never an expression. */
function about(f: ConfigField, extra?: string) {
  const note = [f.label?.description, extra].filter((s) => s !== undefined).join(' ');
  return note === '' ? undefined : { name: configFieldTitle(f), note };
}

/**
 * #1600 OR41 C1q-b (catalogue spec §4.1, Source "Database" row) — a database
 * source's **Use** Saved dataset · Table · Query, for every activity whose
 * source end takes a `table` or `query` dataset (Copy, Lookup).
 *
 * Saved dataset is the existing picker (`saved`). Table and Query write
 * `Node.inlineDatasets.source` through `setNodeInlineSource`, so the source is
 * read straight from the bound connection with no saved dataset. Each keystroke
 * writes through, coalesced per field into one undo step, as the override rows
 * do: there is no Apply to forget. The choice shown is read from the node, so
 * undo moves it too.
 *
 * The SQL, table and schema are LITERAL (catalogue §8): only a bind value takes
 * ⓕ, so a value can never become SQL and a name never comes from an expression.
 * The save gate says so too (`validateInlineDatasets`); this form simply offers
 * no ⓕ where the gate would refuse one, and the SQL's ⤢ editor has no flyout.
 *
 * The choice shows when the bound source connection is a store an inline kind
 * can live in, or when an inline source is already stored (a stored value is
 * never hidden; one under a connection that cannot hold it says so).
 */
export function InlineSourceEditor({
  store,
  node,
  sourceKinds,
  connectionKind,
  picker,
  saved,
}: {
  store: ReturnType<typeof createCanvasStore>;
  node: Node;
  /** The activity's `datasetKinds.source`. */
  sourceKinds: readonly DatasetKind[];
  /** The kind of the connection bound to the source end, when one is known. */
  connectionKind: ConnectionKind | undefined;
  picker: FieldPicker | undefined;
  /** The Saved dataset picker and its overrides. */
  saved: ReactNode;
}) {
  const inline = node.inlineDatasets?.source;
  const fits = (k: InlineDatasetKind) =>
    connectionKind !== undefined && DATASET_CONNECTION_KINDS[k].includes(connectionKind);
  const kinds = INLINE_DATASET_KINDS.filter((k) => sourceKinds.includes(k) && fits(k));
  if (inline === undefined && kinds.length === 0) return <>{saved}</>;

  const use: Use = inline?.kind ?? 'saved';
  // A stored kind stays a choice even when the connection no longer suits it.
  const choices: Use[] = [
    'saved',
    ...INLINE_DATASET_KINDS.filter((k) => kinds.includes(k) || k === use),
  ];
  const write = (next: InlineDataset | undefined, coalesceKey?: string) =>
    store.getState().setNodeInlineSource(node.id, next, coalesceKey);
  const mismatch =
    inline === undefined || connectionKind === undefined
      ? null
      : datasetConnectionKindAdvisory(inline.kind, connectionKind);

  return (
    <>
      <LabelledControl
        label="Use"
        about={{
          name: 'Use',
          note: 'Saved dataset binds a dataset from Manage. Table and Query read the source connection directly, with no saved dataset.',
        }}
      >
        {(id, describedBy) => (
          <select
            id={id}
            aria-describedby={describedBy}
            data-size={'m' satisfies FieldSize}
            value={use}
            onChange={(e) => {
              const next = e.target.value as Use;
              if (next === use) return;
              write(next === 'saved' ? undefined : BLANK[next]);
            }}
          >
            {choices.map((c) => (
              <option key={c} value={c}>
                {USE_LABELS[c]}
              </option>
            ))}
          </select>
        )}
      </LabelledControl>
      {inline === undefined && saved}
      {inline?.kind === 'table' && <TableFields inline={inline} write={write} />}
      {inline?.kind === 'query' && <QueryFields inline={inline} write={write} picker={picker} />}
      {mismatch !== null && (
        <p className="contract-advisory" role="status">
          The inline source’s {mismatch}.
        </p>
      )}
    </>
  );
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : String(value);
}

const LITERAL_NAME = 'A literal name, never an expression.';

function TableFields({
  inline,
  write,
}: {
  inline: InlineDataset;
  write: (next: InlineDataset, coalesceKey?: string) => void;
}) {
  const set = (key: 'schema' | 'table', value: string) => {
    const config = { ...inline.config };
    // An empty schema is no schema: the key is dropped rather than stored as ''.
    if (key === 'schema' && value === '') delete config['schema'];
    else config[key] = value;
    write({ kind: 'table', config }, key);
  };
  return (
    <>
      {(['schema', 'table'] as const).map((key) => {
        const f = field('table', key);
        return (
          <LabelledControl key={key} label={configFieldTitle(f)} about={about(f, LITERAL_NAME)}>
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                aria-required={!f.optional || undefined}
                data-size={fieldSize(f)}
                spellCheck={false}
                value={text(inline.config[key])}
                onChange={(e) => set(key, e.target.value)}
              />
            )}
          </LabelledControl>
        );
      })}
    </>
  );
}

function QueryFields({
  inline,
  write,
  picker,
}: {
  inline: InlineDataset;
  write: (next: InlineDataset, coalesceKey?: string) => void;
  picker: FieldPicker | undefined;
}) {
  const raw = inline.config['parameters'];
  const parameters: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const names = Object.keys(parameters);
  const sqlField = field('query', 'sql');
  const sqlTitle = configFieldTitle(sqlField);
  const bindTitle = configFieldTitle(field('query', 'parameters'));
  const sql = text(inline.config['sql']);
  const setSql = (next: string) =>
    write({ kind: 'query', config: { ...inline.config, sql: next } }, 'sql');

  const withParameters = (next: Record<string, unknown>): InlineDataset => {
    const config = { ...inline.config };
    if (Object.keys(next).length > 0) config['parameters'] = next;
    else delete config['parameters'];
    return { kind: 'query', config };
  };
  const rename = (from: string, to: string, i: number) => {
    // Rebuilt in order, so the row does not jump to the end of the table.
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parameters)) next[k === from ? to : k] = v;
    write(withParameters(next), `param:${i}:name`);
  };

  return (
    <>
      <LabelledControl
        label={sqlTitle}
        about={about(sqlField, 'Literal: ${} is not evaluated here.')}
      >
        {(id, describedBy) => (
          <>
            <AutoGrowTextarea
              id={id}
              aria-describedby={describedBy}
              aria-required
              restRows={1}
              maxRows={EDIT_ROWS}
              spellCheck={false}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
            />
            {/* No picker: the statement is literal, so its editor offers no `${}`.
                In the toggle row a config field's ⤢ sits in. */}
            <div className="expression-picker">
              <ExpressionEditor
                fieldName={sqlTitle}
                value={sql}
                onChange={setSql}
                singleLine={false}
              />
            </div>
          </>
        )}
      </LabelledControl>
      <RowList
        columns={PARAM_COLUMNS}
        label={bindTitle}
        count={names.length}
        addLabel="Add bind value"
        addTitle="A :name in the statement, and the value bound to it"
        onAdd={() => write(withParameters({ ...parameters, [freshName(names)]: '' }))}
      >
        {names.map((name, i) => (
          <ParameterRow
            // By position, so renaming a row does not remount it mid-typing.
            key={i}
            index={i}
            name={name}
            value={parameters[name]}
            others={names.filter((n) => n !== name)}
            picker={picker}
            onRename={(to) => rename(name, to, i)}
            onValue={(v) => write(withParameters({ ...parameters, [name]: v }), `param:${i}:value`)}
            onRemove={() => {
              const next = { ...parameters };
              delete next[name];
              write(withParameters(next));
            }}
          />
        ))}
      </RowList>
    </>
  );
}

/** `p1`, `p2`, … — the first not already taken; the author renames it to the statement's `:name`. */
function freshName(taken: readonly string[]): string {
  for (let i = 1; ; i += 1) if (!taken.includes(`p${i}`)) return `p${i}`;
}

/** Why a typed bind-value name cannot be stored, or `null` when it can. */
function bindNameProblem(draft: string, others: readonly string[]): string | null {
  if (draft === '') return 'Name it as it is written after : in the statement.';
  // Keys are stored WITHOUT the colon, so `:wm` would silently never bind.
  if (draft.startsWith(':')) return 'Leave out the leading :.';
  if (others.includes(draft)) return `:${draft} is already bound.`;
  return null;
}

/**
 * One `:name` and its value. The name box shows a local DRAFT: a name that
 * cannot be a key of the stored record (blank, a leading `:`, a duplicate) is
 * held here with its reason until it can be, and the stored row keeps its last
 * good name.
 */
function ParameterRow({
  index,
  name,
  value,
  others,
  picker,
  onRename,
  onValue,
  onRemove,
}: {
  index: number;
  name: string;
  value: unknown;
  others: readonly string[];
  picker: FieldPicker | undefined;
  onRename: (to: string) => void;
  onValue: (value: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const [synced, setSynced] = useState(name);
  if (synced !== name) {
    setSynced(name);
    setDraft(name);
  }
  const problem = draft === name ? null : bindNameProblem(draft, others);
  const label = `Bind value ${index + 1}`;
  const target: PickerTarget = {
    place: (n, v) => {
      const source = n.inlineDatasets?.source;
      if (source === undefined) return n;
      const current = source.config['parameters'];
      const params = current !== null && typeof current === 'object' ? current : {};
      return {
        ...n,
        inlineDatasets: {
          source: { ...source, config: { ...source.config, parameters: { ...params, [name]: v } } },
        },
      };
    },
    baseline: 'stored',
  };
  return (
    <>
      <tr>
        <td>
          <input
            aria-label={`${label} name`}
            aria-invalid={problem !== null || undefined}
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              const to = e.target.value;
              setDraft(to);
              if (bindNameProblem(to, others) === null) onRename(to);
            }}
          />
        </td>
        <td>
          <PickableInput
            value={text(value)}
            onChange={onValue}
            picker={picker}
            pickerName={`:${name}`}
            target={target}
          >
            <span className="visually-hidden">{`${label} value`}</span>
          </PickableInput>
        </td>
        <RowActions>
          <RemoveRowButton label={`Remove bind value ${index + 1}`} onRemove={onRemove} />
        </RowActions>
      </tr>
      {problem !== null && (
        <RowNotes span={PARAM_COLUMNS.length + 1}>
          <p className="contract-advisory">{problem}</p>
        </RowNotes>
      )}
    </>
  );
}
