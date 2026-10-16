import { useId, useState, type ReactNode } from 'react';
import {
  DATASET_CONNECTION_KINDS,
  INLINE_DATASET_KINDS,
  NEW_QUERY_TIMEOUT_SECONDS,
  datasetConfigSchema,
  datasetConnectionKindAdvisory,
  type ConnectionKind,
  type DatasetKind,
  type InlineDataset,
  type InlineDatasetKind,
  type Node,
  type SqlDialect,
  type SqlParameterValue,
} from '@autonomy-studio/shared';
import { AboutHelp } from '../../lib/HelpDisclosure';
import { LabelledControl } from '../../lib/LabelledControl';
import { RequiredMark } from '../../lib/form/RequiredMark';
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
import { ConnectionTables } from './ConnectionTables';
import { SourcePreview } from './SourcePreview';
import { DraftNumberField } from './DraftNumberField';
import { parseTimeoutSeconds } from '../triggers/formFields';
import {
  bindNameProblem,
  bindTypeOf,
  bindValueFor,
  bindValueText,
  freshBindName,
  isDynamicBindText,
  renameKey,
  sqlDialectOf,
  statementBindNames,
  withImportedBindNames,
  type BindType,
} from './inlineSource';

type Use = 'saved' | InlineDatasetKind;

const USE_LABELS: Record<Use, string> = {
  saved: 'Saved dataset',
  table: 'Table',
  query: 'Query',
};

const PARAM_COLUMNS: readonly RowTableColumn[] = [
  { key: 'name', header: 'Name', width: 'short' },
  { key: 'type', header: 'Type', width: 'short' },
  { key: 'value', header: 'Value', width: 'long' },
];

const BIND_TYPE_LABELS: Record<BindType, string> = {
  text: 'Text',
  number: 'Number',
  null: 'Null',
};

/** What a newly chosen Table or Query starts as: the fields to fill, nothing
 * carried. A new Query starts at ADF's two-hour query timeout (#1600 C1q-c),
 * written in so it shows and can be cleared; one stored without it has none. */
