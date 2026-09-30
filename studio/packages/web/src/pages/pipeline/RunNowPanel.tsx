import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { Param, PipelineVersion } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { runPipelineVersion } from '../../api/pipelines';
import { LabelledControl } from '../../lib/LabelledControl';
import { buildRunNowParams, runNowRows } from './runNowRules';

/**
 * #1395 OR4 — the editor's Run form: the saved version's params, prefilled with
 * their defaults, and a Start button. Starts a trigger-less run of exactly the
 * version it names (`runPipelineVersion`), then hands the new run's id up.
 *
 * Positioned over the canvas by its anchor rather than laid out in the header,
 * so opening it moves nothing (#1393). Not modal: Escape or Cancel closes it,
 * and the canvas stays usable beneath.
 */
export function RunNowPanel({
  pipelineId,
  version,
  dirty,
  onStarted,
  onClose,
}: {
  pipelineId: string;
  version: PipelineVersion;
  /** The canvas holds edits not in `version`: said in the form, not only in a tooltip. */
  dirty: boolean;
  onStarted: (runId: string) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState(() => runNowRows(version.params));
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // A ref, not `starting`: two submits in one tick (Enter held, a double click)
  // both read the same stale state, and each would start a run.
  const inFlight = useRef(false);
  const heading = `Run v${String(version.version)}`;

  async function onStart(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const built = buildRunNowParams(rows, version.params);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    inFlight.current = true;
    setStarting(true);
    try {
      const result = await runPipelineVersion(pipelineId, {
        pipelineVersionId: version.id,
        params: built.value,
      });
      if (result.outcome === 'started' && result.runId !== undefined) {
        onStarted(result.runId);
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  const set = (name: string, value: string) => setRows((r) => ({ ...r, [name]: value }));

  return (
    <form
      className="run-now-panel"
      role="dialog"
      aria-label={heading}
      onSubmit={(e) => void onStart(e)}
      onKeyDown={onKeyDown}
    >
      <h3>{heading}</h3>
      {dirty && (
        <p className="page-hint">
          This runs the saved v{String(version.version)}. Your unsaved edits are not included.
        </p>
      )}
      {version.params.length === 0 ? (
        <p className="page-hint">This pipeline takes no parameters.</p>
      ) : (
        <>
          <p className="page-hint">Leave a value blank to use its default.</p>
          {version.params.map((p, i) => (
            <LabelledControl key={p.name} label={p.name}>
              {(id) => (
                <>
                  <ParamValueInput
                    id={id}
                    param={p}
                    value={rows[p.name] ?? ''}
                    onChange={(v) => set(p.name, v)}
                    autoFocus={i === 0}
                  />
                  <span id={`${id}-hint`} className="page-hint">
                    {p.type}
                    {p.required ? ' · required' : ''}
                    {p.description !== undefined && p.description !== ''
                      ? ` — ${p.description}`
                      : ''}
                  </span>
                </>
              )}
            </LabelledControl>
          ))}
        </>
      )}
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" disabled={starting} autoFocus={version.params.length === 0}>
          {starting ? 'Starting…' : 'Start run'}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One param's value, in the control its type reads best in. */
function ParamValueInput({
  id,
  param,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  param: Param;
  value: string;
  onChange: (value: string) => void;
  autoFocus: boolean;
}) {
  const common = { id, 'aria-describedby': `${id}-hint`, autoFocus };
  if (param.type === 'boolean') {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(default)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (param.type === 'json') {
    return (
      <textarea {...common} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <input
      {...common}
      type="text"
      inputMode={param.type === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
