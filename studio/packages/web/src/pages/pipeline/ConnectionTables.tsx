import { useEffect, useRef, useState } from 'react';
import type { DatasetTablesResult, InlineDataset } from '@autonomy-studio/shared';
import { listConnectionTables } from '../../api/datasets';
import { LabelledControl } from '../../lib/LabelledControl';
import type { FieldSize } from './configForm';

type Shown =
  | { readonly key: string; readonly loading: true; readonly request: AbortController }
  | { readonly key: string; readonly loading: false; readonly result: DatasetTablesResult };

type Listed = { readonly schema: string | null; readonly name: string };

const qualified = (t: Listed) => (t.schema === null ? t.name : `${t.schema}.${t.name}`);

/**
 * #1600 C1q-c — Table `[▾ from the connection]`: the tables and views the source
 * connection's store lists (`POST /api/datasets/tables`), read when the operator
 * asks, as *List sheets* is, never per keystroke. Choosing one writes its schema
 * and name together; the Schema and Table boxes stay, so a name the list does
 * not hold can still be typed.
 *
 * A list belongs to the connection it was read for: change it and the list is
 * cleared and its request aborted, SourcePreview's keyed shape.
 *
 * Not `ConfigFieldControl`'s `FieldChoices`: that offers one string per field,
 * and a table is a (schema, name) pair whose name can repeat across schemas and
 * hold a dot, so options are keyed by position instead.
 */
export function ConnectionTables({
  inline,
  connectionId,
  choose,
}: {
  inline: InlineDataset;
  /** `undefined` when the source connection is not a saved one (unset, or a `${}`). */
  connectionId: string | undefined;
  choose: (table: Listed) => void;
}) {
  const key = connectionId ?? '';
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
    listConnectionTables(connectionId, controller.signal).then(
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

  // A request aborted by a change never answers, so its loading entry must not
  // come back when the change is undone and the key matches it again.
  const current =
    shown !== null && shown.key === key && !(shown.loading && shown.request.signal.aborted)
      ? shown
      : null;
  const result = current !== null && !current.loading ? current.result : null;
  const schema = typeof inline.config['schema'] === 'string' ? inline.config['schema'] : null;
  const table = inline.config['table'];

  return (
    <>
      <div className="source-preview-actions">
        <button
          type="button"
          onClick={run}
          disabled={connectionId === undefined || current?.loading === true}
        >
          {current?.loading === true ? 'Listing…' : 'List tables'}
        </button>
      </div>
      {result !== null && !result.ok && (
        <p role="status" className="probe-failed">
          {result.error}
        </p>
      )}
      {result?.ok === true && result.tables.length === 0 && (
        <p role="status" className="page-hint">
          No tables
        </p>
      )}
      {result?.ok === true && result.tables.length > 0 && (
        <>
          <LabelledControl label="Table in this connection">
            {(id) => (
              <select
                id={id}
                data-size={'m' satisfies FieldSize}
                value={String(
                  result.tables.findIndex((t) => t.schema === schema && t.name === table),
                )}
                onChange={(e) => {
                  const picked = result.tables[Number(e.target.value)];
                  if (picked !== undefined) choose(picked);
                }}
              >
                <option value="-1">— choose —</option>
                {result.tables.map((t, i) => (
                  <option key={i} value={String(i)}>
                    {qualified(t)}
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
          {result.truncated && (
            <p role="status" className="page-hint">
              First {result.tables.length} tables; type a name to use another
            </p>
          )}
        </>
      )}
    </>
  );
}
