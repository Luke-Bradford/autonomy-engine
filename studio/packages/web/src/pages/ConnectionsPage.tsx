import { useCallback, useEffect, useState } from 'react';
import {
  ConnectionKindSchema,
  formatZodIssues,
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
import { ImportPanel } from './ImportPanel';

const KINDS = ConnectionKindSchema.options;

type FormState = {
  id: string | null; // null = creating, otherwise editing this connection
  name: string;
  kind: ConnectionWrite['kind'];
  configText: string;
  secret: string;
};

function blankForm(): FormState {
  // KINDS is the connection-kind enum's option list — statically non-empty.
  return { id: null, name: '', kind: KINDS[0]!, configText: '{}', secret: '' };
}

function formForEdit(conn: ConnectionPublic): FormState {
  return {
    id: conn.id,
    name: conn.name,
    kind: conn.kind,
    configText: JSON.stringify(conn.config, null, 2),
    secret: '', // never prefilled — secrets are write-only, blank = keep existing
  };
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

  // Refetch after a mutation (delete / save). Called only from event handlers,
  // never synchronously inside an effect — so its setState is safe.
  const refresh = useCallback(async () => {
    try {
      const list = await listConnections();
      setConnections(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load: the promise-callback form keeps setState off the synchronous
  // effect body (React's `set-state-in-effect` guidance) and lets the cleanup
  // abort an in-flight request on unmount.
  useEffect(() => {
    const controller = new AbortController();
    listConnections(controller.signal)
      .then((list) => {
        setConnections(list);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, []);

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
      downloadTextFile(exportFileName('connection', conn.name, conn.id), await exportConnection(conn.id));
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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let config: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(form.configText.trim() === '' ? '{}' : form.configText);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('config must be a JSON object');
      }
      config = raw as Record<string, unknown>;
    } catch (err) {
      setError(`Invalid config JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
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
        <select
          value={form.kind}
          onChange={(e) => onChange({ ...form, kind: e.target.value as ConnectionWrite['kind'] })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>

      <label>
        Config (JSON)
        <textarea
          value={form.configText}
          onChange={(e) => onChange({ ...form, configText: e.target.value })}
          rows={5}
          spellCheck={false}
        />
      </label>

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
