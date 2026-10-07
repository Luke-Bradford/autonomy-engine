import { fileSlug } from '../../api/download';
import type { NodeActivity } from './runSummary';

/** #1484 OR35 M2 — the drawer's tabs, ADF's order. */
export type DrawerTab = 'input' | 'output' | 'error' | 'logs';

/**
 * The tab a record opens on until the operator picks one: its error when it has
 * one, its output otherwise. Read off the record each render, so a live attempt
 * that fails moves to Error by itself — but a tab the operator chose stays.
 * `retry_pending` and a row whose read model carries an error both count: the
 * error is recorded even though the status is not `failure`.
 */
export function defaultDrawerTab(node: NodeActivity): DrawerTab {
  return node.status === 'failure' || node.error !== undefined ? 'error' : 'output';
}

/** The longest a downloaded block's file-name stem gets: a ForEach item's label
 * can be a whole path, and file systems cap a name at about 255 bytes. */
const MAX_STEM = 80;

/**
 * #1484 OR35 M2 — what a block downloaded from the drawer is named before its
 * `-output.json`: the run, the activity, the attempt and the item, slugged and
 * bounded, so two files saved from one run never take each other's name.
 */
export function drawerFileStem(parts: readonly string[]): string {
  const slug = fileSlug(parts.join(' ')).slice(0, MAX_STEM).replace(/-+$/, '');
  return slug === '' ? 'activity' : slug;
}
