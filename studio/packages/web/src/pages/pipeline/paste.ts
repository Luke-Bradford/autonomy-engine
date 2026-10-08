import type { Container } from '@autonomy-studio/shared';
import type { createCanvasStore, PasteOutcome } from './canvasStore';
import { containerLabels } from './containerRules';

/**
 * U21 — the notice a paste leaves, for ⌘V and the Paste button alike. A paste
 * from another pipeline says so (#935): its copies arrive without the in-edges
 * and container a local paste re-derives, and the line is where that shows.
 *
 * A pasted container is named by its COPY's label, read off `containers` AFTER
 * the paste — the name the operator now sees on the new box, as ⌘D's notice does.
 */
function pasteNotice(outcome: PasteOutcome, containers: Container[]): string {
  if (!outcome.ok) return outcome.reason;
  const what =
    outcome.containerId === undefined
      ? `${outcome.count} ${outcome.count === 1 ? 'activity' : 'activities'}`
      : (containerLabels(containers).get(outcome.containerId) ?? 'a container');
  return outcome.crossPipeline ? `Pasted ${what} from another pipeline.` : `Pasted ${what}.`;
}

/** Paste the clipboard into `pipelineId`'s canvas, and the line to say about it. */
export function pasteAndSay(store: ReturnType<typeof createCanvasStore>, pipelineId: string) {
  const pasted = store.getState().pasteClipboard(pipelineId);
  return pasteNotice(pasted, store.getState().containers);
}

/** What a paste says while a save or restore is in flight (`DockPasteButton`). */
export const PASTE_BUSY_NOTICE = 'Not pasted: wait for the save or restore to finish.';
