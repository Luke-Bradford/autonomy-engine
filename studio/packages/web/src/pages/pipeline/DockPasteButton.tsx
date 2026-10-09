import { ClipboardPasteRegular } from '@fluentui/react-icons';
import type { createCanvasStore } from './canvasStore';
import { PASTE_BUSY_NOTICE, pasteAndSay } from './paste';

/**
 * U21's Paste, in the property dock's header (#1477 OR29) rather than as a
 * full-width bar in the nothing-selected panel: the header is shown whatever is
 * selected and with the dock folded, so the act ⌘V otherwise hides is always one
 * click away.
 *
 * ALWAYS enabled: the refusal reason (empty clipboard, or a copy from another
 * pipeline that reads a node it did not bring) is more use said than hidden
 * behind a grey button. That includes `busy` — a save or restore in flight,
 * when ⌘V refuses too: the graph is about to be replaced or committed.
 */
export function DockPasteButton({
  store,
  pipelineId,
  onNotice,
  busy = false,
}: {
  store: ReturnType<typeof createCanvasStore>;
  pipelineId: string;
  onNotice: (message: string) => void;
  /** A save or restore is in flight; the paste is refused, and says so. */
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Paste"
      title="Paste (⌘V)"
      onClick={() => onNotice(busy ? PASTE_BUSY_NOTICE : pasteAndSay(store, pipelineId))}
    >
      <ClipboardPasteRegular aria-hidden="true" />
    </button>
  );
}
