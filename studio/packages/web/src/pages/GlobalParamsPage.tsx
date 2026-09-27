import { useCallback, useEffect, useState } from 'react';
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
  type GlobalParamUsage,
} from '@autonomy-studio/shared';
import { ApiError, messageOf } from '../api/client';
import {
  createGlobalParam,
  deleteGlobalParam,
  getGlobalParamUsage,
  listGlobalParams,
  updateGlobalParam,
} from '../api/globalParams';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { ContractRow } from './pipeline/ContractEditor';
import { coerceGlobalValue, formatDefaultInput } from './pipeline/paramRules';

/** A row not yet created: `key` is local, since there is no id until the POST. */
interface NewGlobal {
  key: number;
}

/** The row fields `ContractRow` edits. `description` absent means blank, as the shell writes it. */
interface RowFields {
  name: string;
  type: GlobalParamType;
  description?: string;
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
 * Rows are the `ContractRow` shell that params, variables and outputs already
 * share — a fourth row editor would break the third-copy rule. A saved row is
 * `locked`: name and type are immutable (GL-D1), so a rename or retype is
 * delete + create, and the row says so rather than offering an edit the route
 * would 400.
 *
 * Unlike the canvas's declarations these rows write to the SERVER, one row at
 * a time: a saved row PATCHes only what changed, a new row POSTs. Each is an
 * explicit button press — a blur-commit would turn tabbing through a row into
 * a network write.
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
  const [drafts, setDrafts] = useState<NewGlobal[]>([]);
  const [nextKey, setNextKey] = useState(0);
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

  const dropDraft = useCallback((key: number) => {
    setDrafts((current) => current.filter((d) => d.key !== key));
  }, []);

  const onDelete = useCallback(
    async (global: GlobalParam) => {
      // #844 GL3 (GL-D4) — what reads it, shown before the choice. Advisory: a
      // failed read says so and still lets the operator decide.
      let usage: GlobalParamUsage | null = null;
      try {
        usage = await getGlobalParamUsage(global.id);
      } catch {
        usage = null;
      }
      if (!window.confirm(deleteConfirmText(global.name, usage))) {
        return;
      }
      try {
        await deleteGlobalParam(global.id);
        await refresh();
      } catch (err) {
        setLoadError(`Could not delete “${global.name}”: ${messageOf(err)}`);
      }
    },
    [refresh],
  );

  const saved = globals ?? [];

  return (
    <section aria-labelledby="global-params-heading" className="global-params">
      <div className="page-header">
        <h2 id="global-params-heading">Global parameters</h2>
        <button
          type="button"
          onClick={() => {
            setDrafts((current) => [...current, { key: nextKey }]);
            setNextKey((k) => k + 1);
          }}
        >
          Add global parameter
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

      {globals === null && !loadError && <p>Loading global parameters…</p>}

      {globals !== null && saved.length === 0 && drafts.length === 0 && (
        <p>No global parameters yet.</p>
      )}

      {saved.map((global, i) => (
        // Keyed by `updatedAt` as well as `id`: a save of ANOTHER row refetches
        // the list, and this row's unsaved edits must survive that — while a
        // row that itself changed on the server must re-read what it shows.
        <GlobalRow
          key={`${global.id}:${global.updatedAt}`}
          index={i}
          saved={global}
          onDone={refresh}
          onRemove={() => void onDelete(global)}
        />
      ))}
      {drafts.map((draft, i) => (
        <GlobalRow
          key={`new:${draft.key}`}
          index={saved.length + i}
          saved={null}
          onDone={async () => {
            dropDraft(draft.key);
            await refresh();
          }}
          onRemove={() => dropDraft(draft.key)}
        />
      ))}
    </section>
  );
}

