import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import type { PipelineVersion } from '@autonomy-studio/shared';
import { messageOf } from '../api/client';
import { latestVersion, listPipelineVersions, runPipelineVersion } from '../api/pipelines';
import { FormDrawer } from '../lib/form/FormDrawer';
import type { UnsavedChangesGuard } from '../lib/form/useDrawerForm';
import { RunParamsFields } from './pipeline/RunNowPanel';
import { useRunParams } from './pipeline/useRunParams';
import type { PipelineRunForm } from './pipelineRunForm';
import { runDetailPath } from './runs/runPath';
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
 *
 * It stays open once a run starts and says so in its footer, with a link to
 * the run: the grid beside it does not move, and Start can be pressed again.
 */
export function PipelineRunDrawer({
  form,
  update,
  guard,
  returnFocusTo,
  onClose,
  onStarted,
  onBusyChange,
}: {
  form: PipelineRunForm;
  /** An updater, applied to the form as it is when it lands: a start or a load
   * answering after an await must not write back the form it began with. */
  update: (fn: (prev: PipelineRunForm) => PipelineRunForm) => void;
  guard: UnsavedChangesGuard;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onStarted: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [started, setStarted] = useState<{ runId: string; version: number } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // Opened from a menu item that is gone by now, and with no field until the
  // version is read: Cancel holds focus (and so Escape) meanwhile.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const { pipelineId } = form;
  useEffect(() => {
    const ctrl = new AbortController();
    listPipelineVersions(pipelineId, ctrl.signal).then(
      (versions) => {
        if (ctrl.signal.aborted) return;
        const version = latestVersion(versions);
        setLoad({ status: 'ready', version });
        const seeded = runNowRows(version?.params ?? []);
        update((prev) => ({ ...prev, rows: seeded, defaults: seeded }));
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setLoad({ status: 'error', message: messageOf(err) });
      },
    );
    return () => ctrl.abort();
    // Read once per pipeline and per Retry; `update` is this open's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, attempt]);

  const version = load.status === 'ready' ? load.version : null;
  // With params, the first one takes focus as it mounts; without, Start does.
  useEffect(() => {
    if (load.status === 'error') retryRef.current?.focus();
    else if (version !== null && version.params.length === 0) startRef.current?.focus();
  }, [load.status, version]);
  const reason =
    load.status === 'ready'
      ? runDisabledReason({
          ready: true,
          archived: false,
          headVersion: version?.version ?? null,
          previewing: false,
        })
      : null;
  // The values the start in flight was given: once it lands they are used, and
  // only what was typed since is unsaved.
  const submitted = useRef(form.rows);
  const { set, error, starting, submit } = useRunParams({
    params: version?.params ?? [],
    rows: form.rows,
    onRowsChange: (fn) => update((prev) => ({ ...prev, rows: fn(prev.rows) })),
    start: (params) => {
      if (version === null) return Promise.reject(new Error('No saved version to run.'));
      setStarted(null);
      submitted.current = form.rows;
      return runPipelineVersion(pipelineId, { pipelineVersionId: version.id, params });
    },
    onStarted: (result) => {
      if (version === null) return;
      setStarted({ runId: result.runId, version: version.version });
      const used = submitted.current;
      update((prev) => ({ ...prev, defaults: used }));
      onStarted();
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
        <>
          {error !== null && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {/* Mounted from the start, so a run started is announced as it lands. */}
          <p role="status" className="run-drawer__started">
            {started !== null && (
              <>
                {`Started v${String(started.version)} · `}
                <Link to={runDetailPath(started.runId)}>Open run</Link>
              </>
            )}
          </p>
        </>
      }
      actions={
        <>
          <button type="button" ref={cancelRef} onClick={onClose} disabled={starting}>
            {started === null ? 'Cancel' : 'Done'}
          </button>
          <button
            type="submit"
            ref={startRef}
            className="primary"
            disabled={starting || version === null}
          >
            {starting ? 'Starting…' : 'Start run'}
          </button>
        </>
      }
    >
      {load.status === 'loading' && <p className="page-hint">Loading…</p>}
      {load.status === 'error' && (
        <>
          <p className="form-error" role="alert">
            Could not read the versions: {load.message}
          </p>
          <button
            type="button"
            ref={retryRef}
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
          <p className="run-drawer__version">{`v${String(version.version)} · latest`}</p>
          <RunParamsFields params={version.params} rows={form.rows} onChange={set} />
        </>
      )}
    </FormDrawer>
  );
}
