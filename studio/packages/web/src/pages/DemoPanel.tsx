import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { DemoStatus } from '@autonomy-studio/shared';
import { getDemoStatus, loadDemo, removeDemo } from '../api/demo';
import { messageOf } from '../api/client';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { useConfirm } from '../lib/confirm/useConfirm';

/** The question Remove asks, then everything it takes — the route's own scope. */
export const REMOVE_DEMO_QUESTION =
  'Remove the demo?\n\n' +
  'This deletes the five "Demo" pipelines and all of their runs, the demo\'s triggers, ' +
  'connections and datasets, and its sample files and warehouse. Your own pipelines are not touched.';

/**
 * #1481 OR32 — load the demo ETL pack, or remove it.
 *
 * Which button shows is the SERVER's answer (`GET /api/demo`), not a guess from
 * the pipeline list: a part-removed or archived demo has no visible "Demo" row
 * yet still makes a load refuse, and Remove is the way out of that state. A
 * failed status read is reported as a failure, never drawn as "not loaded".
 *
 * `allowRemove={false}` is Home's form: an offer to load, and a link to the
 * pipelines once loaded, but no destructive act on the landing page.
 */
export function DemoPanel({
  onChanged,
  allowRemove = true,
  embedded = false,
  onBusyChange,
}: {
  /**
   * Called after a successful load or remove, e.g. to refresh a list. Must not
   * reject — a failure of its own is the caller's to report, as
   * `pipelinesStore.refresh` (which never rejects) does in its list state.
   */
  onChanged?: () => void | Promise<void>;
  allowRemove?: boolean;
  /**
   * #1569 — inside a drawer, which supplies the frame, the heading and the
   * account of what the demo is: only the state, the buttons and the outcome.
   */
  embedded?: boolean;
  /**
   * Told when a load or remove starts and ends — its question included, so a
   * drawer holds Close (and the Escape that answers the question) meanwhile.
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const guardedLoad = useGuardedLoad();
  const { active, run } = useBusyAction();
  // `undefined` = not answered yet; the buttons wait for an answer, so no act
  // can start against a status that is still in flight.
  const [status, setStatus] = useState<DemoStatus | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // What is in flight, said out loud: a load writes files and a warehouse.
  const [acting, setActing] = useState<string | null>(null);

  const readStatus = useCallback(() => {
    void guardedLoad(getDemoStatus, {
      onData: setStatus,
      onError: (err) => setReadError(messageOf(err)),
    });
  }, [guardedLoad]);
  useEffect(readStatus, [readStatus]);

  const busy = active.size > 0;
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  const onLoad = () =>
    void run('demo', async () => {
      setActionError(null);
      setActing('Loading the demo…');
      try {
        await loadDemo();
      } catch (err) {
        setActionError(messageOf(err));
        return;
      } finally {
        setActing(null);
      }
      setStatus({ loaded: true });
      // Outside the catch: the load happened, whatever the refresh after it does.
      await onChanged?.();
    });

  const onRemove = () =>
    void run('demo', async () => {
      const confirmed = await confirm({
        message: REMOVE_DEMO_QUESTION,
        confirmLabel: 'Remove demo',
      });
      if (!confirmed) return;
      setActionError(null);
      setActing('Removing the demo…');
      try {
        await removeDemo();
      } catch (err) {
        setActionError(messageOf(err));
        return;
      } finally {
        setActing(null);
      }
      setStatus({ loaded: false });
      await onChanged?.();
    });

  return (
    <section
      aria-labelledby={embedded ? undefined : 'demo-workspace'}
      className={embedded ? 'demo-panel' : 'home-section'}
    >
      {!embedded && <h3 id="demo-workspace">Demo workspace</h3>}
      {readError !== null && (
        <>
          <p role="alert" className="error">
            Could not check for the demo: {readError}
          </p>
          <button
            type="button"
            onClick={() => {
              setReadError(null);
              readStatus();
            }}
          >
            Retry
          </button>
        </>
      )}
      {status?.loaded === false && (
        <>
          {!embedded && (
            <p className="page-hint">
              Five sample pipelines in folder “Demo” that load a messy orders CSV into a SQLite
              warehouse, clean and aggregate it, run it all from an orchestrator, and fail once on
              purpose — with their own connections and datasets, ready to run and watch in Monitor.
            </p>
          )}
          <button type="button" className="primary" onClick={onLoad} disabled={busy}>
            Load demo
          </button>
        </>
      )}
      {status?.loaded === true &&
        (allowRemove ? (
          <>
            <p className="page-hint">The demo is loaded: its pipelines are in folder “Demo”.</p>
            <button type="button" className="danger" onClick={onRemove} disabled={busy}>
              Remove demo
            </button>
          </>
        ) : (
          <p className="page-hint">
            The demo is loaded. <Link to="/author/pipelines">Open the demo pipelines</Link>
          </p>
        ))}
      {acting !== null && (
        <p className="notice" role="status">
          {acting}
        </p>
      )}
      {actionError !== null && (
        <p role="alert" className="error">
          {actionError}
        </p>
      )}
      {confirmDialog}
    </section>
  );
}
