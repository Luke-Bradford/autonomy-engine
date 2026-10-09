import type { ActivityBindingSlot } from '@autonomy-studio/shared';
import type { NodeTab } from '../../stores/uiStore';
import type { NodeTypeTab } from './activityTabs';

/**
 * #1477 OR29 — what a RAW issue already attributed to `nodeId` is about, read
 * from the part after the node's leading location. `undefined` when it names
 * no one field, binding or the run policy: it stays in the panel's issue list
 * under the tabs (which every tab shows), so leaving it off a label loses nothing.
 *
 * Like `issueSubject`, this reads the MESSAGE FORMAT and must be handed the raw
 * string — `readableIssue` swaps ids for names. The three location forms are the
 * ones `issueSubject` reads: `node '<id>': ` (`activityNodeErrors`, policy),
 * `node.<id>: ` (binding refusals) and `nodes.<id>.` (expression locations).
 */
export type IssueTarget =
  | { readonly field: string }
  | { readonly slot: ActivityBindingSlot }
  | { readonly policy: true };

export function issueTarget(raw: string, nodeId: string): IssueTarget | undefined {
  const rest = afterLocation(raw, nodeId);
  if (rest === undefined) return undefined;
  const config = /^config\.([^.:[\s]+)/.exec(rest);
  if (config) return { field: config[1]! };
  if (/^policy\b/.test(rest)) return { policy: true };
  const paired = /^(connectionIds|datasetIds|datasetParams)\.(source|sink)\b/.exec(rest);
  if (paired) {
    const side = paired[2] === 'source' ? 'source' : 'sink';
    return { slot: paired[1] === 'connectionIds' ? `${side}Connection` : `${side}Dataset` };
  }
  if (/^(connectionId|connectionParams)\b/.test(rest)) return { slot: 'connection' };
  return undefined;
}

function afterLocation(raw: string, nodeId: string): string | undefined {
  for (const prefix of [`node '${nodeId}': `, `node.${nodeId}: `, `nodes.${nodeId}.`]) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return undefined;
}

/** One tab label's status. */
export interface TabStatus {
  /** Issues this tab's fields, bindings or (General) run policy have. */
  readonly problems: number;
  /** An edit on this tab that is not on the node yet: an unapplied field, a half-picked pair. */
  readonly pending: boolean;
  /**
   * Every required field on this tab holds a value, and nothing is wrong or
   * pending. Only a tab WITH required fields can be complete: bindings never
   * make one so, because whether a connection is required is not in the
   * catalog entry, and a ✓ that guessed would be worse than none.
   */
  readonly complete: boolean;
}

export interface TabStatusInput {
  readonly nodeId: string;
  readonly tabs: readonly NodeTypeTab[];
  /** RAW issues attributed to this node (`useSubjectIssues`). */
  readonly issues: readonly string[];
  /** Paths of a refused Apply's pre-check, relative to `config` (Zod paths). */
  readonly applyIssues: readonly (readonly PropertyKey[])[];
  readonly pendingFields: ReadonlySet<string>;
  readonly pendingSlots: ReadonlySet<ActivityBindingSlot>;
  /** The config the node HOLDS — what a ✓ certifies is what is applied. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** Each tab's status, General's included. A tab with nothing to say is absent. */
export function tabStatuses(input: TabStatusInput): Map<NodeTab, TabStatus> {
  const { nodeId, tabs, pendingFields, pendingSlots, config } = input;
  const tabOfField = new Map<string, NodeTab>();
  const tabOfSlot = new Map<ActivityBindingSlot, NodeTab>();
  for (const t of tabs) {
    for (const f of t.fields) tabOfField.set(f.name, t.key);
    for (const s of t.bindings) tabOfSlot.set(s, t.key);
  }

  const problems = new Map<NodeTab, number>();
  const count = (tab: NodeTab | undefined) => {
    if (tab !== undefined) problems.set(tab, (problems.get(tab) ?? 0) + 1);
  };
  for (const raw of input.issues) {
    const target = issueTarget(raw, nodeId);
    if (target === undefined) continue;
    if ('policy' in target) count('general');
    else if ('field' in target) count(tabOfField.get(target.field));
    else count(tabOfSlot.get(target.slot));
  }
  for (const path of input.applyIssues) {
    const head = path[0];
    count(typeof head === 'string' ? tabOfField.get(head) : undefined);
  }

  const out = new Map<NodeTab, TabStatus>();
  const general = problems.get('general') ?? 0;
  if (general > 0) out.set('general', { problems: general, pending: false, complete: false });
  for (const t of tabs) {
    const n = problems.get(t.key) ?? 0;
    const pending =
      t.fields.some((f) => pendingFields.has(f.name)) || t.bindings.some((s) => pendingSlots.has(s));
    const required = t.fields.filter((f) => !f.optional);
    const complete =
      n === 0 && !pending && required.length > 0 && required.every((f) => filled(config[f.name]));
    if (n > 0 || pending || complete) out.set(t.key, { problems: n, pending, complete });
  }
  return out;
}

function filled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The label's mark and what it means, for `PanelTabs`. Problems outrank pending,
 * and pending outranks complete: the mark is what the author should act on next.
 */
export function tabStatusMark(
  status: TabStatus | undefined,
): { glyph: string; tone: 'error' | 'pending' | 'complete'; description: string } | undefined {
  if (status === undefined) return undefined;
  if (status.problems > 0) {
    const noun = status.problems === 1 ? 'problem' : 'problems';
    const unapplied = status.pending ? ', unapplied changes' : '';
    return {
      glyph: `⚠ ${status.problems}`,
      tone: 'error',
      description: `${status.problems} ${noun}${unapplied}`,
    };
  }
  if (status.pending) return { glyph: '•', tone: 'pending', description: 'Unapplied changes' };
  if (status.complete) return { glyph: '✓', tone: 'complete', description: 'Required settings filled' };
  return undefined;
}
