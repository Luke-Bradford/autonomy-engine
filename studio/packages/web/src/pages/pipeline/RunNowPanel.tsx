import { VALUE_TYPE_TITLES } from '@autonomy-studio/shared';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  DebugRunRequest,
  DebugRunResult,
  FireResult,
  Param,
  PipelineVersion,
} from '@autonomy-studio/shared';
import { debugPipelineDraft, runPipelineVersion } from '../../api/pipelines';
import { LabelledControl } from '../../lib/LabelledControl';
import { JsonEditor } from '../../lib/form/JsonEditor';
import { runNowRows } from './runNowRules';
import { useRunParams } from './useRunParams';

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

/** One labelled control per param, with its type, `required` and description. */
export function RunParamsFields({
  params,
  rows,
  onChange,
}: {
  params: readonly Param[];
  rows: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
}) {
  if (params.length === 0) return <p className="page-hint">This pipeline takes no parameters.</p>;
  return (
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
                onChange={(v) => onChange(p.name, v)}
                // The fields mount once their version is known, so the first
                // one is where typing goes, in the panel and in a drawer.
                autoFocus={i === 0}
              />
              <span id={`${id}-hint`} className="page-hint">
                {VALUE_TYPE_TITLES[p.type]}
                {p.required ? ' · required' : ''}
                {p.description !== undefined && p.description !== '' ? ` — ${p.description}` : ''}
              </span>
            </>
          )}
        </LabelledControl>
      ))}
    </>
  );
}

/** The floating form Run and Debug share, over `useRunParams`. */
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
  const { set, error, starting, submit } = useRunParams({
    params,
    rows,
    onRowsChange: setRows,
    start,
    onStarted,
  });

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  return (
    <form
      className="run-now-panel"
      role="dialog"
      aria-label={heading}
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
    >
      <h3>{heading}</h3>
      {note !== undefined && <p className="page-hint">{note}</p>}
      <RunParamsFields params={params} rows={rows} onChange={set} />
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
