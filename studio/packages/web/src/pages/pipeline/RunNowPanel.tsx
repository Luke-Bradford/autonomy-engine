import { VALUE_TYPE_TITLES } from '@autonomy-studio/shared';
import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type {
  DebugRunRequest,
  DebugRunResult,
  FireResult,
  Param,
  PipelineVersion,
} from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { debugPipelineDraft, runPipelineVersion } from '../../api/pipelines';
import { LabelledControl } from '../../lib/LabelledControl';
import { JsonEditor } from '../../lib/form/JsonEditor';
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
  return (
    <RunParamsForm
      heading={`Run v${String(version.version)}`}
      params={version.params}
      note={
        dirty
          ? `This runs the saved v${String(version.version)}. Your unsaved edits are not included.`
          : undefined
      }
      start={(params) => runPipelineVersion(pipelineId, { pipelineVersionId: version.id, params })}
      onStarted={(result) => onStarted(result.runId)}
      onClose={onClose}
    />
  );
}

/**
 * #1395 OR4 slice 3 — the editor's Debug form: the same form as Run, over the
 * DRAFT's params, starting a run of what is on the canvas now
 * (`debugPipelineDraft`). `draft` is read at Start, not at open, so the run is of
 * the canvas as it stands when the button is pressed.
 */
export function DebugRunPanel({
  pipelineId,
  params,
  draft,
  onStarted,
  onClose,
}: {
  pipelineId: string;
  params: readonly Param[];
  draft: () => DebugRunRequest['version'];
  onStarted: (result: DebugRunResult & { runId: string; pipelineVersion: PipelineVersion }) => void;
  onClose: () => void;
}) {
  return (
    <RunParamsForm
      heading="Debug the draft"
      params={params}
      note="This runs what is on the canvas now, saved or not. It is not added to the versions."
      start={(values) => debugPipelineDraft(pipelineId, { version: draft(), params: values })}
      onStarted={(result) => {
        // The server sends the version iff the run started; its absence here
        // would be a broken response, not a run to overlay.
        if (result.pipelineVersion === undefined) {
          throw new Error('the debug run started without its version');
        }
        onStarted({ ...result, pipelineVersion: result.pipelineVersion });
      }}
      onClose={onClose}
    />
  );
}

/**
 * The form Run and Debug share: one row per param, prefilled from its default,
 * turned into typed values by `buildRunNowParams`, then `start`ed. A `started`
 * result is handed up; anything else is said in the form.
 */
function RunParamsForm<R extends FireResult>({
  heading,
  params,
  note,
  start,
  onStarted,
  onClose,
}: {
  heading: string;
  params: readonly Param[];
  note: string | undefined;
  start: (params: Record<string, unknown>) => Promise<R>;
  onStarted: (result: R & { runId: string }) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState(() => runNowRows(params));
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // A ref, not `starting`: two submits in one tick (Enter held, a double click)
  // both read the same stale state, and each would start a run.
  const inFlight = useRef(false);

  async function onStart(e: FormEvent) {
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
      {note !== undefined && <p className="page-hint">{note}</p>}
      {params.length === 0 ? (
        <p className="page-hint">This pipeline takes no parameters.</p>
      ) : (
        <>
          <p className="page-hint">Leave a value blank to use its default.</p>
          {params.map((p, i) => (
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
                    {VALUE_TYPE_TITLES[p.type]}
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
        <button type="submit" disabled={starting} autoFocus={params.length === 0}>
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
      <JsonEditor {...common} label={param.name} rows={3} value={value} onValueChange={onChange} />
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
