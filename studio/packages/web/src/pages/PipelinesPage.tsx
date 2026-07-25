import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useStore } from 'zustand';
import type { Pipeline } from '@autonomy-studio/shared';
import { ApiError } from '../api/client';
import { createPipeline, deletePipeline } from '../api/pipelines';
import { pipelinesStore, type PipelinesStore } from '../stores/pipelinesStore';
import { pipelinePath } from './author/pipelinePath';

/**
 * Pipelines: list / create / delete, and open one on the authoring canvas.
 *
 * Since U4 this page is one of TWO views of the same list — the Factory
 * Resources pane beside it is the other, and both are mounted at once — so the
 * list lives in `pipelinesStore` rather than in this component. A create here
 * has to appear in the tree, and a delete in the tree has to disappear from
 * here; two independent `useState` copies could only be kept in step by luck.
 *
 * "Open" is a `<Link>` to the pipeline's own route, not local state. Before U4
 * the canvas replaced this page in place and had no address at all.
 *
 * The page is deliberately NOT reduced to a landing screen now that the pane
 * can do everything it does. The pane can be COLLAPSED (globally, and the
 * preference persists), and Author would then have no way to reach or create a
 * pipeline at all.
 */
export function PipelinesPage({ store = pipelinesStore }: { store?: PipelinesStore } = {}) {
  const status = useStore(store, (s) => s.status);
  const pipelines = useStore(store, (s) => s.pipelines);
  const loadError = useStore(store, (s) => s.error);
  const ensureLoaded = useStore(store, (s) => s.ensureLoaded);
  const refresh = useStore(store, (s) => s.refresh);

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

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

      {/* Gated on a load having SUCCEEDED: an empty list and a failed load are
          different facts, and "no pipelines yet" is a lie about the second. */}
      {status === 'ready' && pipelines.length === 0 && <p>No pipelines yet — create one below.</p>}

      {pipelines.length > 0 && (
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
                  {/* A link, so it can be middle-clicked, copied and bookmarked
                      — the navigation idiom U2 settled: `useNavigate` on a
                      button is only for navigating as the RESULT of an action. */}
                  <Link to={pipelinePath(p.id)} aria-label={`Open ${p.name}`}>
                    Open
                  </Link>
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

      <form
        className="connection-form"
        aria-label="New pipeline"
        onSubmit={(e) => void onCreate(e)}
      >
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
