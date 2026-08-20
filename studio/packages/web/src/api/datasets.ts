import { z } from 'zod';
import {
  DatasetSchema,
  NewDatasetSchema,
  paginatedResponseSchema,
  type Dataset,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

/**
 * The `datasets` REST client (#996 M5 slice 4c, #1139; CRUD added with the
 * Manage → Datasets page, #1115).
 *
 * There is no `exportDataset` here and no import: a dataset's `connectionId` is
 * a LOCAL primary key that has to be remapped to the connection's stable
 * `resourceId` before it can leave this workspace, which is the workspace-git
 * path's job. Single-file dataset export/import is tracked separately.
 */

/**
 * The client-facing write body, reconstructed to match the server's local
 * `DatasetWriteBodySchema` (`packages/server/src/routes/datasets.ts`) EXACTLY:
 * everything `NewDatasetSchema` needs except `ownerId`, which is stamped
 * server-side from the principal and is never client-supplied. Deriving it from
 * the same shared `NewDatasetSchema` keeps the form's client-side validation
 * identical to the server's — one source of truth, on the `connections.ts`
 * precedent.
 */
export const DatasetWriteSchema = NewDatasetSchema.omit({
  ownerId: true,
  parameters: true,
}).extend({
  /**
   * #2 L13b — re-declared WITHOUT `DatasetSchema`'s `.default([])`, mirroring
   * the server body's own re-declaration, and load-bearing for the identical
   * reason: were the default inherited, `safeParse` would manufacture
   * `parameters: []` on every submit, so an EDIT of any other field would PATCH
   * an explicit `[]` and silently clear the stored override allowlist (the
   * server treats an explicit `[]` as a deliberate clear — correctly). No
   * editor exists for it yet; omitting the key preserves the stored value.
   */
  parameters: z.array(z.string().min(1)).optional(),
});
export type DatasetWrite = z.input<typeof DatasetWriteSchema>;

const DatasetPageSchema = paginatedResponseSchema(DatasetSchema);

/**
 * Owner-scoped list of datasets. A dataset carries no secret and no internal FK,
 * so there is no public projection to apply — the stored row IS the client row.
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

export function createDataset(body: DatasetWrite): Promise<Dataset> {
  return apiFetch('/api/datasets', { method: 'POST', body, schema: DatasetSchema });
}

/**
 * PATCH is partial: only the supplied fields change.
 *
 * `columns` is NOT exempt from that — an omitted `columns` leaves the stored
 * declaration alone, which is what makes a rename safe. The form must never
 * send `columns: []` to mean "I did not touch it"; an empty array is a positive
 * claim that the table has no columns (`schemas/dataset.ts`, §2.2).
 */
export function updateDataset(id: string, body: Partial<DatasetWrite>): Promise<Dataset> {
  return apiFetch(`/api/datasets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: DatasetSchema,
  });
}

export function deleteDataset(id: string): Promise<void> {
  return apiFetch<void>(`/api/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
