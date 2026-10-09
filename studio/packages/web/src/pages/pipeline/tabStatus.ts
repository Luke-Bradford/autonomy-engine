import type { ActivityBindingSlot } from '@autonomy-studio/shared';
import type { NodeTab } from '../../stores/uiStore';
import type { NodeTypeTab } from './activityTabs';
import type { PanelTabStatus } from './PanelTabs';

/**
 * #1477 OR29 — what a RAW issue already attributed to `nodeId` is about, read
 * from the part after the node's leading location. `undefined` when it names
 * no one field, binding or the run policy: it stays in the panel's issue list
 * under the tabs (which every tab shows), so leaving it off a label loses nothing.
 *
 * Like `issueSubject`, this reads the MESSAGE FORMAT and must be handed the raw
 * string — `readableIssue` swaps ids for names. The location forms are the ones
 * `issueSubject` reads: `node '<id>': ` (`activityNodeErrors`, policy),
 * `node.<id>: ` (bindings, the LLM surface), `node.<id>.` (per-activity checks:
 * an if's `condition`, a filter's fields) and `nodes.<id>.` (expressions).
 *
 * After the location, `config.<field>` names a field, as does a bare leading
 * name (`condition`, `mapping[2]`): `{ field }` is only a CANDIDATE, which
 * `tabStatuses` accepts only if some tab holds a field of that name (`type`,
 * `outputs` and the like are on no tab).
 */
export type IssueTarget =
  { readonly field: string } | { readonly slot: ActivityBindingSlot } | { readonly policy: true };

export function issueTarget(raw: string, nodeId: string): IssueTarget | undefined {
  const rest = afterLocation(raw, nodeId);
  if (rest === undefined) return undefined;
  if (/^policy\b/.test(rest)) return { policy: true };
  const paired = /^(connectionIds|datasetIds|datasetParams)\.(source|sink)\b/.exec(rest);
  if (paired) {
    const side = paired[2] === 'source' ? 'source' : 'sink';
    return { slot: paired[1] === 'connectionIds' ? `${side}Connection` : `${side}Dataset` };
  }
  if (/^(connectionId|connectionParams)\b/.test(rest)) return { slot: 'connection' };
  const field = /^(?:config\.)?([^.:[\s]+)/.exec(rest);
  return field ? { field: field[1]! } : undefined;
}

function afterLocation(raw: string, nodeId: string): string | undefined {
  for (const prefix of [
    `node '${nodeId}': `,
    `node.${nodeId}: `,
    `node.${nodeId}.`,
    `nodes.${nodeId}.`,
  ]) {
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
   * Every required field on this tab holds a value, every binding on it is
   * bound, and nothing is wrong or pending — here or anywhere a tab cannot show
   * (an issue placed on no tab withholds every ✓, so a ✓ never sits beside an
   * unexplained problem). A tab with neither required fields nor bindings has
   * nothing to complete. An OPTIONAL binding left unbound withholds the ✓ too:
   * whether a binding is required is not in the catalog entry, and a ✓ that
   * guessed would be worse than none.
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
  /** The slots the node holds a binding for. */
  readonly boundSlots: ReadonlySet<ActivityBindingSlot>;
}

/** Each tab's status, General's included. A tab with nothing to say is absent. */
export function tabStatuses(input: TabStatusInput): Map<NodeTab, TabStatus> {
  const { nodeId, tabs, pendingFields, pendingSlots, config, boundSlots } = input;
  const tabOfField = new Map<string, NodeTab>();
  const tabOfSlot = new Map<ActivityBindingSlot, NodeTab>();
  for (const t of tabs) {
    for (const f of t.fields) tabOfField.set(f.name, t.key);
    for (const s of t.bindings) tabOfSlot.set(s, t.key);
  }

  const problems = new Map<NodeTab, number>();
  let unplaced = 0;
  const count = (tab: NodeTab | undefined) => {
    if (tab === undefined) unplaced += 1;
    else problems.set(tab, (problems.get(tab) ?? 0) + 1);
  };
  for (const raw of input.issues) {
    const target = issueTarget(raw, nodeId);
    if (target === undefined) count(undefined);
    else if ('policy' in target) count('general');
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
      t.fields.some((f) => pendingFields.has(f.name)) ||
      t.bindings.some((s) => pendingSlots.has(s));
    const required = t.fields.filter((f) => !f.optional);
    const complete =
      unplaced === 0 &&
      n === 0 &&
      !pending &&
      required.length + t.bindings.length > 0 &&
      required.every((f) => filled(config[f.name])) &&
      t.bindings.every((s) => boundSlots.has(s));
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
export function tabStatusMark(status: TabStatus | undefined): PanelTabStatus | undefined {
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
  if (status.complete) return { glyph: '✓', tone: 'complete', description: 'Complete' };
  return undefined;
}

/**
 * #1477 OR29 — the lead for a refused Apply's message, naming the tabs its
 * issues are on ("On Sink, Mapping: "), or `''` when they are all on the tab the
 * author is looking at, where the message already sits.
 */
export function refusalLead(
  tabs: readonly NodeTypeTab[],
  paths: readonly (readonly PropertyKey[])[],
  current: NodeTab,
): string {
  const named = tabs.filter((t) =>
    paths.some((p) => typeof p[0] === 'string' && t.fields.some((f) => f.name === p[0])),
  );
  if (named.every((t) => t.key === current)) return '';
  return `On ${named.map((t) => t.label).join(', ')}: `;
}
