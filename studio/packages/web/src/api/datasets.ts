import { DatasetSchema, paginatedResponseSchema, type Dataset } from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

const DatasetPageSchema = paginatedResponseSchema(DatasetSchema);

/**
 * Owner-scoped list of datasets (#996 M5 slice 4c, #1139).
 *
 * Read-only, and deliberately the only thing this module exports for now: the
 * canvas needs datasets to populate a `copy` node's source/sink pickers, and
 * dataset CRUD belongs to the Manage → Datasets page (#1115), not here.
 *
 * `GET /api/datasets` is keyset-paginated (#534); this walks every page and
 * returns the full list, so callers see the same `Promise<T[]>` as
 * `listConnections`. The `signal` threads through every page fetch.
 */
export function listDatasets(signal?: AbortSignal): Promise<Dataset[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/datasets${pageQuery(cursor)}`, { schema: DatasetPageSchema, signal }),
  );
}
