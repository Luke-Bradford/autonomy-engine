import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import {
  DATASET_CONNECTION_KINDS,
  DATASET_KIND_DESCRIPTIONS,
  DATASET_KIND_LABELS,
  DATASET_KINDS,
  DatasetColumnSchema,
  datasetConfigAdvisory,
  datasetConfigSchema,
  datasetConnectionKindAdvisory,
  datasetKindIsImplemented,
  formatZodIssues,
  type ConnectionPublic,
  type Dataset,
  type DatasetColumn,
  type DatasetKind,
  type DatasetSheetsResult,
} from '@autonomy-studio/shared';
import { z } from 'zod';
import { messageOf } from '../api/client';
import { listConnections } from '../api/connections';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportDataset } from '../api/portability';
import {
  DatasetWriteSchema,
  createDataset,
  deleteDataset,
  listDatasetSheets,
  listDatasets,
  updateDataset,
  type DatasetWrite,
} from '../api/datasets';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { ImportPanel } from './ImportPanel';
import { StoreCell } from './datasets/StoreCell';
import { datasetDetailPath } from './datasets/datasetPath';
import {
  configDraftErrors,
  configKeyLabel,
  deriveFieldsWithCarried,
  payloadSignature,
  readConfigDraft,
  saveableConfigOf,
  seedFieldInputs,
  type ConfigField,
  type FieldInput,
} from './pipeline/configForm';
import { type FieldChoices } from './pipeline/ConfigFieldControl';
import { ConfigEditor } from './pipeline/ConfigEditor';
import { useConfigEditor } from './pipeline/useConfigEditor';
import { LabelledControl } from '../lib/LabelledControl';
import { connectionOptionLabel } from '../lib/resourceOptionLabel';
import { FormDrawer } from '../lib/form/FormDrawer';
import { Section } from '../lib/Section';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import { RequiredMark } from '../lib/form/RequiredMark';
import { FieldError } from '../lib/form/FieldError';
import { JsonEditor } from '../lib/form/JsonEditor';
import { describeJsonProblem } from '../lib/json/jsonText';
import { FormErrors } from '../lib/form/FormErrors';
import { nameCheck, useFieldValidation } from '../lib/form/fieldValidation';
import { saveRefusal, schemaRefusal } from '../lib/form/saveErrors';
import { useDrawerForm, type UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { OverridableKeysSection } from './OverridableKeysField';
import { allowlistChanged, datasetAllowlistSubject } from './overrideAllowlist';
import { DatasetKindName, KindSelect } from '../lib/KindName';
import { DATASET_KIND_ICONS } from '../lib/kindIcons';
import { useConfirm } from '../lib/confirm/useConfirm';
import { useFocusAfterRemoval } from '../hooks/useFocusAfterRemoval';
import { RowMoreMenu, type RowMenuOrigin } from '../lib/RowMoreMenu';
import { PageHeader } from '../lib/PageHeader';
import { OneLine } from '../lib/OneLine';

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
  inputs: Record<string, FieldInput>;
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
  /** #1305 — the `parameters` override allowlist being edited. */
  parameters: string[];
  /**
   * The allowlist as the form opened on it. Save sends `parameters` only when
   * the edit differs from this (`allowlistChanged`), because an explicit list
   * REPLACES the stored one — a rename must never touch it.
   */
  parametersSeed: readonly string[];
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

/**
 * A kind with NO READER forces the JSON editor, whatever the operator asked for —
 * a different reason from an unrenderable stored value (`configEditorView`).
 *
 * `unimplementedDatasetConfigSchema` is a `looseObject`, so `deriveConfigFields`
 * yields no controls for `excel` — and the empty-fields branch would then
 * print "This kind has no settings", which is FALSE: spec §2.6 lists `path`,
 * `sheet`, `headerRow`, `nullValue` and `dateFormat` for it. They are simply
 * not described yet. The JSON editor is the honest surface for a shape this
 * build cannot name, and the form's advisory says why it is showing.
 *
 * `delimited` stopped being such a kind on EITHER count, and the two facts
 * arrived one slice apart. #1163 gave it §2.6's eight keys, so
 * `deriveConfigFields` yields controls for it; #1167 then gave it a reader, so
 * a typed form no longer presents a dataset as ready to copy while every copy
 * naming it refuses at dispatch. That the two moved separately is exactly why
 * this branch keys on `datasetKindIsImplemented` and not on `fields.length`.
 *
 * **AS OF M11 SLICE 2 (#1215) NO KIND HOLDS THIS BRANCH OPEN.** `excel` was
 * the last one, and it now has both a schema and a reader — so `kindHasNoReader`
 * is false for every member of the enum and this JSON fallback is
 * unreachable through the picker.
 *
 * It is KEPT rather than deleted, and the reason is the paragraph above: the
 * two facts are independent and a new kind arrives without either. Deleting
 * this would mean the next kind's first day ships a typed form for a dataset
 * every copy refuses at dispatch — the precise trap the branch exists for —
 * and the code would have to be re-derived from a git log. What keeps "kept"
 * from meaning "rotting": `dataset-config.test.ts` pins
 * `IMPLEMENTED_DATASET_KINDS` as a LITERAL LIST, so adding a kind reds it, and
 * `DatasetsPage.test.tsx` drives these branches through a narrow mock of the
 * one predicate rather than deleting five real tests with their witness.
 */
function kindHasNoReader(kind: DatasetKind): boolean {
  return !datasetKindIsImplemented(kind);
}

/** #1396 — the summary's names for the form's own fields; the config's come from its schema. */
const OWN_FIELD_LABELS: ReadonlyMap<string, string> = new Map([
  ['name', 'Name'],
  ['connectionId', 'Store'],
  ['columns', 'Columns (JSON)'],
]);

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
  } catch {
    return {
      ok: false,
      message: `Invalid columns JSON: ${describeJsonProblem(text) ?? 'not valid JSON'}`,
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
  parameters: readonly string[],
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
    // Deduped: the server stores the list as written, so a stored `['a', 'a']`
    // is possible, and an edit should not write the duplicate back.
    parameters: [...new Set(parameters)],
    parametersSeed: parameters,
  };
}

