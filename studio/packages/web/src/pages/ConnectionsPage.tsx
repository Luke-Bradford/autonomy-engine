import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONNECTION_KINDS,
  CONNECTION_SECRET_USE,
  connectionConfigAdvisory,
  connectionConfigSchema,
  connectionKindRequiresSecret,
  formatZodIssues,
  type ConnectionKind,
  type ConnectionProbeResult,
  type ConnectionPublic,
  type Dataset,
} from '@autonomy-studio/shared';
import { ApiError, messageOf } from '../api/client';
import {
  ConnectionWriteSchema,
  createConnection,
  deleteConnection,
  listConnections,
  testDraftConnection,
  testSavedConnection,
  updateConnection,
  type ConnectionWrite,
} from '../api/connections';
import { listDatasets } from '../api/datasets';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportConnection } from '../api/portability';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import {
  datasetsOnConnection,
  deleteConfirmMessage,
  kindChangeAdvisory,
  strandedByKindChange,
  type StrandCheck,
} from './connections/strandedDatasets';
import { ImportPanel } from './ImportPanel';
import {
  assembleConfig,
  deriveFieldsWithCarried,
  emptyControlValue,
  parseConfigText,
  readConfigDraft,
  seedFieldInputs,
  unrepresentableFields,
  type ConfigField,
  type FieldInput,
} from './pipeline/configForm';
import { ConfigFieldControl } from './pipeline/ConfigFieldControl';

const KINDS = CONNECTION_KINDS;

type FormState = {
  id: string | null; // null = creating, otherwise editing this connection
  name: string;
  kind: ConnectionKind;
  /**
   * The AUTHORITATIVE config. The two drafts below are what the operator is
   * typing into; each mode change reads its draft back into here, so there is
   * always exactly one answer to "what would Save write".
   */
  config: Record<string, unknown>;
  /** One control value per derived field — the field-mode draft. */
  inputs: Record<string, FieldInput>;
  /** The whole-config JSON draft. */
  jsonText: string;
  /** Whether the operator ASKED for JSON. An unrenderable value forces it too. */
  jsonMode: boolean;
  secret: string;
};

/**
 * The controls for this kind's config, plus any key CARRIED over from another
 * kind. The rule itself lives in `configForm.ts` — datasets need the identical
 * one (#1115), and a second copy is how the halves drift apart. What is local
 * here is only which kind list and which schema lookup to ask it about.
 */
function connectionFields(
  kind: ConnectionKind,
  config: Record<string, unknown>,
): { fields: ConfigField[]; carried: string[] } {
  return deriveFieldsWithCarried(KINDS, connectionConfigSchema, kind, config);
}

function formFor(
  id: string | null,
  name: string,
  kind: ConnectionKind,
  config: Record<string, unknown>,
): FormState {
  const { fields } = connectionFields(kind, config);
  return {
    id,
    name,
    kind,
    config,
    inputs: seedFieldInputs(fields, config),
    jsonText: JSON.stringify(config, null, 2),
    jsonMode: false,
    secret: '', // never prefilled — secrets are write-only, blank = keep existing
  };
}

function blankForm(): FormState {
  // KINDS is the connection-kind enum's option list — statically non-empty.
  return formFor(null, '', KINDS[0]!, {});
}

function formForEdit(conn: ConnectionPublic): FormState {
  return formFor(conn.id, conn.name, conn.kind, conn.config);
}

/**
 * Connections page: the first MVP-bar step ("Add a Connection"). Full CRUD
 * over `/api/connections`. Secrets are write-only end to end — the list never
 * carries one, and the edit form leaves the secret field blank (blank = keep
 * the existing secret; typing a value rotates it).
 */
