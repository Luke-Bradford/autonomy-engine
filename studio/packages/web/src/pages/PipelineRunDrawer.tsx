import { useEffect, useState, type RefObject } from 'react';
import type { PipelineVersion } from '@autonomy-studio/shared';
import { messageOf } from '../api/client';
import { latestVersion, listPipelineVersions, runPipelineVersion } from '../api/pipelines';
import { FormDrawer } from '../lib/form/FormDrawer';
import type { UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { RunParamsFields } from './pipeline/RunNowPanel';
import { useRunParams } from './pipeline/useRunParams';
import type { PipelineRunForm } from './pipelineRunForm';
import { runDisabledReason, runNowRows } from './pipeline/runNowRules';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; version: PipelineVersion | null }
  | { status: 'error'; message: string };

/**
 * #1569 OR37 — the pipelines grid's ⋯ → Trigger now, in the page's drawer: the
 * editor's Run form (#1395) over the pipeline's LATEST saved version, read when
 * the drawer opens and named in it, so what starts is what it says. A trigger-
 * less run of exactly that version (`runPipelineVersion`), the editor's own.
 */
export function PipelineRunDrawer({
  form,
  onChange,
  guard,
  returnFocusTo,
  onClose,
  onStarted,
  onBusyChange,
}: {
  form: PipelineRunForm;
  onChange: (next: PipelineRunForm) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onStarted: (started: { runId: string; version: number }) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const { pipelineId } = form;
  useEffect(() => {
    const ctrl = new AbortController();
    listPipelineVersions(pipelineId, ctrl.signal).then(
      (versions) => {
        if (ctrl.signal.aborted) return;
        const version = latestVersion(versions);
        setLoad({ status: 'ready', version });
        const seeded = runNowRows(version?.params ?? []);
        onChange({ ...form, rows: seeded, defaults: seeded });
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setLoad({ status: 'error', message: messageOf(err) });
      },
    );
    return () => ctrl.abort();
    // Read once per pipeline and per Retry; `form`/`onChange` are this open's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, attempt]);

  const version = load.status === 'ready' ? load.version : null;
  const reason =
    load.status === 'ready'
      ? runDisabledReason({
          ready: true,
          archived: false,
          headVersion: version?.version ?? null,
          previewing: false,
        })
      : null;
  const { set, error, starting, submit } = useRunParams({
    params: version?.params ?? [],
    rows: form.rows,
    onRowsChange: (rows) => onChange({ ...form, rows }),
    start: (params) => {
      if (version === null) return Promise.reject(new Error('No saved version to run.'));
      return runPipelineVersion(pipelineId, { pipelineVersionId: version.id, params });
    },
    onStarted: (result) => {
      if (version !== null) onStarted({ runId: result.runId, version: version.version });
    },
  });
  useEffect(() => {
    onBusyChange(starting);
    return () => onBusyChange(false);
  }, [starting, onBusyChange]);

  return (
    <FormDrawer
      title={`Trigger now — ${form.name}`}
      formLabel={`Trigger ${form.name} now`}
      className="connection-form"
      guard={guard}
      onRequestClose={onClose}
      onSubmit={(e) => {
        if (version === null) e.preventDefault();
        else void submit(e);
      }}
      busy={starting}
      returnFocusTo={returnFocusTo}
      status={
        error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )
      }
      actions={
        <>
          <button type="button" onClick={onClose} disabled={starting}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={starting || version === null}
            autoFocus={version !== null && version.params.length === 0}
          >
            {starting ? 'Starting…' : 'Start run'}
          </button>
        </>
      }
    >
      {load.status === 'loading' && <p className="page-hint">Loading the latest version…</p>}
      {load.status === 'error' && (
        <>
          <p className="form-error" role="alert">
            Could not read the versions: {load.message}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </>
      )}
      {reason !== null && <p className="page-hint">{reason}</p>}
      {version !== null && (
        <>
          <p className="page-hint">{`Runs v${String(version.version)}, the latest saved version.`}</p>
          <RunParamsFields params={version.params} rows={form.rows} onChange={set} autoFocus />
        </>
      )}
    </FormDrawer>
  );
}