/**
 * The kind a NEW dataset opens on: the first one that has a READER **and lives
 * in the store the form is about to open on**.
 *
 * The second clause is #1167's, and the widening is what made it necessary. Two
 * facts decide this and both have to be consulted:
 *
 *  - Not `KINDS[0]` alone. The enum's order is an ADDRESS-VOCABULARY order, not
 *    a usefulness order, so `KINDS[0]` is `delimited` for reasons that have
 *    nothing to do with what an operator wants first.
 *  - Not "the first kind with a reader" alone, which is what this was until M7
 *    slice 3. That rule was stable only while ONE store had a reader; the
 *    moment `delimited` joined `IMPLEMENTED_DATASET_KINDS` it began returning
 *    `delimited` for every new dataset — including one opening on a `sqlite`
 *    store, where the form would render "Kind and store disagree" on mount
 *    (#1145's advisory), before the operator had touched anything.
 *
 * So the default is derived from the STORE the form opens on. On an `fs`
 * connection it is `delimited`; on a `sqlite` one, `table`. With no connection
 * at all there is no store to agree with, and it falls back to the first kind
 * with a reader — the old rule, kept for exactly the case it is still right for.
 *
 * This is a DEFAULT and never a restriction: the picker still offers every kind,
 * and an operator who deliberately wants a mismatched pair gets the advisory
 * rather than a refusal, which is the polarity `datasetConnectionKindAdvisory`
 * insists on.
 */