export function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  /**
   * How many times a form has been OPENED, and the `key` the form is mounted on.
   *
   * Keying on `form.id` was not enough. The "New connection" button is not gated
   * behind the form being closed, so pressing it with a new-connection form
   * already open leaves `form.id` at `null` — no remount — while `blankForm()`
   * hands back byte-identical content, so the recomputed draft signature matches
   * the stale one and the PREVIOUS draft's verdict renders against a form that
   * was never tested. A counter cannot collide with itself, so every way of
   * opening a form (New twice, Edit another row, Edit the same row again) starts
   * the child clean.
   */
  const [formSeq, setFormSeq] = useState(0);
  /**
   * #1174 — the datasets bound to the connection being edited, and whether that
   * question could be answered at all.
   *
   * THREE STATES, NOT TWO. `null` with no error is "not read yet"; a non-null
   * `datasetsUnavailable` is "could not read"; a list is a list. An empty list
   * and a failed read must stay distinguishable, because collapsing them would
   * render "nothing would be stranded" on the strength of a fetch that failed
   * (prevention-log #18 — the healthy verdict is earned, never the fallback).
   * `strandedDatasets.ts` is total over the three.
   */
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [datasetsUnavailable, setDatasetsUnavailable] = useState<string | null>(null);
  const openForm = useCallback((next: FormState) => {
    setForm(next);
    setFormSeq((seq) => seq + 1);
  }, []);
  const guardedLoad = useGuardedLoad();
  /**
   * A SECOND instance, deliberately — `useGuardedLoad`'s "one instance per state
   * target" rule. Two fetchers sharing one instance discard each other's
   * answers, so the connections load and this one cannot be pointed at the same
   * runner.
   *
   * Note this is the opposite call from `DatasetsPage.tsx`, which loads the very
   * same PAIR through ONE fetcher and says why: its store picker resolves
   * dataset rows against connection rows, so a list from a different moment
   * would mis-render. Here the two are not resolved against each other on the
   * critical surface — the connections table stands alone, and the datasets list
   * feeds a DIAGNOSTIC. One fetcher would mean a datasets outage takes the
   * connections list down with it, so the page whose job is connections would
   * show an error banner because an advisory failed. The third state below
   * exists exactly so that failure stays local.
   */
  const datasetsLoad = useGuardedLoad();

  // The ONE load path: the mount effect below and every post-mutation refetch
  // (delete / save / import) go through it. That is what ORDERS them — #1062:
  // the New connection button is not gated behind the list having arrived, so a
  // create could complete while the initial load was still in flight, and the
  // mount load would then land second and write the list as it was before the
  // connection existed. `useGuardedLoad` drops the superseded answer; it also
  // owns the AbortController that used to live in this effect, and declines to
  // start a refresh at all once the page has unmounted.
  //
  // Failures are caught here rather than by the caller: a refresh failure after
  // e.g. a create — where the form has already closed — still has to reach
  // `loadError` instead of being swallowed by the gone form's handler. The
  // message is the bare `err.message` this page has always shown.
  const refresh = useCallback(
    () =>
      guardedLoad(listConnections, {
        onData: (list) => {
          setConnections(list);
          setLoadError(null);
        },
        onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
      }),
    [guardedLoad],
  );

  // `refresh` is stable (so is the runner it closes over), so this is the
  // initial load and nothing more.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * #1174 — read the datasets, for the strand advisory only.
   *
   * ON EDIT-FORM OPEN, NOT ON MOUNT, and that is the whole staleness argument.
   * A mount load would be read hours later by an operator who left the tab open
   * and added datasets elsewhere, and would then answer "nothing would be
   * stranded" from a snapshot that predates them — the manufactured-benign-
   * default this page's three states exist to refuse, reached by a slower route.
   * Bound to the gesture instead: the reading is at most as old as the form.
   * It also costs a read-only visit nothing, which a mount load would not.
   *
   * NOT for the New-connection form: a connection that does not exist yet has
   * no `connectionId` for any dataset to name.
   */
  const refreshDatasets = useCallback(
    () =>
      datasetsLoad(listDatasets, {
        onData: (list) => {
          setDatasets(list);
          setDatasetsUnavailable(null);
        },
        // Local to the advisory. This never reaches `loadError` — a diagnostic
        // that could not be computed must not present as a failure of the page.
        onError: (err) => {
          setDatasets(null);
          setDatasetsUnavailable(messageOf(err));
        },
      }),
    [datasetsLoad],
  );

  const openEditForm = useCallback(
    (conn: ConnectionPublic) => {
      setDatasets(null);
      setDatasetsUnavailable(null);
      openForm(formForEdit(conn));
      void refreshDatasets();
    },
    [openForm, refreshDatasets],
  );

  /**
   * Save the connection's export envelope to disk (#959). The fetch happens
   * first and its failure is REPORTED — a bare `<a download>` would have
   * written a 404 body to the operator's disk as a `.json` file with nothing
   * said (see `api/download.ts`).
   *
   * SECURITY: the envelope carries NO secret material. The export route ships
   * `requiresSecret: secretRef !== null` — a boolean, never the ciphertext —
   * and an import turns that boolean into the `requiresSecret` attention item
   * the panel below renders. That is the server's guarantee, not this page's.
   */
  const onExport = useCallback(async (conn: ConnectionPublic) => {
    setLoadError(null);
    try {
      downloadTextFile(
        exportFileName('connection', conn.name, conn.id),
        await exportConnection(conn.id),
      );
    } catch (err) {
      setLoadError(`Could not export “${conn.name}”: ${messageOf(err)}`);
    }
  }, []);

  /**
   * #1174 — the delete confirm names the datasets it would strand.
   *
   * A connection DELETE strands every dataset naming it, whatever their kinds:
   * `routes/connections.ts`'s delete re-gates dependent TRIGGERS and nothing
   * scans datasets, so the `connectionId` simply dangles.
   *
   * THE LIST IS FETCHED HERE, not read from `datasets` state, for two reasons.
   * Delete is reachable from the table without ever opening a form, so the state
   * may hold nothing (or another connection's reading). And this is the
   * irreversible act on the page — the one place worth paying a request to be
   * sure the count is current rather than as old as the last form open. Awaiting
   * the page's guarded load would not do it either: that load resolves the same
   * way whether it wrote, was superseded, or was skipped, and React state is not
   * readable in this closure afterwards regardless.
   *
   * A FAILED READ DOES NOT BLOCK THE DELETE and does not claim there is nothing
   * to strand — the confirm says the check could not be made and lets the
   * operator decide, which is the advisory polarity #1145/#1158 set.
   */
  /**
   * Re-entrancy guard for the delete path, which #1174 made necessary.
   *
   * `window.confirm` BLOCKS the main thread, so while it was the FIRST statement
   * of this handler a second click could not even be dispatched — the old code
   * was accidentally immune to a double-click. Reading the dataset list first
   * puts a real round trip in front of the dialog and the event loop is free for
   * the whole of it: a double-click queues two handlers, the second raises a
   * second confirm for a connection the first has already deleted, and accepting
   * it 404s into `loadError` — an error banner over an operation that in fact
   * succeeded.
   *
   * A REF rather than state, because it has to be read and written
   * SYNCHRONOUSLY inside one handler, before any await. A `useState` flag would
   * not have re-rendered by the time the second click's handler runs, which is
   * the entire window being closed.
   *
   * Keyed BY CONNECTION ID rather than a single page-wide flag: the race is one
   * row being deleted twice, not the page being used twice. A page-wide flag
   * would make a click on a second row during the first row's dataset read a
   * silent no-op — no dialog, no error — which reads as a dead button.
   */
  const deleting = useRef(new Set<string>());

  const onDelete = useCallback(
    async (conn: ConnectionPublic) => {
      if (deleting.current.has(conn.id)) return;
      deleting.current.add(conn.id);
      try {
        let check: StrandCheck;
        try {
          check = {
            state: 'known',
            names: datasetsOnConnection(await listDatasets(), conn.id).map((d) => d.name),
          };
        } catch (err) {
          check = { state: 'unavailable', detail: messageOf(err) };
        }
        if (!window.confirm(deleteConfirmMessage(conn.name, check))) return;
        try {
          await deleteConnection(conn.id);
          await refresh();
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        deleting.current.delete(conn.id);
      }
    },
    [refresh],
  );

  return (
    <section aria-labelledby="connections-heading">
      <div className="page-header">
        <h2 id="connections-heading">Connections</h2>
        <button type="button" onClick={() => openForm(blankForm())}>
          New connection
        </button>
      </div>

      <p className="page-hint">
        A connection is a worker: an LLM API key, a local model, an agent CLI, or an HTTP endpoint.
        Pipelines reference connections; secrets are stored encrypted and never shown again.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {connections === null && !loadError && <p>Loading connections…</p>}

      {connections !== null && connections.length === 0 && (
        <p>No connections yet. Add one to give your pipelines something to run against.</p>
      )}

      {connections !== null && connections.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((conn) => (
              <tr key={conn.id}>
                <td>{conn.name}</td>
                <td>
                  <code>{conn.kind}</code>
                </td>
                <td>
                  <button type="button" onClick={() => openEditForm(conn)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void onExport(conn)}
                    aria-label={`Export ${conn.name}`}
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(conn)}
                    aria-label={`Delete ${conn.name}`}
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
        <ConnectionForm
          /* Remount on every OPEN. The table stays interactive while the form
             is open, so "Edit" on another row swaps `form` in place — and
             without a key the child keeps its own local state across that swap:
             connection A's `probing`/`error`, and A's probe verdict, rendered
             against B. The verdict is the sharp one, because a signature over
             the DRAFT cannot see the switch: two connections sharing non-secret
             config (a staging/prod pair, or an export/import clone) produce an
             identical signature, so A's "Connected." would render for a B that
             was never probed.

             Keyed on the open COUNTER rather than on `form.id`, because `id` is
             `null` for every new-connection form: pressing "New connection"
             twice would not remount, and `blankForm()` is byte-identical each
             time, so the signature would match and the previous draft's verdict
             would render against a form nothing has tested. */
          key={formSeq}
          form={form}
          /* #1174 — the three inputs the strand note needs. `storedKind` is
             read from the LIST rather than snapshotted at form-open, so a
             refreshed list moves it; `undefined` means the row is gone from
             under the open form, which the save's own 404 reports and the note
             deliberately stays silent about (there is no stored kind left for
             an edit to have changed FROM). */
          storedKind={connections?.find((conn) => conn.id === form.id)?.kind}
          datasets={datasets}
          datasetsUnavailable={datasetsUnavailable}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await refresh();
          }}
        />
      )}

      {/* The import surface lives on the list an imported connection lands in —
          but it takes ANY export envelope, because `POST /api/import` does (see
          `ImportPanel`). A pipeline or trigger file is imported and then
          reported with a pointer to its own section, rather than refused by a
          client-side rule the server does not have. */}
      <ImportPanel listKind="connection" onImported={refresh} />
    </section>
  );
}

