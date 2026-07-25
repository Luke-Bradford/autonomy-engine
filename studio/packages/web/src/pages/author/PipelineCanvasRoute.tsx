import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import type { Pipeline } from '@autonomy-studio/shared';
import { ApiError } from '../../api/client';
import { getPipeline } from '../../api/pipelines';
import { PipelineCanvas } from '../pipeline/PipelineCanvas';

/** Where "back" goes, and where a missing pipeline sends you. */
const PIPELINES_PATH = '/author/pipelines';

/**
 * Reads `:pipelineId` out of the URL, resolves the pipeline, and hands both to
 * the canvas (U4).
 *
 * Before U4 the open pipeline was LOCAL state inside `PipelinesPage`, so the
 * canvas had no address: it could not be linked to, bookmarked, or reached from
 * the Factory Resources tree, and Back left it. The route is the same shape
 * `runs`/`:runId` already uses, and for the same reasons:
 *
 * 1. `key={pipelineId}` — `PipelineCanvas` holds per-pipeline working state (an
 *    unsaved graph), and React Router REUSES a route component instance when
 *    only a param changes. Without the key, clicking a second pipeline in the
 *    tree would keep the first one's edits mounted under the new id.
 * 2. NO `decodeURIComponent` — `useParams` returns params already decoded, and
 *    `pipelinePath()` is what encoded them.
 *
 * The pipeline is fetched BY ID rather than looked up in `pipelinesStore`: a
 * deep link must not wait on the page-walked list, and a 404 here is a real
 * answer ("no such pipeline, or not yours") rather than "not in the list yet".
 */
export function PipelineCanvasRoute() {
  const { pipelineId } = useParams();
  // The route only matches with a non-empty `:pipelineId`, so this is defensive.
  if (!pipelineId) return <Navigate to={PIPELINES_PATH} replace />;
  return <CanvasFor key={pipelineId} pipelineId={pipelineId} />;
}

function CanvasFor({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);

  // Promise-callback form, keeping setState off the synchronous effect body
  // (React's `set-state-in-effect` guidance) — as the canvas's own load does.
  useEffect(() => {
    const ctrl = new AbortController();
    getPipeline(pipelineId, ctrl.signal)
      .then(setPipeline)
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError({
          message: err instanceof Error ? err.message : String(err),
          missing: err instanceof ApiError && err.status === 404,
        });
      });
    return () => ctrl.abort();
  }, [pipelineId]);

  if (error) {
    return (
      <section aria-labelledby="pipeline-missing-heading">
        <div className="page-header">
          <h2 id="pipeline-missing-heading">
            {/* A deleted-or-never-existed pipeline is not a fault, and saying
                "error" for it would send the user looking for a broken server.
                Anything else IS a fault and keeps its message. */}
            {error.missing ? 'Pipeline not found' : 'Could not open pipeline'}
          </h2>
        </div>
        <p className="error" role="alert">
          {error.missing ? `No pipeline with id ${pipelineId}.` : error.message}
        </p>
        <p>
          <Link to={PIPELINES_PATH}>Back to pipelines</Link>
        </p>
      </section>
    );
  }

  // Nothing to draw yet. The canvas needs the NAME to render its heading, and a
  // placeholder heading that is later replaced reads as a flicker of the wrong
  // pipeline — worse than a moment of "Loading".
  if (!pipeline) return <p className="page-hint">Loading pipeline…</p>;

  return (
    <PipelineCanvas
      pipelineId={pipeline.id}
      pipelineName={pipeline.name}
      onBack={() => void navigate(PIPELINES_PATH)}
    />
  );
}
