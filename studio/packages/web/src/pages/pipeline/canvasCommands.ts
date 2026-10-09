import { singleSelection, type createCanvasStore } from './canvasStore';
import { containerLabels } from './containerRules';
import { pasteAndSay } from './paste';
import type { ClipboardCommand } from './undoRedo';

/** What the canvas can be told to do from a keystroke or its context menu. */
export type CanvasCommand = ClipboardCommand | 'delete';

/**
 * Whether the command was TAKEN — the caller `preventDefault`s a keystroke only
 * then — and the line to say about it, if any. A delete says nothing: the nodes
 * leaving the canvas are the feedback, as they were for the key alone.
 */
export type CanvasCommandResult = { taken: false } | { taken: true; notice: string | null };

const NOT_TAKEN: CanvasCommandResult = { taken: false };

/**
 * #1477 OR29 — the ONE place ⌘C/⌘X/⌘D/⌘V/⌫ and the canvas context menu act on
 * the selection, so the two cannot drift apart on what a gesture does or says.
 * The guards on WHEN a command may run (a preview, a save or restore in flight,
 * the leave prompt, a modal dialog) stay with each caller, because a refused
 * keystroke is silent and a refused menu item says why.
 *
 * `taken: false` is load-bearing for the keystroke: with nothing of OURS to
 * copy, ⌘C is left to the browser's own text copy on the page.
 */
export function runCanvasCommand(
  store: ReturnType<typeof createCanvasStore>,
  pipelineId: string,
  cmd: CanvasCommand,
): CanvasCommandResult {
  const state = store.getState();
  if (cmd === 'delete') {
    if (state.selected.length === 0) return NOT_TAKEN;
    state.deleteSelection();
    return { taken: true, notice: null };
  }
  if (cmd === 'copy' || cmd === 'cut') {
    const box = singleSelection(state.selected);
    if (box?.kind === 'container') {
      // #935 — a container copies whole. It is never cut: its only delete
      // (the ✕) keeps the body, so there is no delete a cut could be.
      if (cmd === 'cut') {
        return { taken: true, notice: 'A container cannot be cut. Copy it with ⌘C.' };
      }
      if (!state.copyContainer(box.id, pipelineId)) return NOT_TAKEN;
      const name = containerLabels(store.getState().containers).get(box.id);
      return { taken: true, notice: `Copied ${name ?? 'container'}.` };
    }
    const n = cmd === 'copy' ? state.copySelection(pipelineId) : state.cutSelection(pipelineId);
    if (n === 0) return NOT_TAKEN;
    const what = `${n} ${n === 1 ? 'activity' : 'activities'}`;
    return { taken: true, notice: cmd === 'copy' ? `Copied ${what}.` : `Cut ${what}.` };
  }
  if (cmd === 'duplicate') {
    const box = singleSelection(state.selected);
    if (box?.kind === 'container') {
      // A container is selection-EXCLUSIVE, so a selected box is the whole
      // selection and ⌘D means "another one of these", as it does for nodes.
      const name = containerLabels(state.containers).get(box.id);
      if (state.duplicateContainer(box.id) === null) return NOT_TAKEN;
      return { taken: true, notice: `Duplicated ${name ?? 'container'}.` };
    }
    if (state.selected.every((sel) => sel.kind !== 'node')) return NOT_TAKEN;
    const made = state.duplicateSelection();
    return { taken: true, notice: `Duplicated ${made} ${made === 1 ? 'activity' : 'activities'}.` };
  }
  return { taken: true, notice: pasteAndSay(store, pipelineId) };
}