function ConnectionForm({
  form,
  storedKind,
  datasets,
  datasetsUnavailable,
  onChange,
  onClose,
  onSaved,
}: {
  form: FormState;
  storedKind: ConnectionKind | undefined;
  datasets: Dataset[] | null;
  datasetsUnavailable: string | null;
  onChange: (next: FormState) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * #1191 — the last probe's verdict, tagged with a SIGNATURE of the draft it
   * was taken against.
   *
   * A probe is a reading from one moment, and the moment expires: type a
   * different host after a green test and "Connected." is no longer about
   * anything on screen. Keeping the signature (rather than clearing on every
   * keystroke through an effect) means the verdict simply stops rendering when
   * the draft moves out from under it — the same reason the result is not
   * persisted and never derived from the stored row.
   */
  const [probe, setProbe] = useState<{
    result: ConnectionProbeResult;
    signature: string;
  } | null>(null);
  const [probing, setProbing] = useState(false);
  const editing = form.id !== null;

  const { fields, carried } = useMemo(
    () => connectionFields(form.kind, form.config),
    [form.kind, form.config],
  );
  // A STORED value its control cannot represent forces the JSON editor: showing
  // a form that cannot round-trip what is already saved would corrupt the
  // connection on a save the operator believes touched one other key.
  const unrenderable = useMemo(
    () => unrepresentableFields(fields, form.config),
    [fields, form.config],
  );
  const jsonMode = form.jsonMode || unrenderable.length > 0;

  /**
   * Everything a probe's verdict depends on. The same inputs the advisory memo
   * below reads, plus whether a secret was TYPED — because a blank secret box
   * on an edit means "use the stored one", which is a materially different
   * probe from one carrying a new password.
   */
  const draftSignature = useMemo(
    () =>
      JSON.stringify([
        // `form.id` first, and belt-and-braces with the `key` above: were the
        // remount ever removed, an identical draft on a different connection
        // must still not inherit the previous row's verdict.
        form.id,
        form.kind,
        form.config,
        form.jsonText,
        form.inputs,
        form.secret !== '',
      ]),
    [form.id, form.kind, form.config, form.jsonText, form.inputs, form.secret],
  );

  /**
   * What this kind's own schema says about the draft — ADVISORY only.
   *
   * Never a gate: `routes/connections.ts` runs no per-kind validation, so a
   * config the adapter would reject (an `agent_cli` with no `command`, an `fs`
   * with no `roots`) is storable TODAY. Refusing it here would make an existing
   * row unsaveable after an unrelated rename, and the form must never refuse
   * what the server accepts. Saying so before dispatch is the whole point of
   * the ticket; refusing is a different, worse feature.
   */
  const advisory = useMemo(() => {
    // Both drafts, because the Kind select is reachable in EITHER mode. Going
    // silent in JSON mode left one seam open: switch kind with the textarea
    // showing and the JSON genuinely does not change, so a config shaped for
    // the OLD kind saved with nothing on screen to say so — the exact failure
    // this ticket exists to end, through the one path it did not cover.
    // `owned` — the schema-declared subset — so the kind's own `refine` rules see
    // precisely what their author intended. In JSON mode that IS the whole
    // object, because no form was in the way of it.
    const draft = readConfigDraft(jsonMode, form, fields);
    // An unreadable draft says nothing: submit reports the parse error, and a
    // per-field message already names a control that will not read back.
    if (!draft.ok) return null;
    const candidate = draft.owned;
    // The kind's own rules, INCLUDING the ones its shared schema cannot carry:
    // `fs`'s absolute-root check lives in the server adapter (`node:path`), so
    // a schema-only advisory would say nothing about the one path-safety key in
    // the catalog — the exact silent-until-dispatch failure this ticket ends.
    return connectionConfigAdvisory(form.kind, candidate);
    // The three draft fields plus `kind`, not `form` whole: `form` is a new
    // object on every keystroke, so depending on it would re-parse and
    // re-validate the config while the operator types a NAME or a SECRET.
    // Listing exactly what `readConfigDraft` reads keeps that honest — a fourth
    // field added to it must be added here.
  }, [jsonMode, form.config, form.jsonText, form.inputs, form.kind, fields]);

  /**
   * #1174 — what this kind change would strand, and never a claim it strands
   * nothing when the list was not read.
   *
   * `null` on a NEW connection (nothing can name a row that does not exist yet)
   * and on an unchanged kind, which is what keeps the note off the form for the
   * whole of a rename or a config edit.
   */
  const strandAdvisory = useMemo(() => {
    if (form.id === null || storedKind === undefined || storedKind === form.kind) return null;
    const check: StrandCheck =
      datasetsUnavailable !== null
        ? { state: 'unavailable', detail: datasetsUnavailable }
        : datasets === null
          ? { state: 'loading' }
          : {
              state: 'known',
              names: strandedByKindChange(datasets, form.id, storedKind, form.kind).map(
                (dataset) => dataset.name,
              ),
            };
    return kindChangeAdvisory(check, form.kind);
  }, [form.id, form.kind, storedKind, datasets, datasetsUnavailable]);

  /** Switch kinds WITHOUT discarding anything typed or stored. */
  function onKindChange(kind: ConnectionKind) {
    setError(null); // a parse/save error from the previous kind is not this one's
    const next = connectionFields(kind, form.config);
    // Seed the new kind's controls from the stored config, then let anything
    // already typed win. A plain re-seed would drop every in-progress edit; no
    // re-seed at all would leave a key the new kind owns showing an empty
    // control, which `assembleConfig` reads as a clearing gesture and DELETES.
    onChange({
      ...form,
      kind,
      inputs: { ...seedFieldInputs(next.fields, form.config), ...form.inputs },
    });
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
    const next = connectionFields(form.kind, parsed.config);
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

  /**
   * #1191 — probe what is ON SCREEN, not what is stored: the same
   * `readConfigDraft` the submit path uses, so "Test" and "Save" can never
   * disagree about which draft is live (the fields or the JSON textarea).
   *
   * An EDIT goes through the saved route so the server can fall back to the
   * stored secret when the input is blank — the whole reason the blank input
   * means "keep". A CREATE has no row to fall back to, so it sends the draft.
   */
  async function onTest() {
    setError(null);
    setProbe(null);

    const draft = readConfigDraft(jsonMode, form, fields);
    if (!draft.ok) {
      setError(draft.message);
      return;
    }

    setProbing(true);
    try {
      const secret = form.secret !== '' ? { secret: form.secret } : {};
      const result =
        editing && form.id
          ? await testSavedConnection(form.id, { config: draft.config, ...secret })
          : await testDraftConnection({ kind: form.kind, config: draft.config, ...secret });
      setProbe({ result, signature: draftSignature });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setProbing(false);
    }
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
    const config = draft.config;

    // Build the write body; only include `secret` when the user typed one
    // (blank = keep the existing secret on edit, or none on create).
    const body: ConnectionWrite = {
      name: form.name,
      kind: form.kind,
      config,
      ...(form.secret !== '' ? { secret: form.secret } : {}),
    };

    const parsed = ConnectionWriteSchema.safeParse(body);
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    setSaving(true);
    try {
      if (editing && form.id) {
        await updateConnection(form.id, parsed.data);
      } else {
        await createConnection(parsed.data);
      }
      await onSaved();
    } catch (err) {
      const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      setError(msg);
      setSaving(false);
    }
  }

  return (
    <form
      className="connection-form"
      onSubmit={(e) => void onSubmit(e)}
      aria-label="Connection form"
    >
      <h3>{editing ? 'Edit connection' : 'New connection'}</h3>

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
        Kind
        <select value={form.kind} onChange={(e) => onKindChange(e.target.value as ConnectionKind)}>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>

      <div className="connection-config" role="group" aria-label="Config">
        <div className="config-header">
          <span>Config</span>
          <button type="button" onClick={jsonMode ? toFieldMode : toJsonMode}>
            {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
          </button>
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
              rows={8}
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
                value={form.inputs[field.name] ?? emptyControlValue(field)}
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
      </div>

      {/* #1174 — outside the Config group, because it is a fact about OTHER
          resources rather than about this config, and outside the mode branch
          for the same reason the config advisory above is: the Kind select is
          reachable in both modes.

          A bare `.contract-advisory` paragraph with NO `role`. Every sibling
          advisory on this page is one, and the two live-region roles are both
          already claimed here in the singular — `role="status"` by the probe
          verdict (which this form's own e2e asserts the COUNT of) and
          `role="alert"` by the load error. A second of either turns those
          queries into strict-mode violations, and a strand note is not an
          interruption: it appears next to the control that caused it, in
          response to the operator's own gesture. */}
      {strandAdvisory !== null && <p className="contract-advisory">{strandAdvisory}</p>}

      <label>
        Secret
        <input
          type="password"
          value={form.secret}
          onChange={(e) => onChange({ ...form, secret: e.target.value })}
          placeholder={editing ? 'leave blank to keep the current secret' : 'optional'}
          autoComplete="off"
        />
      </label>
      {/* Never a `required` input: on edit blank means KEEP the stored secret,
          and on create the server accepts a secretless row (it derives
          `needs_secret` and stores it). This says what the kind DOES with one. */}
      <p className="page-hint">
        {connectionKindRequiresSecret(form.kind)
          ? `Required — an ${form.kind} connection cannot dispatch without a secret. `
          : ''}
        {CONNECTION_SECRET_USE[form.kind]}
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {/* #1191 — the probe verdict. `role="status"` (not `alert`): a passing
          test is informational, and the page's `alert` is already spoken for by
          errors. A REFUSAL still lands here rather than in the error slot,
          because it is the adapter's answer to a question that was asked and
          answered — not a failure of the form. */}
      {probe !== null && probe.signature === draftSignature && (
        <p role="status" className={probe.result.ok ? 'probe-ok' : 'probe-failed'}>
          {probe.result.ok
            ? probe.result.probed === 'liveness'
              ? 'Connected.'
              : // The honest half of the contract: two kinds cannot reach
                // anything (`agent_cli` will not spawn a command just to look;
                // `http` has nowhere to go without a baseUrl), so their `ok`
                // means the settings parse and nothing more.
                'These settings are valid — this kind is not contacted until it runs.'
            : probe.result.error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving || probing}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create connection'}
        </button>
        {/* Never a submit: testing must not save. */}
        <button type="button" onClick={() => void onTest()} disabled={saving || probing}>
          {probing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={onClose} disabled={saving || probing}>
          Cancel
        </button>
      </div>
    </form>
  );
}
