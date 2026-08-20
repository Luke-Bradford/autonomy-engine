import type { ComponentType } from 'react';
import {
  ArrowRouting20Regular,
  ArrowSplit20Regular,
  Bot20Regular,
  BranchFork20Regular,
  Clock20Regular,
  Copy20Regular,
  DatabaseArrowRight20Regular,
  Delete20Regular,
  Document20Regular,
  DocumentArrowDown20Regular,
  DocumentEdit20Regular,
  ErrorCircle20Regular,
  Filter20Regular,
  Folder20Regular,
  FolderArrowRight20Regular,
  Globe20Regular,
  PlugConnected20Regular,
  Sparkle20Regular,
} from '@fluentui/react-icons';

/**
 * One glyph per activity type — the canvas's and the toolbox's shared vocabulary.
 *
 * A node used to be a name on a rectangle, which made a graph of eight boxes a
 * wall of text an operator had to READ to navigate. An icon is what turns that
 * into something scanned: the shape says "this writes a file" before the words
 * are parsed, which is the whole reason every comparable tool draws one.
 *
 * ONE map, spent in two places by design. The palette a user drags from and the
 * box that appears on the canvas must be the same object as far as recognition
 * goes — two icon sets, or an icon in one surface and not the other, and the
 * palette stops teaching the canvas.
 *
 * KEYED ON TYPE, with a CATEGORY fallback, and the fallback is the load-bearing
 * half. The shared catalog is open — a new activity can be registered without
 * touching this file, and an unmapped one must still draw a sensible glyph
 * rather than a hole.
 */
type Glyph = ComponentType<{ className?: string }>;

const BY_TYPE: Readonly<Record<string, Glyph>> = {
  http_request: Globe20Regular,
  llm_call: Sparkle20Regular,
  agent_task: Bot20Regular,
  /* The catalog's ids are SHORTER than the titles they draw — `if`, not
     `if_condition`; `webhook`, not `webhook_wait`; `file_list`, not
     `list_directory`. Four of these were wrong on the first pass and every one
     of them would have failed SILENTLY into the category fallback, which is
     precisely why `activityIcon.test.ts` pins the map against the live catalog
     rather than trusting this list to be read carefully. */
  if: BranchFork20Regular,
  switch: ArrowSplit20Regular,
  fail: ErrorCircle20Regular,
  filter: Filter20Regular,
  wait: Clock20Regular,
  webhook: PlugConnected20Regular,
  execute_pipeline: ArrowRouting20Regular,
  // The structural call activity (P2c) draws as what it is — the same routing
  // glyph, because to an operator it is the same act.
  call_pipeline: ArrowRouting20Regular,
  file_read: DocumentArrowDown20Regular,
  file_write: DocumentEdit20Regular,
  file_copy: Copy20Regular,
  file_move: FolderArrowRight20Regular,
  file_delete: Delete20Regular,
  file_list: Folder20Regular,
  /* #996 M5 — the data-movement `copy`, NOT `Copy20Regular`: `file_copy` already
     draws that, and one glyph across two unrelated activities is exactly the
     "quietly wearing somebody else's icon" failure this map's test exists to
     catch. A database with an outbound arrow says what a copy does — reads one
     store, writes another — where a pair of pages says only "duplicate". */
  copy: DatabaseArrowRight20Regular,
};

/**
 * The fallback, by the catalog's own grouping — so an unmapped activity still
 * lands in the right family rather than on a generic dot.
 */
const BY_CATEGORY: Readonly<Record<string, Glyph>> = {
  general: Document20Regular,
  ai: Sparkle20Regular,
  control: BranchFork20Regular,
};

export function activityIcon(type: string, category?: string): Glyph {
  return (
    BY_TYPE[type] ??
    (category === undefined ? Document20Regular : BY_CATEGORY[category]) ??
    Document20Regular
  );
}
