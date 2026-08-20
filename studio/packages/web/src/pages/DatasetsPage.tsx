import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DATASET_KINDS,
  DatasetColumnSchema,
  datasetConfigAdvisory,
  datasetConfigSchema,
  datasetKindIsImplemented,
  formatZodIssues,
  type ConnectionPublic,
  type Dataset,
  type DatasetColumn,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { z } from 'zod';
import { ApiError } from '../api/client';
import { listConnections } from '../api/connections';
import {
  DatasetWriteSchema,
  createDataset,
  deleteDataset,
  listDatasets,
  updateDataset,
  type DatasetWrite,
} from '../api/datasets';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import {
  assembleConfig,
  deriveFieldsWithCarried,
  parseConfigText,
  readConfigDraft,
  seedFieldInputs,
  unrepresentableFields,
  type ConfigField,
} from './pipeline/configForm';
import { ConfigFieldControl } from './pipeline/ConfigFieldControl';

const KINDS = DATASET_KINDS;

/** Every column list the form authors is judged by the schema's own rule. */
const ColumnsSchema = z.array(DatasetColumnSchema);

type FormState = {
  id: string | null; // null = creating, otherwise editing this dataset
  name: string;
  connectionId: string;
  kind: DatasetKind;
  /**
   * The AUTHORITATIVE config. The two drafts below are what the operator types
   * into; each mode change reads its draft back into here, so there is always
   * exactly one answer to "what would Save write".
   */
  config: Record<string, unknown>;
  /** One control value per derived field — the field-mode draft. */
  inputs: Record<string, string | boolean>;
  /** The whole-config JSON draft. */
  jsonText: string;
  /** Whether the operator ASKED for JSON. An unrenderable value forces it too. */
  jsonMode: boolean;
  /**
   * The declared-columns draft, as JSON text.
   *
   * A textarea and not a grid, deliberately: an array-of-object has no typed
   * control anywhere in studio (`configForm.ts` — `classify` sends one to the
   * JSON editor), and the data-movement spec §13 settles that the general
   * `objectList` primitive is M8's to build, "as a primitive rather than a
   * copy-specific panel", because `switch.cases` and `llm_call.tools` are
   * waiting on the same control. M5 took this identical decision for the copy
   * node's mapping grid. Building a bespoke column grid here would be the
   * throwaway parallel field list U7 refuses.
   *
   * EMPTY TEXT IS NOT `[]`. `DatasetSchema.columns` is required with no
   * `.default([])` precisely so an absent column list fails loudly rather than
   * being manufactured as an empty schema (#473's lesson; §2.2 states it in as
   * many words) — an empty declared schema reads as "this table has no
   * columns", and auto-map would then silently produce an empty mapping. So a
   * blank textarea is REFUSED with a message, and an operator who genuinely
   * means "no columns" types `[]` to say so. On edit this is seeded from the
   * stored value, so a rename can never wipe a declaration.
   */
  columnsText: string;
};

/** The controls for this kind's config, plus any key carried from another kind.
 * The rule lives in `configForm.ts`; only the kind list and schema lookup are
 * local (`ConnectionsPage` does the same). */
function datasetFields(
  kind: DatasetKind,
  config: Record<string, unknown>,
): { fields: ConfigField[]; carried: string[] } {
  return deriveFieldsWithCarried(KINDS, datasetConfigSchema, kind, config);
}

