import { downloadTextFile, exportFileName } from './download';
import { exportPipeline } from './portability';

/**
 * #1397 — export one pipeline and hand the browser its file.
 *
 * The ONE copy: the pipelines list, the Factory Resources row menu and the
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
