import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONNECTION_KINDS,
  CONNECTION_SECRET_USE,
  connectionConfigSchema,
  connectionKindRequiresSecret,
  formatZodIssues,
  type ConnectionKind,
  type ConnectionPublic,
} from '@autonomy-studio/shared';
import { ApiError, messageOf } from '../api/client';
import {
  ConnectionWriteSchema,
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
  type ConnectionWrite,
} from '../api/connections';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportConnection } from '../api/portability';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { ImportPanel } from './ImportPanel';
import {
  assembleConfig,
  deriveConfigFields,
  seedFieldInputs,
  unrepresentableFields,
  type ConfigField,
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
  inputs: Record<string, string | boolean>;
  /** The whole-config JSON draft. */
  jsonText: string;
  /** Whether the operator ASKED for JSON. An unrenderable value forces it too. */
  jsonMode: boolean;
  secret: string;
};

/**
 * The controls for one kind's config, plus any CARRIED key.
 *
 * A carried key is one the stored config holds that this kind does not declare
 * but another kind does — the residue of a kind switch. Rendering it (rather
 * than only naming it) is what `ContainerPanel` does with a container's illegal
 * fields and for the same reason: it makes "blank the control to drop the key"
 * the repair, instead of a dead end that can only be fixed in the JSON editor.
 * A carried field is always `optional` here, so blanking it OMITS the key —
 * which is exactly the clearing gesture `assembleConfig` honours.
 *
 * A key no kind declares is not carried: nothing can describe it, so it stays
 * untouched in `config` and is reachable through the JSON escape hatch.
 */
function connectionFields(
  kind: ConnectionKind,
  config: Record<string, unknown>,
): { fields: ConfigField[]; carried: string[] } {
  const own = deriveConfigFields(connectionConfigSchema(kind)) ?? [];
  const seen = new Set(own.map((f) => f.name));
  const carried: ConfigField[] = [];
  for (const other of KINDS) {
    if (other === kind) continue;
    for (const field of deriveConfigFields(connectionConfigSchema(other)) ?? []) {
      if (seen.has(field.name) || !(field.name in config)) continue;
      seen.add(field.name);
      carried.push({ ...field, optional: true });
    }
  }
  return { fields: [...own, ...carried], carried: carried.map((f) => f.name) };
}

/** Read the JSON draft back out as a config object. Empty text means `{}`. */
function parseConfigText(
  text: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const raw: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'Invalid config JSON: config must be a JSON object' };
    }
    return { ok: true, config: raw as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      message: `Invalid config JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
  const guardedLoad = useGuardedLoad();

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

  const onDelete = useCallback(
    async (conn: ConnectionPublic) => {
      if (!window.confirm(`Delete connection "${conn.name}"?`)) return;
      try {
        await deleteConnection(conn.id);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return (
    <section aria-labelledby="connections-heading">
      <div className="page-header">
        <h2 id="connections-heading">Connections</h2>
        <button type="button" onClick={() => setForm(blankForm())}>
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
                  <button type="button" onClick={() => setForm(formForEdit(conn))}>
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
          form={form}
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
  onChange,
  onClose,
  onSaved,
}: {
  form: FormState;
  onChange: (next: FormState) => void;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    if (jsonMode) return null;
    const assembled = assembleConfig(form.config, fields, form.inputs);
    if (!assembled.ok) return null; // the per-field message already says this
    const parsed = connectionConfigSchema(form.kind).safeParse(assembled.owned);
    return parsed.success ? null : formatZodIssues(parsed.error.issues);
  }, [jsonMode, form.config, form.kind, form.inputs, fields]);

  /** Switch kinds WITHOUT discarding anything typed or stored. */
  function onKindChange(kind: ConnectionKind) {
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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Read back whichever draft is on screen — never the other one, which is
    // why every mode change above commits to `config` before switching.
    let config: Record<string, unknown>;
    if (jsonMode) {
      const parsed = parseConfigText(form.jsonText);
      if (!parsed.ok) {
        setError(parsed.message);
        return;
      }
      config = parsed.config;
    } else {
      const assembled = assembleConfig(form.config, fields, form.inputs);
      if (!assembled.ok) {
        setError(assembled.message);
        return;
      }
      config = assembled.config;
    }

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

      <div className="connection-config" aria-label="Config">
        <div className="connection-config-header">
          <span>Config</span>
          <button type="button" onClick={jsonMode ? toFieldMode : toJsonMode}>
            {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
          </button>
        </div>

        {unrenderable.length > 0 && (
          <p className="page-hint">
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
                value={form.inputs[field.name] ?? (field.kind === 'boolean' ? false : '')}
                onChange={(next) =>
                  onChange({ ...form, inputs: { ...form.inputs, [field.name]: next } })
                }
              />
            ))}
            {carried.length > 0 && (
              <p className="page-hint">
                {`Carried from another kind (${carried.join(', ')}) — ${form.kind} ignores these; blank a control to drop the key.`}
              </p>
            )}
            {advisory !== null && (
              <p className="page-hint">{`This ${form.kind} config is incomplete: ${advisory}`}</p>
            )}
          </>
        )}
      </div>

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

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create connection'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
