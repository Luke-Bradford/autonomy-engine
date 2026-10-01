import { useCallback, useEffect, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import {
  GlobalParamCreateBodySchema,
  GlobalParamTypeSchema,
  GlobalParamValueSchema,
  formatZodIssues,
  globalParamNameDefect,
  type GlobalParam,
  type GlobalParamPatchBody,
  type GlobalParamType,
} from '@autonomy-studio/shared';
import { ApiError, messageOf } from '../api/client';
import { downloadTextFile, exportFileName } from '../api/download';
import {
  createGlobalParam,
  deleteGlobalParam,
  getGlobalParamUsage,
  listGlobalParams,
  updateGlobalParam,
} from '../api/globalParams';
import { exportGlobalParam } from '../api/portability';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { LabelledControl } from '../lib/LabelledControl';
import { FormDrawer } from '../lib/form/FormDrawer';
import { FormSection } from '../lib/form/FormSection';
import { RequiredMark } from '../lib/form/RequiredMark';
import { useDrawerForm, type UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { deleteConfirmText } from './globalParamDeleteText';
import { ImportPanel } from './ImportPanel';
import { coerceGlobalValue, formatDefaultInput } from './pipeline/paramRules';
import { payloadSignature } from './pipeline/configForm';

/**
 * The open form. `stored` is the global as it was when an EDIT opened — what
 * Save diffs against — and `null` when creating.
 */
interface FormState {
  stored: GlobalParam | null;
  name: string;
  type: GlobalParamType;
  valueText: string;
  description: string;
}

function blankForm(): FormState {
  return { stored: null, name: '', type: 'string', valueText: '', description: '' };
}

function formForEdit(global: GlobalParam): FormState {
  return {
    stored: global,
    name: global.name,
    type: global.type,
    valueText: formatDefaultInput(global.value, global.type),
    description: global.description,
  };
}

/** #1396 — what Save would write, for the unsaved-changes guard. */
function savePayloadSignature(form: FormState): string {
  return payloadSignature([form.name, form.type, form.valueText, form.description]);
}

const VALUE_PLACEHOLDER: Record<GlobalParamType, string> = {
  string: 'empty text is a value',
  number: '42',
  boolean: 'true or false',
  json: '{"key": "value"}',
};

/**
 * #844 GL2 — Manage › Global parameters: the front end of the workspace
 * global-params store GL1 shipped (spec
 * `studio/docs/2026-09-27-foundation-global-params.md` GL-D8). The operator can
 * fill the store before GL3 lets a pipeline read it, and the hint says so.
 *
 * #1396 OR5 — a list, and a create/edit form in the shared drawer
 * (`studio/docs/ui-patterns.md`). Until then each global was an inline row
 * editor built on the canvas's `ContractRow`; a resource the SERVER stores is
 * a Manage resource, and gets the Manage form. On an edit the name and type
 * are read-only: both are immutable (GL-D1), so a rename or retype is delete +
 * create, and the form says so rather than offering an edit the route would
 * 400. Save PATCHes only what changed against the global as it was when the
 * form OPENED (`FormState.stored`), never the live list, which a refetch can
 * move under an open form.
 *
 * SECURITY: owner scoping is the server's (`requireOwned` on every by-id
 * route, the list scoped in SQL); this page never sends an owner. A value is
 * CLEARTEXT (GL-D5) — it is shown here, and will be copied into run logs,
 * exports and git — so the page says so beside every value and sends a
 * credential to Secrets.
 */
export function GlobalParamsPage() {
  const [globals, setGlobals] = useState<GlobalParam[] | null>(null);
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

  /** The ONE load path — mount and every post-mutation refetch, latest-wins. */
  const refresh = useCallback(
    () =>
      guardedLoad(listGlobalParams, {
        onData: (list) => {
          setGlobals(list);
          setLoadError(null);
        },
        onError: (err) => setLoadError(`Could not load global parameters: ${messageOf(err)}`),
      }),
    [guardedLoad],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (global: GlobalParam) => {
      // #844 GL3 (GL-D4) — what reads it, shown before the choice. Advisory: a
      // failed read says so and still lets the operator decide.
      const usage = await getGlobalParamUsage(global.id).catch(() => null);
      if (!window.confirm(deleteConfirmText(global.name, usage))) {
        return;
      }
      try {
        await deleteGlobalParam(global.id);
        closeWhere((open) => open.stored?.id === global.id);
        await refresh();
      } catch (err) {
        setLoadError(`Could not delete “${global.name}”: ${messageOf(err)}`);
      }
    },
    [refresh, closeWhere],
  );

  /** #844 GL6 — save the global's export file, as Datasets does (#1143). */
  const { active: exporting, run: runExport } = useBusyAction();
  const onExport = useCallback(
    (global: GlobalParam) =>
      runExport(global.id, async () => {
        setLoadError(null);
        try {
          downloadTextFile(
            exportFileName('global-param', global.name, global.id),
            await exportGlobalParam(global.id),
          );
        } catch (err) {
          setLoadError(`Could not export “${global.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  return (
    <section aria-labelledby="global-params-heading">
      <div className="page-header">
        <h2 id="global-params-heading">Global parameters</h2>
        <button
          type="button"
          onClick={(e) => drawer.openFrom(e.currentTarget, () => openForm(blankForm()))}
        >
          New global parameter
        </button>
      </div>

      <p className="page-hint">
        A global parameter is a named value every pipeline in this workspace shares, to be read as{' '}
        <code>{'${global.<name>}'}</code>. A run records the values it read, so editing a global
        changes later runs, never one already started. A name and type are fixed once created: to
        change either, delete the global and create it again.
      </p>
      <p className="page-hint">
        Values are <strong>cleartext</strong>: they are shown here and will be copied into run logs,
        exports and git. Put a credential in <Link to="/manage/secrets">Secrets</Link> instead.
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
          {globals === null && !loadError && <p>Loading global parameters…</p>}

          {globals !== null && globals.length === 0 && <p>No global parameters yet.</p>}

          {globals !== null && globals.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Value</th>
                  <th scope="col">Description</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {globals.map((global) => {
                  const valueText = formatDefaultInput(global.value, global.type);
                  return (
                    <tr key={global.id}>
                      <td>
                        <code>{global.name}</code>
                      </td>
                      <td>{global.type}</td>
                      <td>
                        {/* Cleartext by design (GL-D5), so shown; a long json
                            value (or description) is cut to one line, whole in
                            the tooltip and in the form. */}
                        <code className="cell-one-line" title={valueText}>
                          {valueText}
                        </code>
                      </td>
                      <td>
                        <span className="cell-one-line" title={global.description}>
                          {global.description}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={(e) =>
                            drawer.openFrom(e.currentTarget, () => openForm(formForEdit(global)))
                          }
                          aria-label={`Edit ${global.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void onExport(global)}
                          aria-label={`Export ${global.name}`}
                          disabled={exporting.has(global.id)}
                          aria-busy={exporting.has(global.id)}
                        >
                          Export
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(global)}
                          aria-label={`Delete ${global.name}`}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {form && (
          <GlobalParamForm
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

      <ImportPanel listKind="global-param" onImported={refresh} />
    </section>
  );
}

function GlobalParamForm({
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
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { stored } = form;
  const editing = stored !== null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsedValue = coerceGlobalValue(form.type, form.valueText);

    let write: () => Promise<unknown>;
    if (stored === null) {
      // A bad value short-circuits the schema below, which is where the name
      // rule lives — so name both, or fixing the value only reveals the next error.
      if (!parsedValue.ok) {
        const name = globalParamNameDefect(form.name);
        return setError(name ? `${name}; ${parsedValue.error}` : parsedValue.error);
      }
      const body = GlobalParamCreateBodySchema.safeParse({
        name: form.name,
        type: form.type,
        value: parsedValue.value,
        description: form.description,
      });
      if (!body.success) return setError(formatZodIssues(body.error.issues));
      write = () => createGlobalParam(body.data);
    } else {
      // Only what changed since the form opened: a PATCH of an untouched
      // value would rewrite it, and bump `updatedAt`, for nothing.
      const patch: GlobalParamPatchBody = {};
      if (form.valueText !== formatDefaultInput(stored.value, stored.type)) {
        if (!parsedValue.ok) return setError(parsedValue.error);
        // The STORED type, as the route checks it.
        const checked = GlobalParamValueSchema.safeParse({
          type: stored.type,
          value: parsedValue.value,
        });
        if (!checked.success) return setError(formatZodIssues(checked.error.issues));
        patch.value = parsedValue.value;
      }
      if (form.description !== stored.description) patch.description = form.description;
      // Nothing changed: there is nothing to write, so Save just closes.
      if (Object.keys(patch).length === 0) return onSaved();
      write = () => updateGlobalParam(stored.id, patch);
    }

    setSaving(true);
    try {
      await write();
      await onSaved();
    } catch (err) {
      // The server answers every unique violation with one generic sentence,
      // which cannot tell the operator the collision was the NAME, compared
      // without case (`COLLATE NOCASE`). This is the likeliest failure on
      // create, so name it (the SecretsPage precedent).
      setError(
        !editing && err instanceof ApiError && err.status === 409
          ? `A global parameter named “${form.name}” already exists. Names ignore case.`
          : messageOf(err),
      );
    } finally {
      // After a success this form has usually unmounted (the drawer closed),
      // so this is a no-op then, which React 19 permits silently. It matters
      // on failure, when the form stays.
      setSaving(false);
    }
  }

  return (
    <FormDrawer
      title={editing ? 'Edit global parameter' : 'New global parameter'}
      formLabel="Global parameter form"
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => void onSubmit(e)}
      busy={saving}
      returnFocusTo={returnFocusTo}
      status={
        error && (
          <p role="alert" className="error">
            {error}
          </p>
        )
      }
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create global parameter'}
          </button>
        </>
      }
    >
      <FormSection title="Basics">
        {/* On an edit both are READ-ONLY rather than disabled: a disabled
            control is skipped by keyboard navigation and by some screen
            readers, and which global this is remains worth reaching. A
            `<select>` has no read-only state, so a stored Type is an input. */}
        <label>
          <span>
            Name
            {!editing && <RequiredMark />}
          </span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder="read as ${global.<name>}"
            readOnly={editing}
            required
          />
        </label>
        <LabelledControl
          label={
            <>
              Type
              {!editing && <RequiredMark />}
            </>
          }
        >
          {(id) =>
            editing ? (
              <input id={id} type="text" value={form.type} readOnly />
            ) : (
              <select
                id={id}
                value={form.type}
                onChange={(e) => {
                  const parsed = GlobalParamTypeSchema.safeParse(e.target.value);
                  if (parsed.success) onChange({ ...form, type: parsed.data });
                }}
                required
              >
                {GlobalParamTypeSchema.options.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            )
          }
        </LabelledControl>
        {editing && (
          <p className="page-hint">
            A name and type are fixed once created. To change either, delete this global and create
            it again.
          </p>
        )}
      </FormSection>

      <FormSection title="Value">
        {/* Not `required`: empty text is a real value for a string global. */}
        <label>
          Value
          <input
            type="text"
            value={form.valueText}
            onChange={(e) => onChange({ ...form, valueText: e.target.value })}
            placeholder={VALUE_PLACEHOLDER[form.type]}
            spellCheck={false}
          />
        </label>
        <p className="page-hint">Cleartext — never a credential.</p>
        <label>
          Description
          <input
            type="text"
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
          />
        </label>
      </FormSection>
    </FormDrawer>
  );
}
