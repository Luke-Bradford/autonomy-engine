import { useCallback, useEffect, useState } from 'react';
import { formatZodIssues } from '@autonomy-studio/shared';
import { ApiError, messageOf } from '../api/client';
import {
  SecretWriteSchema,
  createSecret,
  deleteSecret,
  listSecrets,
  type NamedSecret,
} from '../api/secrets';
import { formatWhen } from './runs/format';

type FormState = { name: string; secret: string };

function blankForm(): FormState {
  return { name: '', secret: '' };
}

/**
 * #1060 — Manage › Secrets: the front end of the standalone secret vault
 * (item 7 / S1). `/api/secrets` shipped with no caller anywhere in the web
 * package, which left a hole in a core path rather than a missing convenience:
 * `{ "$secret": "<name>" }` in a node's config resolves at dispatch against
 * exactly this table (`run/executor.ts` → `getSecretByName`), so an operator
 * could author a marker and had nowhere in the product to create the secret it
 * names.
 *
 * SECURITY — write-only, end to end. A value travels in one direction only.
 * The server has no route that returns one and `SecretPublicSchema` omits both
 * `ciphertext` and the opaque `ref`, so this page cannot display a secret even
 * if it tried; the list below renders a name and a date. Owner scoping is
 * entirely the server's (`ownerId` stamped from the principal on create,
 * `requireOwned` on delete) — this page never sends an owner, and the strict
 * write body 400s a client that tries.
 *
 * There is deliberately NO request-sequencing guard here (contrast
 * `pipelinesStore.latestLoad`). That guard exists where two concurrent loads
 * of the same list can be in flight — a filter toggle, a poll. This page has
 * exactly two load paths: the mount effect, aborted on unmount, and a
 * post-mutation `refresh` already awaited inside its own handler. Adding a
 * latest-wins token here would be machinery guarding a race that has no
 * producer.
 */
export function SecretsPage() {
  const [secrets, setSecrets] = useState<NamedSecret[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  // Refetch after a mutation. Called only from event handlers, never
  // synchronously inside an effect — so its setState is safe.
  const refresh = useCallback(async () => {
    try {
      setSecrets(await listSecrets());
      setLoadError(null);
    } catch (err) {
      setLoadError(`Could not load secrets: ${messageOf(err)}`);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listSecrets(controller.signal)
      .then((list) => {
        setSecrets(list);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(`Could not load secrets: ${messageOf(err)}`);
      });
    return () => controller.abort();
  }, []);

  const onDelete = useCallback(
    async (secret: NamedSecret) => {
      // Deleting is also how a value is ROTATED — there is no update route —
      // so the confirmation says what breaks rather than only what goes away.
      if (
        !window.confirm(
          `Delete secret "${secret.name}"?\n\n` +
            `Any pipeline node referencing {"$secret":"${secret.name}"} will fail at ` +
            `dispatch until a secret of that name exists again.`,
        )
      ) {
        return;
      }
      try {
        await deleteSecret(secret.id);
        await refresh();
      } catch (err) {
        setLoadError(`Could not delete “${secret.name}”: ${messageOf(err)}`);
      }
    },
    [refresh],
  );

  return (
    <section aria-labelledby="secrets-heading">
      <div className="page-header">
        <h2 id="secrets-heading">Secrets</h2>
        <button type="button" onClick={() => setForm(blankForm())}>
          New secret
        </button>
      </div>

      <p className="page-hint">
        A secret is a named credential, stored encrypted. A pipeline never contains the value — a
        node references it by name as <code>{'{"$secret": "<name>"}'}</code>, and it is decrypted
        only at dispatch. Values are write-only: once saved, a secret can be replaced or deleted,
        never read back.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {secrets === null && !loadError && <p>Loading secrets…</p>}

      {secrets !== null && secrets.length === 0 && (
        <p>No secrets yet. Add one to give a pipeline a credential to reference by name.</p>
      )}

      {secrets !== null && secrets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => (
              <tr key={secret.id}>
                <td>
                  <code>{secret.name}</code>
                </td>
                <td>{formatWhen(secret.createdAt)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => void onDelete(secret)}
                    aria-label={`Delete ${secret.name}`}
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
        <SecretForm
          form={form}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function SecretForm({
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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = SecretWriteSchema.safeParse({ name: form.name, secret: form.secret });
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    setSaving(true);
    try {
      await createSecret(parsed.data);
      // Clear the typed value before handing back. Not a security control —
      // the plaintext has already been in an input's value and in the request
      // body — but a form left populated invites re-submitting the same
      // credential under a second name by accident.
      onChange(blankForm());
      await onSaved();
    } catch (err) {
      // The server answers EVERY unique-constraint violation with one generic
      // sentence ("The request conflicts with existing data."), which on this
      // form is unactionable: the operator cannot tell that the collision is
      // the name, still less that it collided case-insensitively (#533:
      // `UNIQUE(owner_id, name COLLATE NOCASE)`). Name both here — this is the
      // single likeliest failure on first use of this page.
      setError(
        err instanceof ApiError && err.status === 409
          ? `A secret named “${form.name}” already exists. Secret names ignore case, so ` +
              `“${form.name}” and “${form.name.toLowerCase()}” are the same name. ` +
              `Delete the existing one to replace its value.`
          : messageOf(err),
      );
      setSaving(false);
    }
  }

  return (
    <form className="connection-form" onSubmit={(e) => void onSubmit(e)} aria-label="Secret form">
      <h3>New secret</h3>

      <label>
        Name
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="the name a node references, e.g. stripe-key"
          required
        />
      </label>

      <label>
        Value
        <input
          type="password"
          value={form.secret}
          onChange={(e) => onChange({ ...form, secret: e.target.value })}
          autoComplete="off"
          required
        />
      </label>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Create secret'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