function blank(kind: InlineDatasetKind): InlineDataset {
  return kind === 'table'
    ? { kind: 'table', config: { table: '' } }
    : { kind: 'query', config: { sql: '', queryTimeoutSeconds: NEW_QUERY_TIMEOUT_SECONDS } };
}

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
  connectionId,
  picker,
  saved,
}: {
  store: ReturnType<typeof createCanvasStore>;
  node: Node;
  /** The activity's `datasetKinds.source`. */
  sourceKinds: readonly DatasetKind[];
  /** The kind of the connection bound to the source end, when one is known. */
  connectionKind: ConnectionKind | undefined;
  /** The saved source connection Preview reads; `undefined` when unset or a `${}`. */
  connectionId: string | undefined;
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
              write(next === 'saved' ? undefined : blank(next));
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
      {inline?.kind === 'table' && (
        <TableFields inline={inline} write={write} connectionId={connectionId} />
      )}
      {inline?.kind === 'query' && (
        <QueryFields
          inline={inline}
          write={write}
          picker={picker}
          dialect={sqlDialectOf(connectionKind)}
        />
      )}
      {mismatch !== null && (
        <p className="contract-advisory" role="status">
          The inline source’s {mismatch}.
        </p>
      )}
      {inline !== undefined && (
        <SourcePreview
          inline={inline}
          connectionId={connectionId}
          connectionParams={Object.keys(node.connectionParams ?? {}).length > 0}
          dialect={sqlDialectOf(connectionKind)}
        />
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
  connectionId,
}: {
  inline: InlineDataset;
  write: (next: InlineDataset, coalesceKey?: string) => void;
  connectionId: string | undefined;
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
          <LabelledControl
            key={key}
            label={
              <>
                {configFieldTitle(f)}
                {!f.optional && <RequiredMark />}
              </>
            }
            about={about(f, LITERAL_NAME)}
          >
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
      <ConnectionTables
        inline={inline}
        connectionId={connectionId}
        // One choice is one undo step: no coalesce key, so it never merges
        // into the typing before it.
        choose={({ schema, name }) => {
          const config: Record<string, unknown> = { ...inline.config, table: name };
          if (schema === null) delete config['schema'];
          else config['schema'] = schema;
          write({ kind: 'table', config });
        }}
      />
    </>
  );
}

function QueryFields({
  inline,
  write,
  picker,
  dialect,
}: {
  inline: InlineDataset;
  write: (next: InlineDataset, coalesceKey?: string) => void;
  picker: FieldPicker | undefined;
  /** The source store's dialect; without one the statement's names are not derived. */
  dialect: SqlDialect | undefined;
}) {
  const raw = inline.config['parameters'];
  const parameters: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const names = Object.keys(parameters);
  const sqlField = field('query', 'sql');
  const sqlTitle = configFieldTitle(sqlField);
  const bindField = field('query', 'parameters');
  const bindTitle = configFieldTitle(bindField);
  const bindAbout = about(
    bindField,
    'Import from statement adds a row for each :name the statement uses. On postgres an array slice such as [1:hi] reads as :hi.',
  );
  const bindLabelId = useId();
  const bindNoteId = useId();
  const sql = text(inline.config['sql']);
  const setSql = (next: string) =>
    write({ kind: 'query', config: { ...inline.config, sql: next } }, 'sql');

  const withParameters = (next: Record<string, unknown>): InlineDataset => {
    const config = { ...inline.config };
    if (Object.keys(next).length > 0) config['parameters'] = next;
    else delete config['parameters'];
    return { kind: 'query', config };
  };
  // The statement's names, as its store's lexer finds them: what Import adds,
  // and what a stored row is checked against.
  const used = dialect === undefined ? undefined : statementBindNames(inline, dialect);
  const unbound = used?.filter((n) => !Object.prototype.hasOwnProperty.call(parameters, n)) ?? [];
  const rename = (from: string, to: string, i: number) =>
    write(withParameters(renameKey(parameters, from, to)), `param:${i}:name`);
  const timeoutField = field('query', 'queryTimeoutSeconds');
  const storedTimeout = inline.config['queryTimeoutSeconds'];
  const setTimeoutSeconds = (next: number | undefined) => {
    const config = { ...inline.config };
    if (next === undefined) delete config['queryTimeoutSeconds'];
    else config['queryTimeoutSeconds'] = next;
    write({ kind: 'query', config });
  };

  return (
    <>
      <LabelledControl
        label={
          <>
            {sqlTitle}
            <RequiredMark />
          </>
        }
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
                The wrapper is the toggle row a config field's ⤢ sits in. OK is
                its own undo step, not merged into the typing before it. */}
            <div className="expression-picker">
              <ExpressionEditor
                fieldName={sqlTitle}
                value={sql}
                onChange={(next) =>
                  write({ kind: 'query', config: { ...inline.config, sql: next } })
                }
                singleLine={false}
              />
            </div>
          </>
        )}
      </LabelledControl>
      {/* The list's title and `?`, as a config field's row list draws them. */}
      <div className="object-list-label help-row">
        <span id={bindLabelId}>{bindTitle}</span>
        {bindAbout !== undefined && (
          <AboutHelp name={bindAbout.name} noteId={bindNoteId}>
            {bindAbout.note}
          </AboutHelp>
        )}
      </div>
      <RowList
        columns={PARAM_COLUMNS}
        label={bindTitle}
        count={names.length}
        addLabel="Add bind value"
        addTitle="A :name in the statement, and the value bound to it"
        onAdd={() => write(withParameters({ ...parameters, [freshBindName(names)]: '' }))}
        actions={
          used !== undefined && (
            <>
              <button
                type="button"
                disabled={unbound.length === 0}
                title="Add a row for each :name in the statement that has no value yet"
                onClick={() => write(withParameters(withImportedBindNames(parameters, unbound)))}
              >
                Import from statement
              </button>
              {/* Said beside the button, not only in its hover: a disabled
                  button gets no hover in every browser (`RowList`). */}
              <span className="page-hint" role="status">
                {unbound.length > 0
                  ? `Not bound: ${unbound.map((n) => `:${n}`).join(', ')}`
                  : used.length > 0
                    ? 'Every :name is bound'
                    : 'No :name in the statement'}
              </span>
            </>
          )
        }
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
            unused={used !== undefined && !used.includes(name)}
            onRename={(to) => rename(name, to, i)}
            onValue={(v, coalesce) =>
              write(
                withParameters({ ...parameters, [name]: v }),
                coalesce ? `param:${i}:value` : undefined,
              )
            }
            onRemove={() => {
              const next = { ...parameters };
              delete next[name];
              write(withParameters(next));
            }}
          />
        ))}
      </RowList>
      {/* Literal, like the statement: a run resolves `${}` in bind values only. */}
      <DraftNumberField
        label={timeoutField.label?.title ?? timeoutField.name}
        unit={timeoutField.label?.unit}
        stored={typeof storedTimeout === 'number' ? storedTimeout : undefined}
        parse={parseTimeoutSeconds}
        placeholder="none"
        about={
          about(
            timeoutField,
            `Literal here. A new Query starts at ${String(NEW_QUERY_TIMEOUT_SECONDS)} (2 hours).`,
          )?.note
        }
        onCommit={setTimeoutSeconds}
      />
    </>
  );
}