function defaultKindFor(connection: ConnectionPublic | undefined): DatasetKind {
  const readable = KINDS.filter(datasetKindIsImplemented);
  const kind =
    connection === undefined
      ? undefined
      : readable.find((k) => DATASET_CONNECTION_KINDS[k].includes(connection.kind));
  // Falls back through "first readable" to `KINDS[0]`, so this stays TOTAL —
  // for a store no readable kind lives in (an `http` connection, say) and for
  // the degenerate case of an empty implemented set.
  return kind ?? readable[0] ?? KINDS[0]!;
}

function blankForm(connections: readonly ConnectionPublic[]): FormState {
  // The store is left UNSET when there are no connections rather than
  // defaulting to a store that does not exist; the form's own hint says what to
  // do about it.
  return formFor(null, '', connections[0]?.id ?? '', defaultKindFor(connections[0]), {}, '', []);
}

function formForEdit(dataset: Dataset): FormState {
  return formFor(
    dataset.id,
    dataset.name,
    dataset.connectionId,
    dataset.kind,
    dataset.config,
    JSON.stringify(dataset.columns, null, 2),
    dataset.parameters,
  );
}

/**
 * #1396 — what Save would write, as one comparable string, for the
 * unsaved-changes guard (`useDrawerForm`). The config is the one the editor is
 * showing, with a kind that has no reader counted as JSON-only, as the editor
 * counts it. The columns draft is compared as typed, because Save parses that
 * text. The allowlist is compared as a set, because Save sends it as one
 * (`allowlistChanged`).
 */
