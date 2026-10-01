import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { ApiError, messageOf } from '../api/client';
import {
  SecretRotateSchema,
  SecretWriteSchema,
  createSecret,
  deleteSecret,
  listSecrets,
  rotateSecret,
  type NamedSecret,
} from '../api/secrets';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { FormDrawer } from '../lib/form/FormDrawer';
import { FormSection } from '../lib/form/FormSection';
import { RequiredMark } from '../lib/form/RequiredMark';
import { FieldError } from '../lib/form/FieldError';
import { FormErrors } from '../lib/form/FormErrors';
import { nameCheck, useFieldValidation, type FieldErrors } from '../lib/form/fieldValidation';
import { saveRefusal, schemaRefusal } from '../lib/form/saveErrors';
import { SecretInput } from '../lib/form/SecretInput';
import { useDrawerForm, type UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { payloadSignature } from './pipeline/configForm';
import { formatWhen } from './runs/format';

/** `id === null` means creating; otherwise this form REPLACES that secret's
 *  value (#1061). The `id: string | null` discriminator is the shape
 *  `ConnectionsPage` and `TriggersPage` already use for create-vs-edit — a
 *  third shape here would only be a third thing to learn. */
type FormState = { id: string | null; name: string; secret: string };

function blankForm(): FormState {
  return { id: null, name: '', secret: '' };
}

/** Prefills the NAME only. A value is never prefilled because none can be read
 *  back — and unlike `ConnectionsPage`'s form, a blank value here does NOT mean
 *  "keep the existing one": rotation exists to change it, so `min(1)` makes
 *  blank a validation error rather than a silent no-op. */
function formForReplace(secret: NamedSecret): FormState {
  return { id: secret.id, name: secret.name, secret: '' };
}

/** #1396 — what Save would write, for the unsaved-changes guard. */
function savePayloadSignature(form: FormState): string {
  return payloadSignature([form.name, form.secret]);
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
 * if it tried; the list below renders a name and a date. That holds for
 * REPLACE (#1061) as much as for create: a rotation sends a new value and gets
 * back the same public projection, never the old one. Owner scoping is
 * entirely the server's (`ownerId` stamped from the principal on create,
 * `requireOwned` on every by-id route — replace and delete alike) — this page
 * never sends an owner, and the strict write bodies 400 a client that tries.
 *
 * Every load goes through `refresh`, which is LATEST-WINS. This page is where
 * that guard was first written; #1062 lifted it into `useGuardedLoad` once the
 * same race was found on Connections and Triggers, which had copied the shape
 * without it. The hook's docblock carries the full argument — in short, the New
 * secret button is not gated behind the list having arrived, so an operator can
 * create a secret while the MOUNT load is still in flight, and the mount load
 * would then land second and overwrite it with a list taken before the secret
 * existed.
 */
export function SecretsPage() {
  const [secrets, setSecrets] = useState<NamedSecret[] | null>(null);
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

  /** The ONE load path — the mount effect below and every post-mutation
   *  refetch. The hook owns the ticket and the mount `AbortController`. */
  const refresh = useCallback(
    () =>
      guardedLoad(listSecrets, {
        onData: (list) => {
          setSecrets(list);
          setLoadError(null);
        },
        onError: (err) => setLoadError(`Could not load secrets: ${messageOf(err)}`),
      }),
    [guardedLoad],
  );

  // `refresh` is stable (so is the runner it closes over), so this is the
  // initial load and nothing more.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (secret: NamedSecret) => {
      // Deleting RETIRES the name, which is a different act from replacing the
      // value behind it (#1061 gave that its own route and button). What it
      // costs is the same either way, so the confirmation states it: every node
      // referencing the name breaks until a secret of that name exists again.
      if (
        !window.confirm(
          `Delete secret "${secret.name}"?\n\n` +
            `Any pipeline node referencing {"$secret":"${secret.name}"} will fail at ` +
            `dispatch until a secret of that name exists again.\n\n` +
            `To change its VALUE and keep the name, use Replace instead.`,
        )
      ) {
        return;
      }
      try {
        await deleteSecret(secret.id);
        closeWhere((open) => open.id === secret.id);
        await refresh();
      } catch (err) {
        setLoadError(`Could not delete “${secret.name}”: ${messageOf(err)}`);
      }
    },
    [refresh, closeWhere],
  );

  return (
    <section aria-labelledby="secrets-heading">
      <div className="page-header">
        <h2 id="secrets-heading">Secrets</h2>
        <button
          type="button"
          onClick={(e) => drawer.openFrom(e.currentTarget, () => openForm(blankForm()))}
        >
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

      {/* #1396 — the list and the form side by side; the form is a column, not
          an overlay, so the row actions stay reachable while it is open. */}
      {guard.routeHold}
      <div className={form ? 'drawer-layout-open' : undefined}>
        <div>
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
                      {/* No confirmation dialog on Replace, deliberately. The form
                      IS the confirmation — it names its target in the heading,
                      shows the name read-only, and takes an explicit submit —
                      and a dialog over a form the operator has just filled in
                      is noise rather than a check. */}
                      <button
                        type="button"
                        onClick={(e) =>
                          drawer.openFrom(e.currentTarget, () => openForm(formForReplace(secret)))
                        }
                        aria-label={`Replace ${secret.name}`}
                      >
                        Replace
                      </button>{' '}
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
        </div>

        {form && (
          <SecretForm
            /* Keyed on the open counter, so an error from one draft never
               renders against the next (see `useDrawerForm`). */
            key={formSeq}
            form={form}
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
    </section>
  );
}

/**
 * #1396 — what is wrong with a secret draft now, by field, in the form's order.
 * The name is checked only on a create (a replaced secret's name is read-only),
 * by the write schema's own rule, so the form never refuses what the server
 * accepts; an empty one gets the plain words every form uses.
 */
function secretChecks(form: FormState): FieldErrors {
  const out: Record<string, string> = {};
  if (form.id === null) {
    const empty = nameCheck(form.name);
    const parsed = SecretWriteSchema.shape.name.safeParse(form.name);
    if (empty.name !== undefined) out.name = empty.name;
    else if (!parsed.success) out.name = parsed.error.issues[0]?.message ?? 'Invalid name';
  }
  if (form.secret === '') out.secret = 'Enter a value.';
  return out;
}

function SecretForm({
  form,
  onChange,
  guard,
  returnFocusTo,
  onClose,
  onSaved,
}: {
  form: FormState;
  onChange: (next: FormState) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const replacing = form.id !== null;

  const checks = useMemo(
    () => secretChecks({ id: form.id, name: form.name, secret: form.secret }),
    [form.id, form.name, form.secret],
  );
  /** The summary's names for the form's fields; a replaced secret's name is not one. */
  const labelOf = useCallback(
    (key: string) => {
      if (key === 'name') return replacing ? undefined : 'Name';
      return key === 'secret' ? 'Value' : undefined;
    },
    [replacing],
  );
  const validation = useFieldValidation(checks, labelOf);
  const nameErrorId = useId();
  const valueErrorId = useId();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // #1396 — every field that is wrong now is shown beside itself first.
    if (!validation.attempt()) return;

    // Two different bodies, and the SHARED schema for each — the rotate body
    // carries the value alone, because the route refuses a name (#1061: the
    // name is the lookup key every stored marker resolves through).
    //
    // `form.id` is what discriminates, not the parsed body: the rotate body has
    // no `name` to switch on, so narrowing the union by shape would be reading
    // the answer off the absence of a field.
    const { id } = form;
    const parsed =
      id === null
        ? SecretWriteSchema.safeParse({ name: form.name, secret: form.secret })
        : SecretRotateSchema.safeParse({ secret: form.secret });
    if (!parsed.success) {
      setError(schemaRefusal(parsed.error.issues, validation));
      return;
    }

    setSaving(true);
    try {
      await (id === null
        ? createSecret({ name: form.name, secret: parsed.data.secret })
        : rotateSecret(id, { secret: parsed.data.secret }));
      // `onSaved` closes this drawer, which drops the typed value with it. Not
      // a security control — the plaintext has already been in an input's
      // value and in the request body — but a form left populated invites
      // re-submitting the same credential under a second name by accident.
      // It does NOT reset the form through `onChange`: that writes the page's
      // ONE form state, and if the operator opened another secret's form while
      // this save was in flight, a reset here would blank THAT form (#1396).
      await onSaved();
    } catch (err) {
      // The server answers EVERY unique-constraint violation with one generic
      // sentence ("The request conflicts with existing data."), which on this
      // form is unactionable: the operator cannot tell that the collision is
      // the name, still less that it collided case-insensitively (#533:
      // `UNIQUE(owner_id, name COLLATE NOCASE)`). Name both here — this is the
      // single likeliest failure on first use of this page.
      //
      // `secrets` carries a second unique index, on `ref`, so a 409 is not
      // NECESSARILY the name. But `ref` is a server-minted nanoid, so a
      // collision there is not a state a client can provoke or realistically
      // reach; treating it as the name is the right call for a message, not an
      // oversight.
      //
      // The case clause ILLUSTRATES the rule by contrasting two spellings, which
      // only illustrates anything when the two spellings differ. On a name the
      // operator already typed in lower case it degrades to «“stripe-key” and
      // “stripe-key” are the same name» — redundant where it was meant to be
      // explanatory. State the rule without the example in that case; the rule
      // is what makes the conflict actionable, the example is only its garnish.
      const lowered = form.name.toLowerCase();
      const caseRule =
        form.name === lowered
          ? `Secret names ignore case.`
          : `Secret names ignore case, so “${form.name}” and “${lowered}” are the same name.`;
      // A rotation cannot conflict — its name is not moving — so this
      // explanation belongs to the create path only. It is the NAME's problem,
      // so it is shown beside the Name (#1396).
      if (!replacing && err instanceof ApiError && err.status === 409) {
        validation.showRefusedFields({
          name:
            `A secret named “${form.name}” already exists. ${caseRule} ` +
            `Use Replace to change its value.`,
        });
      } else {
        setError(saveRefusal(err, validation));
      }
      setSaving(false);
    }
  }

  return (
    <FormDrawer
      title={replacing ? `Replace value for ${form.name}` : 'New secret'}
      formLabel="Secret form"
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving}
      returnFocusTo={returnFocusTo}
      validation={validation}
      status={<FormErrors validation={validation} message={error} />}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : replacing ? 'Replace value' : 'Create secret'}
          </button>
        </>
      }
    >
      <FormSection title="Basics">
        <label>
          <span>
            Name
            {/* A name that cannot change asks nothing of the operator. */}
            {!replacing && <RequiredMark />}
          </span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder="the name a node references, e.g. stripe-key"
            // Read-only rather than absent when replacing: the operator needs to
            // see WHICH secret is about to change, and the name genuinely cannot
            // move (the route 400s a rename), so an editable field would only
            // offer an error. Read-only, not disabled — a disabled input is
            // skipped by keyboard navigation and by some screen readers, and
            // this one is information worth reaching.
            readOnly={replacing}
            required
            {...validation.attrsFor('name', nameErrorId)}
          />
        </label>
        <FieldError id={nameErrorId} message={validation.errorFor('name')} />
      </FormSection>

      <FormSection title="Value">
        <SecretInput
          label={
            <span>
              Value
              <RequiredMark />
            </span>
          }
          value={form.secret}
          onChange={(secret) => onChange({ ...form, secret })}
          required
          field={validation.attrsFor('secret', valueErrorId)}
        />
        <FieldError id={valueErrorId} message={validation.errorFor('secret')} />
        <p className="page-hint">
          Write-only: once saved, the value can be replaced but never read back.
        </p>
      </FormSection>
    </FormDrawer>
  );
}
