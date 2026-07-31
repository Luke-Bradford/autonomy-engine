import { lazy } from 'react';

/**
 * #698, second front — the on-demand wrapper around `RunGraph`.
 *
 * `RunGraph` pulls in `@xyflow/react` (and its stylesheet) via `RunCanvas`, AND
 * the engine reducer via `projectRun`. React Flow, until U11, was
 * reachable from exactly ONE route — the author canvas — and was split out for
 * that reason: everyone was paying React Flow's download to look at a list of
 * runs. Importing it statically from `RunDetailPage` put the whole library back
 * in the ENTRY chunk and quietly undid that split, because the run-detail route
 * is eagerly imported by `routes.tsx`. Measured on this branch: entry 111.09 →
 * 182.14 kB gzip, and Rollup's 500 kB warning returned.
 *
 * `React.lazy` for the same two reasons `PipelineCanvasRoute.lazy.ts` gives, and
 * a boundary in the PAGE rather than at the route: the run's metadata, node
 * table and event feed are all useful without the graph, so they paint first and
 * the canvas fills in. A route-level boundary would hold all of it back for the
 * one part that needs a 60 kB library.
 *
 * Its own file because `React.lazy` needs a default export and this codebase
 * exports by name — and so `RunDetailPage.tsx` keeps its named exports without
 * tripping `react-refresh/only-export-components`.
 */
export const RunGraph = lazy(() => import('./RunGraph.js').then((m) => ({ default: m.RunGraph })));
