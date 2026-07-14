import { useCallback, useEffect, useState } from 'react';
import {
  ConcurrencyPolicySchema,
  TriggerModeSchema,
  type ConcurrencyPolicy,
  type TriggerMode,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { ApiError } from '../api/client';
import { listPipelines, listPipelineVersions } from '../api/pipelines';
import {
  createTrigger,
  deleteTrigger,
  fireTrigger,
  listTriggers,
  provisionWebhookSecret,
  updateTrigger,
  TriggerWriteSchema,
  type TriggerWrite,
} from '../api/triggers';

const MODES = TriggerModeSchema.options;
const POLICIES = ConcurrencyPolicySchema.options;

/** A `pipelineVersionId` → human label, so a trigger's binding reads as
 * "Pipeline name v3" instead of an opaque id. Built once when the page loads. */
interface BindingOption {
  value: string; // pipelineVersionId
  label: string; // `${pipeline.name} v${version}`
}

type FormState = {
  id: string | null; // null = creating, otherwise editing this trigger
  name: string;
  pipelineVersionId: string; // '' = unbound (maps to null)
  mode: TriggerMode;
  schedule: string; // cron; '' = null
  concurrencyPolicy: ConcurrencyPolicy;
  concurrencyMax: string; // only meaningful for `parallel`; '' = unset
  enabled: boolean;
  paramsText: string; // JSON object
  runWindowsText: string; // JSON array; '' = null
};

function blankForm(): FormState {
  return {
    id: null,
    name: '',
    pipelineVersionId: '',
    mode: 'manual',
    schedule: '',
    concurrencyPolicy: 'skip_if_running',
    concurrencyMax: '',
    enabled: false,
    paramsText: '{}',
    runWindowsText: '',
  };
}

function formForEdit(t: TriggerPublic): FormState {
  return {
    id: t.id,
    name: t.name,
    pipelineVersionId: t.pipelineVersionId ?? '',
    mode: t.mode,
    schedule: t.schedule ?? '',
    concurrencyPolicy: t.concurrency.policy,
    concurrencyMax: t.concurrency.max !== undefined ? String(t.concurrency.max) : '',
    enabled: t.enabled,
    paramsText: JSON.stringify(t.params, null, 2),
    runWindowsText: t.runWindows === null ? '' : JSON.stringify(t.runWindows, null, 2),
  };
}

/**
 * Triggers page: the third MVP-bar step ("create a trigger and fire it"). Full
 * CRUD over `/api/triggers`, plus a manual "Fire now" and, for a webhook
 * trigger, one-time secret provisioning. A trigger binds ONE immutable pipeline
 * version (or is deliberately unbound); an ENABLED trigger must be bound (the
 * server refuses otherwise — mirrored here for a friendlier message).
 */
export function TriggersPage() {
  const [triggers, setTriggers] = useState<TriggerPublic[] | null>(null);
  const [bindings, setBindings] = useState<BindingOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [webhookSecret, setWebhookSecret] = useState<{
    triggerName: string;
    secret: string;
    deliveryUrl: string;
  } | null>(null);

  // Load every pipeline's versions once, flattened into binding options. N+1
  // requests (one per pipeline) is acceptable at MVP scale; the canvas (P5c)
  // will own richer pipeline browsing.
  const loadBindings = useCallback(async (signal?: AbortSignal): Promise<BindingOption[]> => {
    const pipelines = await listPipelines(signal);
    const perPipeline = await Promise.all(
      pipelines.map(async (p) => {
        const versions = await listPipelineVersions(p.id, signal);
        return versions.map((v) => ({ value: v.id, label: `${p.name} v${v.version}` }));
      }),
    );
    return perPipeline.flat();
  }, []);

  // Refetch after a mutation. Catches internally (rather than relying on a
  // caller's try/catch) so a refresh failure after e.g. a create — where the
  // form has already unmounted — still surfaces as `loadError` instead of being
  // swallowed by the gone form's handler.
  const refresh = useCallback(async () => {
    try {
      const list = await listTriggers();
      setTriggers(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([listTriggers(controller.signal), loadBindings(controller.signal)])
      .then(([list, opts]) => {
        setTriggers(list);
        setBindings(opts);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [loadBindings]);

  const labelFor = useCallback(
    (versionId: string | null): string => {
      if (versionId === null) return 'unbound';
      return bindings.find((b) => b.value === versionId)?.label ?? versionId;
    },
    [bindings],
  );

  const onDelete = useCallback(
    async (t: TriggerPublic) => {
      if (!window.confirm(`Delete trigger "${t.name}"?`)) return;
      try {
        await deleteTrigger(t.id);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const onFire = useCallback(async (t: TriggerPublic) => {
    setActionMsg(null);
    try {
      const result = await fireTrigger(t.id);
      const detail =
        result.outcome === 'started'
          ? `started (run ${result.runId ?? '?'})`
          : result.outcome === 'skipped'
            ? `skipped — ${result.reason ?? 'no reason given'}`
            : 'queued';
      setActionMsg(`Fired "${t.name}": ${detail}.`);
    } catch (err) {
      setActionMsg(
        `Fire failed for "${t.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  const onProvisionSecret = useCallback(async (t: TriggerPublic) => {
    setActionMsg(null);
    setWebhookSecret(null);
    try {
      const result = await provisionWebhookSecret(t.id);
      setWebhookSecret({
        triggerName: t.name,
        secret: result.secret,
        deliveryUrl: result.deliveryUrl,
      });
    } catch (err) {
      setActionMsg(
        `Could not provision a webhook secret for "${t.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  return (
    <section aria-labelledby="triggers-heading">
      <div className="page-header">
        <h2 id="triggers-heading">Triggers</h2>
        <button type="button" onClick={() => setForm(blankForm())}>
          New trigger
        </button>
      </div>

      <p className="page-hint">
        A trigger binds one pipeline version to a firing mode (manual, schedule, webhook…) and a
        concurrency policy. Fire it now, or enable it to fire automatically. An enabled trigger must
        be bound to a pipeline version.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {actionMsg && (
        <p role="status" className="notice">
          {actionMsg}
        </p>
      )}

      {webhookSecret && (
        <div role="status" className="secret-reveal">
          <p>
            Webhook secret for <strong>{webhookSecret.triggerName}</strong> — copy it now, it is
            shown only once:
          </p>
          <p>
            <code>{webhookSecret.secret}</code>
          </p>
          <p>
            Sign deliveries to <code>{webhookSecret.deliveryUrl}</code>.
          </p>
          <button type="button" onClick={() => setWebhookSecret(null)}>
            Dismiss
          </button>
        </div>
      )}

      {triggers === null && !loadError && <p>Loading triggers…</p>}

      {triggers !== null && triggers.length === 0 && (
        <p>No triggers yet. Create one to bind a pipeline version and fire it.</p>
      )}

      {triggers !== null && triggers.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Mode</th>
              <th scope="col">Bound to</th>
              <th scope="col">Enabled</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {triggers.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>{t.mode}</code>
                </td>
                <td>{labelFor(t.pipelineVersionId)}</td>
                <td>{t.enabled ? 'yes' : 'no'}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => void onFire(t)}
                    aria-label={`Fire ${t.name} now`}
                  >
                    Fire now
                  </button>
                  <button type="button" onClick={() => setForm(formForEdit(t))}>
                    Edit
                  </button>
                  {t.mode === 'webhook' && (
                    <button
                      type="button"
                      onClick={() => void onProvisionSecret(t)}
                      aria-label={`Provision webhook secret for ${t.name}`}
                    >
                      Webhook secret
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onDelete(t)}
                    aria-label={`Delete ${t.name}`}
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
        <TriggerForm
          form={form}
          bindings={bindings}
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

function TriggerForm({
  form,
  bindings,
  onChange,
  onClose,
  onSaved,
}: {
  form: FormState;
  bindings: BindingOption[];
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

    // params must be a JSON object (`params` is a record).
    let params: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(form.paramsText.trim() === '' ? '{}' : form.paramsText);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('params must be a JSON object');
      }
      params = raw as Record<string, unknown>;
    } catch (err) {
      setError(`Invalid params JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // runWindows is an optional JSON array; blank = null (no windows). Shape is
    // validated by the shared schema below.
    let runWindows: unknown = null;
    if (form.runWindowsText.trim() !== '') {
      try {
        runWindows = JSON.parse(form.runWindowsText);
      } catch (err) {
        setError(`Invalid run windows JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const pipelineVersionId = form.pipelineVersionId === '' ? null : form.pipelineVersionId;

    // Mirror the server's `assertBindableIfEnabled` for a friendlier message
    // (the server still enforces it).
    if (form.enabled && pipelineVersionId === null) {
      setError('An enabled trigger must be bound to a pipeline version (or disable it).');
      return;
    }

    // Concurrency cross-field rule lives in the shared `ConcurrencyWriteSchema`:
    // `parallel` requires a positive `max`; the single-slot policies forbid it.
    const concurrency =
      form.concurrencyPolicy === 'parallel'
        ? { policy: 'parallel' as const, max: Number(form.concurrencyMax) }
        : { policy: form.concurrencyPolicy };

    const fullBody: TriggerWrite = {
      name: form.name,
      pipelineVersionId,
      params,
      mode: form.mode,
      // A cron only makes sense for a schedule trigger; null it out otherwise so
      // switching modes never leaves a stale schedule behind.
      schedule:
        form.mode === 'schedule' && form.schedule.trim() !== '' ? form.schedule.trim() : null,
      webhook: null,
      concurrency,
      runWindows: runWindows as TriggerWrite['runWindows'],
      enabled: form.enabled,
    };

    const parsed = TriggerWriteSchema.safeParse(fullBody);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }

    setSaving(true);
    try {
      if (editing && form.id) {
        // Omit `webhook` on edit so an already-provisioned secret is preserved
        // (PATCH is partial; sending `webhook:null` would clear it).
        const { webhook: _webhook, ...patch } = parsed.data;
        void _webhook;
        await updateTrigger(form.id, patch);
      } else {
        await createTrigger(parsed.data);
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <form className="trigger-form" onSubmit={onSubmit} aria-label="Trigger form">
      <h3>{editing ? 'Edit trigger' : 'New trigger'}</h3>

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
        Pipeline version
        <select
          value={form.pipelineVersionId}
          onChange={(e) => onChange({ ...form, pipelineVersionId: e.target.value })}
        >
          <option value="">— unbound —</option>
          {bindings.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Mode
        <select
          value={form.mode}
          onChange={(e) => onChange({ ...form, mode: e.target.value as TriggerMode })}
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </label>

      {form.mode === 'schedule' && (
        <label>
          Schedule (cron)
          <input
            type="text"
            value={form.schedule}
            onChange={(e) => onChange({ ...form, schedule: e.target.value })}
            placeholder="0 2 * * *"
            spellCheck={false}
          />
        </label>
      )}

      {form.mode === 'webhook' && (
        <p className="page-hint">
          Save the trigger, then use “Webhook secret” on its row to mint the signing secret.
        </p>
      )}

      <label>
        Concurrency
        <select
          value={form.concurrencyPolicy}
          onChange={(e) =>
            onChange({ ...form, concurrencyPolicy: e.target.value as ConcurrencyPolicy })
          }
        >
          {POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {policy}
            </option>
          ))}
        </select>
      </label>

      {form.concurrencyPolicy === 'parallel' && (
        <label>
          Max parallel runs
          <input
            type="number"
            min={1}
            value={form.concurrencyMax}
            onChange={(e) => onChange({ ...form, concurrencyMax: e.target.value })}
            required
          />
        </label>
      )}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
        />
        Enabled (fires automatically per its mode)
      </label>

      <label>
        Params (JSON)
        <textarea
          value={form.paramsText}
          onChange={(e) => onChange({ ...form, paramsText: e.target.value })}
          rows={4}
          spellCheck={false}
        />
      </label>

      <label>
        Run windows (JSON, optional)
        <textarea
          value={form.runWindowsText}
          onChange={(e) => onChange({ ...form, runWindowsText: e.target.value })}
          rows={3}
          spellCheck={false}
          placeholder='[{"start":"22:00","end":"02:00"}]'
        />
      </label>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create trigger'}
        </button>
        <button type="button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
