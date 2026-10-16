import { useEffect, useRef, useState } from 'react';
import type { DatasetPreviewResult, InlineDataset } from '@autonomy-studio/shared';
import { previewDatasetSource } from '../../api/datasets';
import { LabelledControl } from '../../lib/LabelledControl';
import { formatOutputValue } from '../runs/format';
import { dynamicBindNames, previewInline } from './inlineSource';

type Shown =
  | { readonly key: string; readonly loading: true; readonly request: AbortController }
  | { readonly key: string; readonly loading: false; readonly result: DatasetPreviewResult };

/**
 * #1600 C1q-c — Preview data for a Copy or Lookup's inline Table or Query: the
 * first rows the run's own read would see (`POST /api/datasets/preview`).
 *
 * A bind value written as `${}` has no value until a run resolves it, so Preview
 * asks for one in its place, as ADF asks for parameter values before a preview.
 * A result belongs to the exact source, connection and values it was read for:
 * change any of them and it is cleared and its request aborted, so a table on
 * screen never describes a statement that is no longer there.
 */
export function SourcePreview({
  inline,
  connectionId,
  connectionParams,
}: {
  inline: InlineDataset;
  /** `undefined` when the source connection is not a saved one (unset, or a `${}`). */
  connectionId: string | undefined;
  /** The node binds connection parameters, which Preview does not apply. */
  connectionParams: boolean;
}) {
  const dynamic = dynamicBindNames(inline);
  const [values, setValues] = useState<Record<string, string>>({});
  const sent = previewInline(inline, values);
  const key = JSON.stringify([connectionId, sent]);
  const [shown, setShown] = useState<Shown | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    inFlight.current?.abort();
  }, [key]);
  useEffect(() => () => inFlight.current?.abort(), []);

  const run = () => {
    if (connectionId === undefined) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setShown({ key, loading: true, request: controller });
    previewDatasetSource(
      { connectionId, source: { from: 'inline', inline: sent } },
      controller.signal,
    ).then(
      (result) => {
        if (!controller.signal.aborted) setShown({ key, loading: false, result });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const error = err instanceof Error && err.message !== '' ? err.message : String(err);
        setShown({ key, loading: false, result: { ok: false, error } });
      },
    );
  };

  // A request aborted by an edit never answers, so its loading entry must not
  // come back when the edit is undone and the key matches it again.
  const current =
    shown !== null && shown.key === key && !(shown.loading && shown.request.signal.aborted)
      ? shown
      : null;
  return (
    <>
      {dynamic.map((name) => (
        <LabelledControl key={name} label={`Preview value for :${name}`}>
          {(id, describedBy) => (
            <input
              id={id}
              aria-describedby={describedBy}
              data-size="m"
              spellCheck={false}
              value={values[name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            />
          )}
        </LabelledControl>
      ))}
      <div className="source-preview-actions">
        <button
          type="button"
          onClick={run}
          disabled={connectionId === undefined || current?.loading === true}
        >
          {current?.loading === true ? 'Reading…' : 'Preview data'}
        </button>
        {connectionId === undefined && (
          <span className="page-hint">Pick a saved source connection to preview</span>
        )}
      </div>
      {connectionParams && (
        <p className="contract-advisory" role="status">
          Preview reads the connection as saved: this node’s connection parameters are not applied.
        </p>
      )}
      {current !== null && !current.loading && <PreviewResult result={current.result} />}
    </>
  );
}

function PreviewResult({ result }: { result: DatasetPreviewResult }) {
  if (!result.ok) {
    return (
      <p role="status" className="probe-failed">
        {result.error}
      </p>
    );
  }
  const { rows } = result;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const caption =
    result.note ??
    (rows.length === 0
      ? 'No rows'
      : result.truncated
        ? `First ${rows.length} rows`
        : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`);
  return (
    <>
      <p role="status" className="page-hint">
        {caption}
      </p>
      {rows.length > 0 && (
        <div className="source-preview-rows">
          <table aria-label="Preview rows">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>{cell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** A SQL NULL reads as one, never as an empty string; a long value is cut and says so. */
function cell(value: unknown) {
  if (value === null || value === undefined) return <span className="preview-null">NULL</span>;
  return formatOutputValue(value);
}