/** Read the columns draft back out, refusing an absent one. */
function parseColumnsText(
  text: string,
): { ok: true; columns: DatasetColumn[] } | { ok: false; message: string } {
  if (text.trim() === '') {
    return {
      ok: false,
      message:
        'Columns is required: declare the dataset’s columns, or write [] to state that it has none. ' +
        'An empty list is a claim about the store, never a stand-in for “not described yet”.',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `Invalid columns JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = ColumnsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: formatZodIssues(parsed.error.issues) };
  return { ok: true, columns: parsed.data };
}

function formFor(
  id: string | null,
  name: string,
  connectionId: string,
  kind: DatasetKind,
  config: Record<string, unknown>,
  columnsText: string,
): FormState {
  const { fields } = datasetFields(kind, config);
  return {
    id,
    name,
    connectionId,
    kind,
    config,
    inputs: seedFieldInputs(fields, config),
    jsonText: JSON.stringify(config, null, 2),
    jsonMode: false,
    columnsText,
  };
}

/**
 * The kind a NEW dataset opens on: the first one that has a READER.
 *
 * Not `KINDS[0]`, which is `delimited` — a kind whose reader arrives at M7, so
 * every new dataset would start on a kind that cannot run and whose config this
 * build cannot even describe. The enum's order is an address-vocabulary order,
 * not a usefulness order, and defaulting to it would hand the operator a broken
 * dataset unless they knew to change the picker. Falls back to `KINDS[0]` so
 * this stays total if the implemented set is ever empty.
 */
const DEFAULT_KIND: DatasetKind = KINDS.find(datasetKindIsImplemented) ?? KINDS[0]!;

function blankForm(connections: readonly ConnectionPublic[]): FormState {
  // The store is left UNSET when there are no connections rather than
  // defaulting to a store that does not exist; the form's own hint says what to
  // do about it.
  return formFor(null, '', connections[0]?.id ?? '', DEFAULT_KIND, {}, '');
}

function formForEdit(dataset: Dataset): FormState {
  return formFor(
    dataset.id,
    dataset.name,
    dataset.connectionId,
    dataset.kind,
    dataset.config,
    JSON.stringify(dataset.columns, null, 2),
  );
}

/**
 * Manage → Datasets (#1115; data-movement spec §13, *"a Datasets list + detail
 * beside Connections. No new hub, no parallel authoring idiom"*).
 *
 * A dataset is an ADDRESS in a store, and until this page there was no way to
 * author one at all: M2 landed the resource, M4 its readers and M5 the `copy`
 * activity whose four pickers bind them — but every one of those pickers could
 * only offer rows created through the REST API. This is the surface that makes
 * the data-movement path reachable.
 *
 * The DETAIL half of §13 (referencing pipelines, flagged where mappings no
 * longer agree) is M9 and is deliberately not here.
 */
export function DatasetsPage() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [connections, setConnections] = useState<readonly ConnectionPublic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const guardedLoad = useGuardedLoad();

  // ONE guarded load writing BOTH state targets from a single response, which is
  // the shape `useGuardedLoad` blesses: two independent loads could interleave
  // so the store picker renders against a connection list from a different
  // moment than the dataset list it is resolving ids for. The mount effect and
  // every post-mutation refetch go through it, which is what ORDERS them.
  const refresh = useCallback(
    () =>
      guardedLoad(
        async (signal) => ({
          datasets: await listDatasets(signal),
          connections: await listConnections(signal),
        }),
        {
          onData: ({ datasets: rows, connections: conns }) => {
            setDatasets(rows);
            setConnections(conns);
            setLoadError(null);
          },
          onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
        },
      ),
    [guardedLoad],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (dataset: Dataset) => {
      // Names the consequence rather than only the row: nothing scans for
      // dependants at delete time (the ref is checked at DISPATCH, §3.1), so a
      // `copy` node bound to this dataset keeps its binding and fails when it
      // next runs.
      if (
        !window.confirm(
          `Delete dataset "${dataset.name}"? Any pipeline node bound to it will fail at dispatch.`,
        )
      ) {
        return;
      }
      try {
        await deleteDataset(dataset.id);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return (
    <section aria-labelledby="datasets-heading">
      <div className="page-header">
        <h2 id="datasets-heading">Datasets</h2>
        <button type="button" onClick={() => setForm(blankForm(connections))}>
          New dataset
        </button>
      </div>

      <p className="page-hint">
        A dataset is a thing in a store, in a shape: which connection it lives in, how it is
        addressed, and the columns it declares. A copy activity binds one at each end.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {datasets === null && !loadError && <p>Loading datasets…</p>}

      {datasets !== null && datasets.length === 0 && (
        <p>No datasets yet. Add one to give a copy activity something to read from or write to.</p>
      )}

      {datasets !== null && datasets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Store</th>
              <th scope="col">Columns</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((dataset) => (
              <tr key={dataset.id}>
                <td>{dataset.name}</td>
                <td>
                  <code>{dataset.kind}</code>
                </td>
                <td>
                  <StoreName connections={connections} connectionId={dataset.connectionId} />
                </td>
                <td>{dataset.columns.length}</td>
                <td>
                  <button type="button" onClick={() => setForm(formForEdit(dataset))}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(dataset)}
                    aria-label={`Delete ${dataset.name}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {form && (
        <DatasetForm
          form={form}
          connections={connections}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await refresh();
          }}
        />
      )}

      {/* No import panel. `POST /api/import` refuses a `kind: 'dataset'`
          envelope outright — a dataset names a connection that only resolves
          against a whole workspace — so datasets round-trip through Manage →
          Git instead. Wiring a single-file path (and the `ImportPanel` link
          that would then point here) is tracked separately. */}
    </section>
  );
}

