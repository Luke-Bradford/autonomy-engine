import { downloadTextFile, exportFileName, fileTimestamp } from './download';
import { exportPipeline, exportPipelines } from './portability';

/**
 * #1397 — export one pipeline and hand the browser its file.
 *
 * The ONE copy: the pipelines list, the Factory resources row menu and the
 * editor's ⋯ menu all export a pipeline, and the third of those is where two
 * hand-written copies became a helper. Its own module, not `portability.ts`,
 * so the callers' `vi.mock('…/portability')` still intercepts `exportPipeline`
 * — a same-module call would bypass the mock.
 *
 * Exports what the SERVER holds, i.e. the latest saved version.
 */
export async function downloadPipelineExport(pipeline: {
  id: string;
  name: string;
}): Promise<void> {
  downloadTextFile(
    exportFileName('pipeline', pipeline.name, pipeline.id),
    await exportPipeline(pipeline.id),
  );
}

/**
 * #1586 — export several pipelines as ONE importable file (the Pipelines
 * toolbar's Export), named for when it was taken: `pipelines-<stamp>.json`.
 * The bytes are the server's, unchanged, as for a single export.
 */
export async function downloadPipelinesBundle(ids: readonly string[]): Promise<void> {
  const text = await exportPipelines(ids);
  downloadTextFile(`pipelines-${fileTimestamp(Date.now())}.json`, text);
}
