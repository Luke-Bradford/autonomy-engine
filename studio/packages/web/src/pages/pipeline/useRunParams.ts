import { useRef, useState, type FormEvent } from 'react';
import type { FireResult, Param } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { buildRunNowParams } from './runNowRules';

/**
 * The state behind the Run form, shared by the editor's Run and Debug panels
 * and the pipelines grid's Trigger now drawer (#1569): one row per param,
 * prefilled from its default, turned into typed values by `buildRunNowParams`,
 * then `start`ed. A `started` result is handed up; anything else is kept in
 * `error` for the form to say.
 */
export function useRunParams<R extends FireResult>({
  params,
  rows,
  onRowsChange,
  start,
  onStarted,
}: {
  params: readonly Param[];
  /** The typed values, by param name — held by the caller, so a page can tell
   * typed input from the defaults (`runNowRows`) for its unsaved-changes guard. */
  rows: Readonly<Record<string, string>>;
  onRowsChange: (next: Record<string, string>) => void;
  start: (params: Record<string, unknown>) => Promise<R>;
  onStarted: (result: R & { runId: string }) => void;
}): {
  set: (name: string, value: string) => void;
  error: string | null;
  starting: boolean;
  submit: (e: FormEvent) => Promise<void>;
} {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // A ref, not `starting`: two submits in one tick (Enter held, a double click)
  // both read the same stale state, and each would start a run.
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const built = buildRunNowParams(rows, params);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    inFlight.current = true;
    setStarting(true);
    try {
      const result = await start(built.value);
      if (result.outcome === 'started' && result.runId !== undefined) {
        onStarted({ ...result, runId: result.runId });
        return;
      }
      setError(`The run did not start: ${result.reason ?? result.outcome}.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }

  const set = (name: string, value: string) => onRowsChange({ ...rows, [name]: value });
  return { set, error, starting, submit };
}
