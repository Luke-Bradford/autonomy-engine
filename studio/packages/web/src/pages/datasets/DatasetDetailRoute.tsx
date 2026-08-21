import { Navigate, useParams } from 'react-router';
import { DatasetDetailPage } from './DatasetDetailPage';

/**
 * Reads `:datasetId` out of the URL and hands it to the page as a prop
 * (#996 M9, #1185) — the `RunDetailRoute` shape, and for the same two reasons:
 *
 * 1. `key={datasetId}` — the page holds per-dataset state (the dataset and its
 *    reference walk), and React Router REUSES a route's component instance when
 *    only a param changes, so without the key a dataset→dataset navigation
 *    would keep the previous dataset's rows mounted under a new id.
 * 2. NO `decodeURIComponent` — `useParams` returns params already decoded, so
 *    carrying one over would double-decode. `routes.test.tsx` pins this with an
 *    id that is not idempotent under a second decode.
 */
export function DatasetDetailRoute() {
  const { datasetId } = useParams();
  // The route only matches with a non-empty `:datasetId`, so this is defensive.
  if (!datasetId) return <Navigate to="/manage/datasets" replace />;
  return <DatasetDetailPage key={datasetId} datasetId={datasetId} />;
}