function GlobalRow({
  index,
  saved,
  onDone,
  onRemove,
}: {
  index: number;
  /** `null` for a row not yet created. */
  saved: GlobalParam | null;
  onDone: () => Promise<void>;
  onRemove: () => void;
}) {
  const storedText = saved ? formatDefaultInput(saved.value, saved.type) : '';
  const [row, setRow] = useState<RowFields>(() =>
    saved
      ? { name: saved.name, type: saved.type, description: saved.description || undefined }
      : { name: '', type: 'string' },
  );
  const [valueText, setValueText] = useState(storedText);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = index + 1;

  const description = row.description ?? '';
  const valueChanged = valueText !== storedText;
  const dirty = saved === null || valueChanged || description !== saved.description;

  async function onSubmit() {
    setError(null);
    const parsedValue = coerceGlobalValue(row.type, valueText);

    let write: () => Promise<unknown>;
    if (saved === null) {
      // A bad value short-circuits the schema below, which is where the name
      // rule lives — so name both, or fixing the value only reveals the next error.
      if (!parsedValue.ok) {
        const name = globalParamNameDefect(row.name);
        return setError(name ? `${name}; ${parsedValue.error}` : parsedValue.error);
      }
      const body = GlobalParamCreateBodySchema.safeParse({
        name: row.name,
        type: row.type,
        value: parsedValue.value,
        description,
      });
      if (!body.success) return setError(formatZodIssues(body.error.issues));
      write = () => createGlobalParam(body.data);
    } else {
      const patch: GlobalParamPatchBody = {};
      if (valueChanged) {
        if (!parsedValue.ok) return setError(parsedValue.error);
        // The STORED type, as the route checks it.
        const checked = GlobalParamValueSchema.safeParse({
          type: saved.type,
          value: parsedValue.value,
        });
        if (!checked.success) return setError(formatZodIssues(checked.error.issues));
        patch.value = parsedValue.value;
      }
      if (description !== saved.description) patch.description = description;
      write = () => updateGlobalParam(saved.id, patch);
    }

    setBusy(true);
    try {
      await write();
      await onDone();
    } catch (err) {
      // The server answers every unique violation with one generic sentence,
      // which cannot tell the operator the collision was the NAME, compared
      // without case (`COLLATE NOCASE`). This is the likeliest failure on
      // create, so name it (the SecretsPage precedent).
      setError(
        saved === null && err instanceof ApiError && err.status === 409
          ? `A global parameter named “${row.name}” already exists. Names ignore case.`
          : messageOf(err),
      );
    } finally {
      // After a success this row has usually unmounted — `onDone`'s refetch
      // changes its key, or drops the draft — so this is a no-op then, which
      // React 19 permits silently. It matters on failure, when the row stays.
      setBusy(false);
    }
  }

  return (
    // A named group, so a row can be found by the global it IS rather than by
    // its position — the list is ordered by creation, and positions shift.
    <div role="group" aria-label={saved ? `global ${saved.name}` : `new global ${n}`}>
      <ContractRow
        kind="global"
        index={index}
        row={row}
        types={GlobalParamTypeSchema.options}
        locked={saved !== null}
        removeLabel={saved ? 'Delete' : 'Remove'}
        onChange={setRow}
        onType={(raw) => {
          const parsed = GlobalParamTypeSchema.safeParse(raw);
          if (parsed.success) setRow({ ...row, type: parsed.data });
        }}
        onRemove={onRemove}
      >
        <label>
          Value
          <input
            aria-label={`global ${n} value`}
            placeholder={VALUE_PLACEHOLDER[row.type]}
            value={valueText}
            onChange={(e) => setValueText(e.target.value)}
          />
          <span className="page-hint">Cleartext — never a credential.</span>
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          aria-label={saved ? `save global ${n}` : `create global ${n}`}
          disabled={!dirty || busy}
          onClick={() => void onSubmit()}
        >
          {busy ? 'Saving…' : saved ? 'Save' : 'Create'}
        </button>
      </ContractRow>
    </div>
  );
}

/**
 * #844 GL3 (spec GL-D4) — the delete confirmation: what reads the global, and
 * what deleting it does to them. `usage` is `null` when it could not be read,
 * which is said rather than shown as "nothing reads it".
 */
export function deleteConfirmText(name: string, usage: GlobalParamUsage | null): string {
  const lines = [
    `Delete global parameter "${name}"?`,
    '',
    'Its value is lost. A global of the same name can be created again.',
    '',
  ];
  if (usage === null) {
    lines.push('Which pipelines read it could not be checked.');
  } else if (usage.pipelines.length === 0 && usage.triggers.length === 0) {
    lines.push('No pipeline’s latest version reads it, and no trigger’s pinned version does.');
  } else {
    if (usage.pipelines.length > 0) {
      lines.push('Read by the latest version of:');
      for (const p of usage.pipelines) lines.push(`  • ${p.pipelineName} (v${p.version})`);
    }
    if (usage.triggers.length > 0) {
      lines.push('Read by the version these triggers run:');
      for (const t of usage.triggers) {
        const off = t.enabled ? '' : ', disabled';
        lines.push(`  • ${t.triggerName} (${t.pipelineName} v${t.version}${off})`);
      }
    }
    lines.push(
      '',
      'A new run of a version that reads it will not start until a global of that name ' +
        'and type exists again. A rerun from failure still uses the values its source run read.',
    );
  }
  return lines.join('\n');
}
