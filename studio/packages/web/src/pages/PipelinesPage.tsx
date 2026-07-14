import { useCallback, useEffect, useState } from 'react';
import type { Pipeline } from '@autonomy-studio/shared';
import { ApiError } from '../api/client';
import { createPipeline, deletePipeline, listPipelines } from '../api/pipelines';
import { PipelineCanvas } from './pipeline/PipelineCanvas';

/**
 * Pipelines: list / create / delete, and open one on the authoring canvas.
 * "Open" swaps this page for `<PipelineCanvas>` (local state, no route change) —
 * the canvas is a full-bleed editor that doesn't fit the list layout.
 */
export function PipelinesPage() {
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  // Refetch after a mutation (create / delete). Called only from event handlers,
  // never synchronously inside an effect — so its setState is safe.
  const refresh = useCallback(async () => {
    try {
      const list = await listPipelines();
      setPipelines(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load: promise-callback form keeps setState off the synchronous
  // effect body (React's `set-state-in-effect` guidance).
  useEffect(() => {
    const ctrl = new AbortController();
    listPipelines(ctrl.signal)
      .then((list) => {
        setPipelines(list);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, []);

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (trimmed === '') return;
      setCreating(true);
      setActionMsg(null);
      try {
        await createPipeline({ name: trimmed });
        setName('');
        await refresh();
      } catch (err) {
        setActionMsg(
          `Could not create pipeline: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setCreating(false);
      }
    },
    [name, refresh],
  );

  const onDelete = useCallback(
    async (p: Pipeline) => {
      if (!window.confirm(`Delete pipeline "${p.name}"? This cannot be undone.`)) return;
      setActionMsg(null);
      try {
        await deletePipeline(p.id);
        await refresh();
      } catch (err) {
        // The server refuses (409) a pipeline that has run history.
        const msg =
          err instanceof ApiError && err.status === 409
            ? `Cannot delete "${p.name}": it has run history.`
            : `Could not delete "${p.name}": ${err instanceof Error ? err.message : String(err)}`;
        setActionMsg(msg);
      }
    },
    [refresh],
  );

  if (open) {
    return (
      <PipelineCanvas
        key={open.id}
        pipelineId={open.id}
        pipelineName={open.name}
        onBack={() => {
          setOpen(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <section aria-labelledby="pipelines-heading">
      <div className="page-header">
        <h2 id="pipelines-heading">Pipelines</h2>
      </div>
      <p className="page-hint">
        A pipeline is a graph of activities. Open one to build it on the canvas; saving creates a
        new immutable version that a trigger can bind to.
      </p>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {actionMsg && <p className="notice">{actionMsg}</p>}

      {pipelines && pipelines.length === 0 && <p>No pipelines yet — create one below.</p>}

      {pipelines && pipelines.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => setOpen({ id: p.id, name: p.name })}
                    aria-label={`Open ${p.name}`}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDelete(p)}
                    aria-label={`Delete ${p.name}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="connection-form" aria-label="New pipeline" onSubmit={onCreate}>
        <h3>New pipeline</h3>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My pipeline"
          />
        </label>
        <div className="form-actions">
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create pipeline'}
          </button>
        </div>
      </form>
    </section>
  );
}
