import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { PipelineVersion } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { listPipelineVersions } from '../../api/pipelines';

export type PipelineVersionsLoad =
  | { status: 'loading' }
  /** Newest first, by number: the server's order is its own business. */
  | { status: 'ready'; versions: PipelineVersion[] }
  | { status: 'error'; message: string };

/**
 * #1569 OR37 — a pipeline's saved versions, read once per pipeline and per
 * `retry`, for the drawers that act on one (Trigger now, Duplicate). An answer
 * for a pipeline since replaced, or for a drawer gone, is dropped (abort).
 *
 * `onLoaded` runs with each answer, from the latest render's callback.
 */
export function usePipelineVersions(
  pipelineId: string,
  onLoaded?: (versions: PipelineVersion[]) => void,
): { load: PipelineVersionsLoad; retry: () => void } {
  const [load, setLoad] = useState<PipelineVersionsLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loaded = useEffectEvent((versions: PipelineVersion[]) => onLoaded?.(versions));
  useEffect(() => {
    const ctrl = new AbortController();
    listPipelineVersions(pipelineId, ctrl.signal).then(
      (list) => {
        if (ctrl.signal.aborted) return;
        const versions = [...list].sort((a, b) => b.version - a.version);
        setLoad({ status: 'ready', versions });
        loaded(versions);
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setLoad({ status: 'error', message: messageOf(err) });
      },
    );
    return () => ctrl.abort();
  }, [pipelineId, attempt]);
  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  return { load, retry };
}