/**
 * One `:name`, its type and its value. The name box shows a local DRAFT: a name
 * that cannot be a key of the stored record (`bindNameProblem`) is held here
 * with its reason until it can be, and the stored row keeps its last good name.
 * The type and value are drafts too (`bindValueFor`): a Number whose text is not
 * a number yet is held with its reason, and the stored value waits.
 */
function ParameterRow({
  index,
  name,
  value,
  others,
  picker,
  unused,
  onRename,
  onValue,
  onRemove,
}: {
  index: number;
  name: string;
  value: unknown;
  others: readonly string[];
  picker: FieldPicker | undefined;
  /** The statement does not use this name, so its value is never bound. */
  unused: boolean;
  onRename: (to: string) => void;
  /** `coalesce` merges a keystroke into the typing before it; a type change is its own undo step. */
  onValue: (value: SqlParameterValue, coalesce: boolean) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const [synced, setSynced] = useState(name);
  // The value box shows a DRAFT as the override rows do (`OverrideRow`): a
  // stored number is `150` for the text `150.`, and rendering it back would
  // snap the box while the author is still typing.
  const [valueDraft, setValueDraft] = useState(() => bindValueText(value));
  const [typeDraft, setTypeDraft] = useState<BindType>(() => bindTypeOf(value));
  const [syncedValue, setSyncedValue] = useState(value);
  const resync = () => {
    setValueDraft(bindValueText(value));
    setTypeDraft(bindTypeOf(value));
  };
  const own = bindValueFor(typeDraft, valueDraft);
  const drafted = 'value' in own && own.value === value;
  // The drafts follow the store only when it moves on its own (undo, a flyout
  // insert, or a row removed above this one, as rows are kept by position).
  if (syncedValue !== value) {
    setSyncedValue(value);
    if (!drafted) resync();
  }
  if (synced !== name) {
    setSynced(name);
    // A name this row's own rename stored is the draft already.
    if (name !== draft) {
      setDraft(name);
      if (!drafted) resync();
    }
  }
  // A stored name is judged too: an imported `:wm` says why it never binds.
  const problem = bindNameProblem(draft, others);
  const valueProblem = 'problem' in own ? own.problem : null;
  const dynamic = typeDraft !== 'null' && isDynamicBindText(valueDraft);
  const note =
    problem ?? valueProblem ?? (unused ? 'Not in the statement, so it is not bound.' : null);
  const label = `Bind value ${index + 1}`;
  const target: PickerTarget = {
    place: (n, v) => {
      const source = n.inlineDatasets?.source;
      if (source === undefined) return n;
      const current = source.config['parameters'];
      const params =
        current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
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
          <select
            aria-label={`${label} type`}
            data-size={'s' satisfies FieldSize}
            value={dynamic ? 'expression' : typeDraft}
            disabled={dynamic}
            title={dynamic ? 'A ${} value keeps the type it resolves to' : undefined}
            onChange={(e) => {
              const t = e.target.value as BindType;
              setTypeDraft(t);
              const next = bindValueFor(t, valueDraft);
              if (t === 'null') setValueDraft('');
              if ('value' in next) onValue(next.value, false);
            }}
          >
            {dynamic && <option value="expression">Expression</option>}
            {(Object.keys(BIND_TYPE_LABELS) as BindType[]).map((t) => (
              <option key={t} value={t}>
                {BIND_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </td>
        <td>
          {typeDraft === 'null' ? (
            <input aria-label={`${label} value`} disabled value="" placeholder="null" />
          ) : (
            <PickableInput
              value={valueDraft}
              onChange={(t) => {
                setValueDraft(t);
                const next = bindValueFor(typeDraft, t);
                if ('value' in next) onValue(next.value, true);
              }}
              picker={picker}
              pickerName={`:${name}`}
              target={target}
            >
              <span className="visually-hidden">{`${label} value`}</span>
            </PickableInput>
          )}
        </td>
        <RowActions>
          <RemoveRowButton label={`Remove bind value ${index + 1}`} onRemove={onRemove} />
        </RowActions>
      </tr>
      {note !== null && (
        <RowNotes span={PARAM_COLUMNS.length + 1}>
          <p className="contract-advisory">{note}</p>
        </RowNotes>
      )}
    </>
  );
}