/**
 * The store a dataset names, by NAME where that resolves and by raw id where it
 * does not.
 *
 * A dangling `connectionId` is reachable: `routes/datasets.ts` checks the
 * binding at WRITE time and says so explicitly — *"the connection can still be
 * deleted afterwards"* — and `routes/connections.ts`'s delete re-gates triggers
 * only, nothing scans datasets. Rendering an unresolved id as blank would leave
 * the one page whose job is to make the binding legible saying nothing about
 * the one binding that is broken.
 */
function StoreName({
  connections,
  connectionId,
}: {
  connections: readonly ConnectionPublic[];
  connectionId: string;
}) {
  const hit = connections.find((conn) => conn.id === connectionId);
  if (hit) return <>{hit.name}</>;
  return (
    <span className="contract-advisory">
      <code>{connectionId}</code> (missing)
    </span>
  );
}

function DatasetForm({
  form,
  connections,
  onChange,
  onClose,
  onSaved,
}: {
  form: FormState;
  connections: readonly ConnectionPublic[];
  onChange: (next: FormState) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = form.id !== null;

  const { fields, carried } = useMemo(
    () => datasetFields(form.kind, form.config),
    [form.kind, form.config],
  );
  // A STORED value its control cannot represent forces the JSON editor: showing
  // a form that cannot round-trip what is already saved would corrupt the
  // dataset on a save the operator believes touched one other key.
  const unrenderable = useMemo(
    () => unrepresentableFields(fields, form.config),
    [fields, form.config],
  );
  /**
   * A kind with NO READER forces it too, and that is not the same reason.
   *
   * `unimplementedDatasetConfigSchema` is a `looseObject`, so `deriveConfigFields`
   * yields no controls for `delimited`/`excel` — and the empty-fields branch
   * would then print "This kind has no settings", which is FALSE: spec §2.6
   * lists `path`, `delimiter`, `quote`, `header`, `encoding`, `nullValue` and
   * `dateFormat` for `delimited`. They are simply not described yet. The JSON
   * editor is the honest surface for a shape this build cannot name, and the
   * advisory below says why it is showing.
   */
  const kindHasReader = datasetKindIsImplemented(form.kind);
  /*
   * The config editor below (the mode toggle, the two advisories, the
   * fields-vs-textarea branch) is the THIRD copy of a pattern `ConnectionForm`
   * and `NodePanel` already carry — #1088's subject, now widened rather than
   * paid down, which is recorded honestly in #1146 rather than left for the
   * next reader to notice. The correctness-critical half is NOT duplicated:
   * `parseConfigText`, `deriveFieldsWithCarried` and `readConfigDraft` all live
   * in `configForm.ts` and are shared. What is copied is presentation plus
   * three thin handlers, one of which (`onKindChange`) has genuinely diverged.
   */
  const jsonMode = form.jsonMode || unrenderable.length > 0 || !kindHasReader;

  /**
   * What this kind's own schema says about the draft — ADVISORY only.
   *
   * Never a gate: `routes/datasets.ts` runs no per-kind validation, so a config
   * the reader would refuse is storable TODAY, and so is one already in the
   * database. Refusing it here would make an existing row unsaveable after an
   * unrelated rename, and the form must never refuse what the server accepts
   * (#1120).
   */
  const advisory = useMemo(() => {
    // Both drafts, because the Kind select is reachable in EITHER mode: switch
    // kind with the textarea showing and the JSON genuinely does not change, so
    // a config shaped for the OLD kind would otherwise be saved with nothing on
    // screen to say so.
    const draft = readConfigDraft(jsonMode, form, fields);
    if (!draft.ok) return null; // submit reports the parse / per-field message
    return datasetConfigAdvisory(form.kind, draft.owned);
    // The three draft fields, not `form` whole: `form` is a new object on every
    // keystroke, so depending on it would re-parse and re-validate the config
    // while the operator types a NAME. Listing exactly what `readConfigDraft`
    // reads keeps that honest — a fourth field added to it must be added here.
  }, [jsonMode, form.config, form.jsonText, form.inputs, form.kind, fields]);

  /** Switch kinds WITHOUT discarding anything typed or stored. */
  function onKindChange(kind: DatasetKind) {
    setError(null); // a parse/save error from the previous kind is not this one's
    const next = datasetFields(kind, form.config);
    // Seed the new kind's controls from the stored config, then let anything
    // already typed win. A plain re-seed would drop every in-progress edit; no
    // re-seed at all would leave a key the new kind owns showing an empty
    // control, which `assembleConfig` reads as a clearing gesture and DELETES.
    const inputs = { ...seedFieldInputs(next.fields, form.config), ...form.inputs };

    // A kind with NO READER forces `jsonMode` on (see its declaration), and that
    // is the one mode change that does not run through `toJsonMode` — so the
    // textarea would open on a `jsonText` last written before anything was typed
    // into the field controls, showing the operator a config that is not the one
    // they built, and SAVING it. Every other route into JSON mode commits the
    // field draft first; this one has to as well.
    //
    // Deliberately narrow: a kind change still rewrites neither draft in the
    // ordinary case, so an operator's JSON is never edited under them. This
    // fires only when the switch itself takes the field form away.
    if (!jsonMode && !datasetKindIsImplemented(kind)) {
      const assembled = assembleConfig(form.config, fields, form.inputs);
      if (assembled.ok) {
        onChange({
          ...form,
          kind,
          inputs,
          config: assembled.config,
          jsonText: JSON.stringify(assembled.config, null, 2),
        });
        return;
      }
      // A control that will not read back (non-numeric text in a number box)
      // has no committed form to carry over. The kind still changes — the
      // operator is not trapped — but the message names the field rather than
      // letting the JSON editor open on a draft that silently omits it.
      setError(assembled.message);
    }

    onChange({ ...form, kind, inputs });
  }

  /** Fields → JSON: assemble first, so the textarea opens on what Save would write. */
  function toJsonMode() {
    const assembled = assembleConfig(form.config, fields, form.inputs);
    if (!assembled.ok) {
      setError(assembled.message);
      return;
    }
    setError(null);
    onChange({
      ...form,
      config: assembled.config,
      jsonText: JSON.stringify(assembled.config, null, 2),
      jsonMode: true,
    });
  }

  /** JSON → fields: parse first, and refuse if the result has no form to show. */
  function toFieldMode() {
    const parsed = parseConfigText(form.jsonText);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const next = datasetFields(form.kind, parsed.config);
    const bad = unrepresentableFields(next.fields, parsed.config);
    if (bad.length > 0) {
      setError(`These settings have no form control: ${bad.join(', ')}.`);
      return;
    }
    setError(null);
    onChange({
      ...form,
      config: parsed.config,
      inputs: seedFieldInputs(next.fields, parsed.config),
      jsonMode: false,
    });
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Read back whichever draft is on screen — never the other one, which is
    // why each MODE toggle above commits to `config` before switching. A kind
    // change deliberately does not: it rewrites neither draft, so an operator's
    // JSON is never edited under them. The advisory is what covers that seam.
    const draft = readConfigDraft(jsonMode, form, fields);
    if (!draft.ok) {
      setError(draft.message);
      return;
    }

    const columns = parseColumnsText(form.columnsText);
    if (!columns.ok) {
      setError(columns.message);
      return;
    }

    const body: DatasetWrite = {
      name: form.name,
      connectionId: form.connectionId,
      kind: form.kind,
      config: draft.config,
      columns: columns.columns,
    };

    const parsed = DatasetWriteSchema.safeParse(body);
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    setSaving(true);
    try {
      if (editing && form.id) {
        await updateDataset(form.id, parsed.data);
      } else {
        await createDataset(parsed.data);
      }
      await onSaved();
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      setError(msg);
      setSaving(false);
    }
  }

  // The bound store may be a row this list does not hold — deleted, or belonging
  // to nobody the caller can see. Offering only the resolvable ones would make
  // the select fall back to the first connection, which reads as "this is what
  // it is bound to" while the row says otherwise, and the next Save would write
  // that lie. `bindingPickers.ts` states the same rule for the canvas pickers;
  // this is the case those cannot reach, because the id is absent from the list
  // entirely rather than merely off-kind.
  const boundIsUnresolved =
    form.connectionId !== '' && !connections.some((conn) => conn.id === form.connectionId);

  return (
    <form className="dataset-form" onSubmit={(e) => void onSubmit(e)} aria-label="Dataset form">
      <h3>{editing ? 'Edit dataset' : 'New dataset'}</h3>

      <label>
        Name
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          required
        />
      </label>

      <label>
        Store
        <select
          value={form.connectionId}
          onChange={(e) => onChange({ ...form, connectionId: e.target.value })}
          required
        >
          {connections.length === 0 && <option value="">— no connections —</option>}
          {boundIsUnresolved && (
            <option value={form.connectionId}>{form.connectionId} (missing)</option>
          )}
          {connections.map((conn) => (
            <option key={conn.id} value={conn.id}>
              {conn.name} ({conn.kind})
            </option>
          ))}
        </select>
      </label>
      {connections.length === 0 && (
        <p className="page-hint">
          A dataset lives in a store, so it needs a connection first — add one under Manage →
          Connections.
        </p>
      )}
      {boundIsUnresolved && (
        <p className="contract-advisory">
          This dataset names a connection that no longer exists. A copy using it will fail at
          dispatch until it is re-pointed.
        </p>
      )}

      <label>
        Kind
        <select value={form.kind} onChange={(e) => onKindChange(e.target.value as DatasetKind)}>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>

      <div className="dataset-config" role="group" aria-label="Config">
        <div className="config-header">
          <span>Config</span>
          {/* Hidden, not disabled, when the kind has no reader: there is no field
              form to switch TO, so a control that can only refuse is furniture. */}
          {kindHasReader && (
            <button type="button" onClick={jsonMode ? toFieldMode : toJsonMode}>
              {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
            </button>
          )}
        </div>

        {unrenderable.length > 0 && (
          <p className="contract-advisory">
            {`Saved settings this form cannot show (${unrenderable.join(', ')}) — editing as JSON.`}
          </p>
        )}

        {jsonMode ? (
          <label>
            Config (JSON)
            <textarea
              value={form.jsonText}
              onChange={(e) => onChange({ ...form, jsonText: e.target.value })}
              rows={6}
              spellCheck={false}
            />
          </label>
        ) : (
          <>
            {fields.length === 0 && <p className="page-hint">This kind has no settings.</p>}
            {fields.map((field) => (
              <ConfigFieldControl
                key={field.name}
                field={field}
                value={form.inputs[field.name] ?? (field.kind === 'boolean' ? false : '')}
                onChange={(next) =>
                  onChange({ ...form, inputs: { ...form.inputs, [field.name]: next } })
                }
              />
            ))}
            {carried.length > 0 && (
              <p className="contract-advisory">
                {`Carried from another kind (${carried.join(', ')}) — ${form.kind} ignores these; blank a control to drop the key.`}
              </p>
            )}
          </>
        )}

        {/* Outside the mode branch on purpose: the Kind select is reachable in
            BOTH modes, and the JSON draft is exactly where a kind change can
            leave a config shaped for the previous one. */}
        {advisory !== null && (
          <p className="contract-advisory">{`This ${form.kind} config is incomplete: ${advisory}`}</p>
        )}

        {/* `query`'s config has its OWN `parameters` key — SQL bind values —
            which is a different thing from `Dataset.parameters`, the per-dispatch
            override allowlist. Said here because the two would otherwise sit on
            one form under one word. */}
        {form.kind === 'query' && (
          <p className="page-hint">
            These <code>parameters</code> are SQL bind values for the statement, not the dataset’s
            per-dispatch override allowlist.
          </p>
        )}
      </div>

      <label>
        Columns (JSON)
        <textarea
          value={form.columnsText}
          onChange={(e) => onChange({ ...form, columnsText: e.target.value })}
          rows={6}
          spellCheck={false}
          placeholder='[{ "name": "id", "type": "integer", "nullable": false }]'
        />
      </label>
      <p className="page-hint">
        The schema this dataset DECLARES — an authoring aid that auto-map matches against, never a
        run input. A copy is gated against the store’s actual columns, not this list. Required:
        write <code>[]</code> to state that there are none.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create dataset'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
