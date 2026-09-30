import { createContext, useContext } from 'react';
import type { PipelineVersion, RunStatus } from '@autonomy-studio/shared';
import type { RunOverlayEntry } from '../runs/runFlow';
import type { NodeActivity } from '../runs/runSummary';

/** #1395 OR4 — a run the editor started: its id and the version it is bound to. */
export interface EditorRun {
  runId: string;
  version: PipelineVersion;
}

/** What the authoring canvas and its dock know about that run, as it streams. */
export interface EditorRunView {
  runId: string;
  /** Per box, keyed by node or container id — `runNodeOverlay`. */
  overlay: ReadonlyMap<string, RunOverlayEntry>;
  /** The run page's own node rows (`deriveNodeActivity`, reconciled). */
  nodes: readonly NodeActivity[];
  status: RunStatus;
  /** Whether a frame could still arrive to settle a node — the run page's rule. */
  live: boolean;
  /** The run version's name for a node, or `null` where it names none. */
  nameOf: (nodeId: string) => string | null;
}

export const EditorRunContext = createContext<EditorRunView | null>(null);

/** One box's overlay entry, or `undefined` when there is no run or no entry. */
export function useEditorRunNode(id: string): RunOverlayEntry | undefined {
  return useContext(EditorRunContext)?.overlay.get(id);
}
