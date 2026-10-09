import type { ActivityBindingSlot } from '@autonomy-studio/shared';
import type { NodeTab } from '../../stores/uiStore';
import type { NodeTypeTab } from './activityTabs';
import type { PanelTabStatus } from './PanelTabs';

/** #1477 OR29 — what `issueTarget` found an issue to be about. */
export type IssueTarget =
  { readonly field: string } | { readonly slot: ActivityBindingSlot } | { readonly policy: true };

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
 * name followed by `.`, `:` or `[` (`condition: …`, `mapping[2]`) — never a
 * prose word (`node.<id>: a wait needs …`). The variable guard's
 * `node '<id>' (<type>): '<field>' …` names its field quoted. `{ field }` is
 * only a CANDIDATE, which
 * `tabStatuses` accepts only if some tab holds a field of that name (`type`,
 * `outputs` and the like are on no tab).
 */
export function issueTarget(raw: string, nodeId: string): IssueTarget | undefined {
  const guarded = `node '${nodeId}' (`;
  if (raw.startsWith(guarded)) {
    const quoted = /^[^)]*\): '([^']+)'/.exec(raw.slice(guarded.length));
    return quoted ? { field: quoted[1]! } : undefined;
  }
  const rest = afterLocation(raw, nodeId);
  if (rest === undefined) return undefined;
  if (/^policy\b/.test(rest)) return { policy: true };
  const paired = /^(connectionIds|datasetIds|datasetParams)\.(source|sink)\b/.exec(rest);
  if (paired) {
    const side = paired[2] === 'source' ? 'source' : 'sink';
    return { slot: paired[1] === 'connectionIds' ? `${side}Connection` : `${side}Dataset` };
  }
  if (/^(connectionId|connectionParams)\b/.test(rest)) return { slot: 'connection' };
  const field = /^(?:config\.)?([^.:[\s]+)(?=[.:[])/.exec(rest);
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

/**
 * One tab label's status. A per-tab COUNT such as the ticket's "Mapping 3/4"
 * (columns mapped of the source's) is not here: it needs the source schema,
 * and a generic required-filled n/m would re-state the validator's own
 * "required" issue, which already shows as a problem.
 */
export interface TabStatus {
  /** Issues this tab's fields, bindings or (General) run policy have. */
  readonly problems: number;
  /** An edit on this tab that is not on the node yet: an unapplied field, a half-picked pair. */
  readonly pending: boolean;
  /**
   * Every required field on this tab holds a value in the APPLIED config, every
   * binding on it is bound, and no issue attributed to this node is open — here
   * or anywhere a tab cannot show (an issue placed on no tab withholds every ✓).
   * An unapplied edit does not withdraw it: the ✓ describes the node, the
   * pending dot the draft, and a keystroke must not move the tabs.
   * It does not see what `issuesBySubject` leaves unattributed (a cycle's brace
   * list, a call-graph refusal); the canvas's Problems list still has those. A tab with neither required fields nor bindings has
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
  const tabOfField = fieldTabs(tabs);
  const tabOfSlot = new Map<ActivityBindingSlot, NodeTab>();
  for (const t of tabs) for (const s of t.bindings) tabOfSlot.set(s, t.key);

  const problems = new Map<NodeTab, number>();
  let unplaced = 0;
  const count = (tab: NodeTab | undefined) => {
    if (tab === undefined) unplaced += 1;
    else problems.set(tab, (problems.get(tab) ?? 0) + 1);
  };
  const flagged = new Set<string>();
  for (const raw of input.issues) {
    const target = issueTarget(raw, nodeId);
    if (target === undefined) count(undefined);
    else if ('policy' in target) count('general');
    else if ('field' in target) {
      flagged.add(target.field);
      count(tabOfField.get(target.field));
    } else count(tabOfSlot.get(target.slot));
  }
  // A refused Apply re-states a problem the applied node may already have (its
  // URL is missing, and the draft's still is): that field is counted once.
  for (const path of input.applyIssues) {
    const head = path[0];
    if (typeof head === 'string' && flagged.has(head)) continue;
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
 * The label's marks and what they mean, for `PanelTabs`: problems or complete
 * after the label, and the pending dot beside either.
 */
export function tabStatusMark(status: TabStatus | undefined): PanelTabStatus | undefined {
  if (status === undefined) return undefined;
  const parts: string[] = [];
  let mark: PanelTabStatus['mark'];
  if (status.problems > 0) {
    parts.push(`${status.problems} ${status.problems === 1 ? 'problem' : 'problems'}`);
    mark = { glyph: `⚠ ${status.problems}`, tone: 'error' };
  } else if (status.complete) {
    parts.push('complete');
    mark = { glyph: '✓', tone: 'complete' };
  }
  if (status.pending) parts.push('unapplied changes');
  const description = parts.join(', ');
  return {
    ...(mark && { mark }),
    pending: status.pending,
    description: description.charAt(0).toUpperCase() + description.slice(1),
  };
}

/**
 * #1477 OR29 — the lead for a refused Apply's message, naming the tabs its
 * issues are on ("On Sink, Mapping: "), or `''` when they are all on the tab the
 * author is looking at, where the message already sits.
 */
export function refusalLead<K extends string>(
  tabs: readonly FieldTab<K>[],
  paths: readonly (readonly PropertyKey[])[],
  current: K,
): string {
  const tabOfField = fieldTabs(tabs);
  const keys = new Set(
    paths.flatMap((p) => (typeof p[0] === 'string' ? [tabOfField.get(p[0])] : [])),
  );
  const named = tabs.filter((t) => keys.has(t.key));
  if (named.every((t) => t.key === current)) return '';
  return `On ${named.map((t) => t.label).join(', ')}: `;
}

/** A tab as far as `refusalLead` needs it: a node's type tab, or a container's (#1477). */
interface FieldTab<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly fields: readonly { readonly name: string }[];
}

/** Which tab each field is on. */
function fieldTabs<K extends string>(tabs: readonly FieldTab<K>[]): Map<string, K> {
  const out = new Map<string, K>();
  for (const t of tabs) for (const f of t.fields) out.set(f.name, t.key);
  return out;
}