function savePayloadSignature(form: FormState): string {
  return payloadSignature([
    form.name,
    form.connectionId,
    form.kind,
    saveableConfigOf(form, datasetFields, kindHasNoReader),
    form.columnsText,
    [...form.parameters].sort(),
  ]);
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
  const [confirm, confirmDialog] = useConfirm();
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  // #1470 — a removed row hands focus to its neighbour's ⋯, else to this.
  const createRef = useRef<HTMLButtonElement>(null);
  const { restoreFocus: removalFocus, removing: removingRow } = useFocusAfterRemoval(
    datasets,
    createRef,
  );
  /* One removal per row at a time, spanning the dialog and the request: with
     the delete in flight the row's ⋯ still works, and a second Delete would
     ask again and 404 into the banner over a delete that succeeded (#1470).
     `ConnectionsPage.onDelete` states the race. */
  const { run: runRemove } = useBusyAction();
  const [connections, setConnections] = useState<readonly ConnectionPublic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    form,
    setForm,
    openForm,
    seq: formSeq,
    guard,
    openerRef,
    closeWhere,
    ...drawer
  } = useDrawerForm(savePayloadSignature);
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

  /**
   * #1143 — save the dataset's export file, exactly as Connections does (#959).
   * The file names its store by the connection's `resourceId`; a dataset whose
   * store is gone is refused by the server with a message naming it, which
   * lands in this page's error slot.
   */
  const { active: exporting, run: runExport } = useBusyAction();
  const onExport = useCallback(
    (dataset: Dataset) =>
      runExport(dataset.id, async () => {
        setLoadError(null);
        try {
          downloadTextFile(
            exportFileName('dataset', dataset.name, dataset.id),
            await exportDataset(dataset.id),
          );
        } catch (err) {
          setLoadError(`Could not export “${dataset.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  const onDelete = useCallback(
    (dataset: Dataset, origin: RowMenuOrigin) =>
      runRemove(dataset.id, async () => {
        // Names the consequence rather than only the row: nothing scans for
        // dependants at delete time (the ref is checked at DISPATCH, §3.1), so a
        // `copy` node bound to this dataset keeps its binding and fails when it
        // next runs.
        const confirmed = await confirm({
          message: `Delete dataset "${dataset.name}"?\n\nAny pipeline node bound to it will fail at dispatch.`,
          confirmLabel: 'Delete',
          restoreFocus: removalFocus(origin),
        });
        if (!confirmed) return;
        const forget = removingRow(dataset.id, origin);
        try {
          await deleteDataset(dataset.id);
          closeWhere((open) => open.id === dataset.id);
          await refresh();
        } catch (err) {
          forget();
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }),
    [removalFocus, removingRow, runRemove, confirm, refresh, closeWhere],
  );

  return (
    <section aria-labelledby="datasets-heading">
      <PageHeader title="Datasets" headingId="datasets-heading">
        <button
          ref={createRef}
          type="button"
          onClick={(e) => drawer.openFrom(e.currentTarget, () => openForm(blankForm(connections)))}
        >
          New dataset
        </button>
      </PageHeader>

      <p className="page-hint">
        A dataset is a thing in a store, in a shape: which connection it lives in, how it is
        addressed, and the columns it declares. A copy activity binds one at each end.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {/* #1396 — the list and the form side by side; the form is a column, not
          an overlay, so the row actions stay reachable while it is open. */}
      {guard.routeHold}
      <div className={form ? 'drawer-layout-open' : undefined}>
        <div>
          {datasets === null && !loadError && <p>Loading datasets…</p>}

          {datasets !== null && datasets.length === 0 && (
            <p>
              No datasets yet. Add one to give a copy activity something to read from or write to.
            </p>
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
                    <td>
                      <OneLine title={dataset.name}>
                        <Link to={datasetDetailPath(dataset.id)}>{dataset.name}</Link>
                      </OneLine>
                    </td>
                    <td>
                      <DatasetKindName kind={dataset.kind} />
                    </td>
                    <td>
                      <StoreCell
                        connections={connections}
                        connectionId={dataset.connectionId}
                        datasetKind={dataset.kind}
                      />
                    </td>
                    <td className="num">{dataset.columns.length}</td>
                    <td>
                      {/* #1397 — Edit is the row's one inline action; the rest
                          are in its menu, Delete last. */}
                      <div className="row-actions">
                        <button
                          type="button"
                          onClick={(e) =>
                            drawer.openFrom(e.currentTarget, () => openForm(formForEdit(dataset)))
                          }
                          aria-label={`Edit ${dataset.name}`}
                        >
                          Edit
                        </button>
                        <RowMoreMenu
                          name={dataset.name}
                          actions={[
                            {
                              label: 'Export',
                              onSelect: () => void onExport(dataset),
                              disabled: exporting.has(dataset.id),
                            },
                          ]}
                          destructive={{
                            label: 'Delete',
                            onSelect: (origin) => void onDelete(dataset, origin),
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {form && (
          <DatasetForm
            /* Keyed on the open counter, so a sheet listing taken for one draft
             never renders against the next (see `useDrawerForm`). */
            key={formSeq}
            form={form}
            connections={connections}
            onChange={setForm}
            guard={guard}
            returnFocusTo={openerRef}
            onClose={drawer.requestClose}
            onSaved={async () => {
              drawer.closeIfLatest(formSeq);
              await refresh();
            }}
          />
        )}
      </div>

      <ImportPanel listKind="dataset" stores={connections} onImported={refresh} />
      {confirmDialog}
    </section>
  );
}

function DatasetForm({
  form,
  connections,
  onChange,
  guard,
  returnFocusTo,
  onClose,
  onSaved,
}: {
  form: FormState;
  connections: readonly ConnectionPublic[];
  onChange: (next: FormState) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * #1218 — the last sheet listing, TAGGED with a signature of the draft it was
   * taken against, exactly as `ConnectionForm` tags a probe verdict.
   *
   * A listing is a reading from one moment. Point `path` at a different
   * workbook after a successful list and the old sheet names are no longer
   * about anything on screen — offering them would invite a choice that then
   * refuses at dispatch, which is the failure this whole ticket exists to
   * remove. Keeping the signature means a stale listing simply stops rendering
   * when the draft moves out from under it; no effect has to race to clear it.
   */
  const [sheets, setSheets] = useState<{
    result: DatasetSheetsResult;
    signature: string;
  } | null>(null);
  const [listing, setListing] = useState(false);
  const editing = form.id !== null;

  const editor = useConfigEditor({
    form,
    onChange,
    setError,
    fieldsFor: datasetFields,
    forcedJson: kindHasNoReader,
  });
  const { fields, jsonMode } = editor;

  /**
   * #1396 — what is wrong with the draft now, by field, in the form's order:
   * the write schema's `min(1)` on Name and Store (no trim, so the form never
   * refuses what the server accepts), the config's parse failures, and the
   * Columns text `parseColumnsText` refuses.
   */
  const checks = useMemo(() => {
    const columns = parseColumnsText(form.columnsText);
    return {
      ...nameCheck(form.name),
      ...(form.connectionId === '' ? { connectionId: 'Choose a store.' } : {}),
      ...configDraftErrors(jsonMode, { jsonText: form.jsonText, inputs: form.inputs }, fields),
      ...(columns.ok ? {} : { columns: columns.message }),
    };
    // What the checks read, not `form` whole.
  }, [
    form.name,
    form.connectionId,
    form.jsonText,
    form.inputs,
    form.columnsText,
    jsonMode,
    fields,
  ]);
  /** What to call a field key in the summary; `undefined` for a key this form does not show. */
  const labelOf = useCallback(
    (key: string) => OWN_FIELD_LABELS.get(key) ?? configKeyLabel(key, jsonMode, fields),
    [jsonMode, fields],
  );
  const validation = useFieldValidation(checks, labelOf);
  const nameErrorId = useId();
  const storeErrorId = useId();
  const columnsErrorId = useId();

  /**
   * Everything a sheet listing depends on: which store, and which file in it.
   * Not `form` whole — a rename would then discard a perfectly good listing.
   */
  const sheetSignature = useMemo(
    () => JSON.stringify([form.connectionId, form.inputs['path'] ?? '']),
    [form.connectionId, form.inputs],
  );

  /**
   * ON A BUTTON, deliberately, and not on every keystroke.
   *
   * Each call opens a real container behind a real descriptor. Firing one per
   * character typed into `path` would spend a server descriptor and a zip parse
   * on a hundred paths that were never meant to be paths — and the load guard
   * this codebase has (`useGuardedLoad`) is explicit that it DROPS RESULTS
   * RATHER THAN CANCELLING REQUESTS, so it would not stop the work, only hide
   * it. `ConnectionForm`'s Test connection button is the settled shape for
   * "an expensive reading, taken when the operator asks for it".
   */
  async function onListSheets() {
    setError(null);
    setSheets(null);
    const path = form.inputs['path'];
    if (typeof path !== 'string' || path === '') {
      setError('Enter the workbook path first, then list its sheets.');
      return;
    }
    setListing(true);
    try {
      const result = await listDatasetSheets({ connectionId: form.connectionId, path });
      setSheets({ result, signature: sheetSignature });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setListing(false);
    }
  }

  const freshSheets =
    sheets !== null && sheets.signature === sheetSignature && sheets.result.ok
      ? sheets.result.sheets
      : null;

  /**
   * Which fields this panel can offer values for. Today exactly one, and the
   * mapping lives HERE rather than in `ConfigFieldControl`, which argues at
   * length against growing a field-name table of its own.
   *
   * The empty-name filter is not defensive tidiness: `DatasetSheetsResultSchema`
   * admits an empty sheet name on purpose (a malformed container should not make
   * a whole workbook uninspectable), but `sheet` is `z.string().min(1)` — so an
   * offered blank would be a choice the save then refuses. The reader tells the
   * truth and the form declines to offer what cannot be chosen.
   */
  const choicesFor = (fieldName: string): FieldChoices | undefined => {
    if (fieldName !== 'sheet' || freshSheets === null) return undefined;
    return {
      label: 'Sheet in this workbook',
      values: freshSheets.filter((name) => name !== ''),
      onChoose: (value) =>
        onChange({
          ...form,
          // Blanking `sheetIndex` is REQUIRED, not tidiness:
          // `excelDatasetConfigSchema` refuses a config naming both, so leaving
          // a previously-typed index behind would make the control that offered
          // this name the cause of the refusal on Save.
          inputs: { ...form.inputs, sheet: value, sheetIndex: '' },
        }),
    };
  };

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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Read back whichever draft is on screen — never the other one, which is
    // why each mode toggle commits to `config` before switching. An ordinary
    // kind change does not (`changeConfigKind`): it rewrites neither draft, so an
    // operator's JSON is never edited under them. The advisory covers that seam.
    // #1396 — every field that will not read back is shown beside itself first.
    if (!validation.attempt()) return;
    // Past the checks these reads cannot fail; they stay for the parsed values
    // and, should a check and its reader ever drift apart, a refusal anyway.
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
      ...(allowlistChanged(form.parametersSeed, form.parameters)
        ? { parameters: form.parameters }
        : {}),
    };

    const parsed = DatasetWriteSchema.safeParse(body);
    if (!parsed.success) {
      setError(schemaRefusal(parsed.error.issues, validation));
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
      setError(saveRefusal(err, validation));
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

  /**
   * #1145 — whether this dataset's kind agrees with the KIND of store it names.
   *
   * A different question from `boundIsUnresolved` above, which is about whether
   * the store exists at all: `routes/datasets.ts` checks existence and
   * ownership and nothing else, so a `table` dataset on an `anthropic_api`
   * connection is stored happily and is only refused when a copy is dispatched.
   *
   * ADVISORY, like every other note on this form — it never disables Save,
   * because the server accepts this row and the form must not refuse what the
   * server accepts. `null` when no connection resolves, which is exactly the
   * two states the notes above already own.
   */
  const storeKindAdvisory = useMemo(
    () =>
      datasetConnectionKindAdvisory(
        form.kind,
        connections.find((conn) => conn.id === form.connectionId)?.kind ?? null,
      ),
    // The three inputs, not `form` whole — the same rule the config advisory
    // above states and for the same reason: `form` is a new object on every
    // keystroke, so depending on it would re-resolve the store while the
    // operator types a NAME.
    [form.kind, form.connectionId, connections],
  );

  return (
    <FormDrawer
      title={editing ? 'Edit dataset' : 'New dataset'}
      formLabel="Dataset form"
      className="dataset-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving || listing}
      returnFocusTo={returnFocusTo}
      validation={validation}
      /* In the footer, beside Save, so a refused Save is in view where it was
         pressed. Errors only: the sheet listing's `role="status"` answers stay
         in the body beside the button that asked. */
      status={<FormErrors validation={validation} message={error} />}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving || listing}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || listing}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create dataset'}
          </button>
        </>
      }
    >
      <Section heading="Basics" help={FORM_SECTION_HINTS.dataset.basics}>
        <LabelledControl
          label={
            <>
              Name
              <RequiredMark />
            </>
          }
        >
          {(id) => (
            <input
              id={id}
              type="text"
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              required
              {...validation.attrsFor('name', nameErrorId)}
            />
          )}
        </LabelledControl>
        <FieldError id={nameErrorId} message={validation.errorFor('name')} />

        <LabelledControl
          label={
            <>
              Store
              <RequiredMark />
            </>
          }
        >
          {(id) => (
            <select
              id={id}
              value={form.connectionId}
              onChange={(e) => onChange({ ...form, connectionId: e.target.value })}
              required
              {...validation.attrsFor('connectionId', storeErrorId)}
            >
              {connections.length === 0 && <option value="">— no connections —</option>}
              {boundIsUnresolved && (
                <option value={form.connectionId}>{form.connectionId} (missing)</option>
              )}
              {connections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {connectionOptionLabel(conn)}
                </option>
              ))}
            </select>
          )}
        </LabelledControl>
        <FieldError id={storeErrorId} message={validation.errorFor('connectionId')} />
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

        <LabelledControl
          label={
            <>
              Kind
              <RequiredMark />
            </>
          }
          hint={DATASET_KIND_DESCRIPTIONS[form.kind]}
        >
          {(id, hintId) => (
            <KindSelect icons={DATASET_KIND_ICONS} kind={form.kind}>
              <select
                id={id}
                aria-describedby={hintId}
                value={form.kind}
                aria-required
                onChange={(e) => editor.onKindChange(e.target.value as DatasetKind)}
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {DATASET_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </KindSelect>
          )}
        </LabelledControl>
        {storeKindAdvisory !== null && (
          <p className="contract-advisory">{`Kind and store disagree: ${storeKindAdvisory}`}</p>
        )}
      </Section>

      <Section heading="Dataset" help={FORM_SECTION_HINTS.dataset.dataset}>
        {/* The mode toggle is hidden, not disabled, for a kind with no reader
            (`kindHasNoReader`): a typed form for a kind every copy refuses at
            dispatch would present a dataset as ready to copy, and a control that
            can only refuse is furniture. */}
        <ConfigEditor
          editor={editor}
          kindLabel={DATASET_KIND_LABELS[editor.kind]}
          className="dataset-config"
          rows={6}
          advisory={advisory}
          choicesFor={choicesFor}
          errorFor={validation.errorFor}
          fieldModeExtra={
            /* #1218 — only `excel` names a sheet, and only the field form can
              offer one (the JSON editor has no control to attach it to). */
            form.kind === 'excel' && (
              <>
                <button type="button" onClick={() => void onListSheets()} disabled={listing}>
                  {listing ? 'Listing sheets…' : 'List sheets'}
                </button>
                {/* `role="status"`, matching the probe verdict: a refusal here is
                  the server's ANSWER to a question that was asked — the file is
                  not there yet, the path is outside the roots — not a failure of
                  the form, so it does not take the page's `alert` slot. */}
                {sheets !== null && sheets.signature === sheetSignature && !sheets.result.ok && (
                  <p role="status" className="probe-failed">
                    {sheets.result.error}
                  </p>
                )}
                {freshSheets !== null && freshSheets.filter((n) => n !== '').length === 0 && (
                  <p role="status" className="page-hint">
                    This workbook reports no named sheets — choose the sheet by position with Sheet
                    number instead.
                  </p>
                )}
              </>
            )
          }
        >
          {/* `query`'s config has its OWN `parameters` key — SQL bind values —
              which is a different thing from `Dataset.parameters`, the per-dispatch
              override allowlist. Said here because the two would otherwise sit on
              one form under one word. */}
          {form.kind === 'query' && (
            <p className="page-hint">
              Whether a step may override the Bind values per run is the “Overridable per node”
              setting under Advanced.
            </p>
          )}
        </ConfigEditor>
      </Section>

      <Section heading="Columns" help={FORM_SECTION_HINTS.dataset.columns}>
        <LabelledControl
          label={
            <>
              Columns (JSON)
              <RequiredMark />
            </>
          }
          about={{
            name: 'Columns (JSON)',
            note: (
              <>
                An authoring aid that auto-map matches against, never a run input: a copy is gated
                against the store’s actual columns, not this list. Write <code>[]</code> to state
                that there are none.
              </>
            ),
          }}
        >
          {(id, describedBy) => (
            <JsonEditor
              id={id}
              label="Columns (JSON)"
              value={form.columnsText}
              onValueChange={(columnsText) => onChange({ ...form, columnsText })}
              rows={6}
              aria-required
              placeholder='[{ "name": "id", "type": "integer", "nullable": false }]'
              {...validation.attrsFor('columns', columnsErrorId, describedBy)}
            />
          )}
        </LabelledControl>
        <FieldError id={columnsErrorId} message={validation.errorFor('columns')} />
      </Section>

      <OverridableKeysSection
        subject={datasetAllowlistSubject(form.kind)}
        seed={form.parametersSeed}
        value={form.parameters}
        onChange={(parameters) => onChange({ ...form, parameters })}
      />
    </FormDrawer>
  );
}
