import {
  NodeSchema,
  fieldLabelOf,
  inactiveMarkAs,
  isInactive,
  AGENT_TASK_ACTIVITY_TYPE,
  APPEND_VARIABLE_ACTIVITY_TYPE,
  callDetaches,
  COPY_ACTIVITY_TYPE,
  COPY_FILES_ACTIVITY_TYPE,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  GET_METADATA_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  SET_VARIABLE_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
  WEB_ACTIVITY_TYPE,
  webCallbackTimeoutSeconds,
  webWaitsOnly,
  HTTP_REQUEST_ACTIVITY_TYPE,
  variableWriteOp,
  type Node,
} from '@autonomy-studio/shared';
import { formatElapsed } from '../runs/format';
import { inactiveStatusLabel } from '../runs/nodeStatus';

/** #1600 C0c — Mark as's option names (Succeeded · Failed · Skipped), from the schema. */
const MARK_AS_TITLES = fieldLabelOf(NodeSchema.shape.onInactiveMarkAs)!.options!;

/**
 * #1394 OR3 — the one line a card shows under its name, saying what THIS step
 * does: `orders.csv → orders table`, `GET api.example.com/v1/orders`, `wait 30s`.
 *
 * The name says which step it is ("Copy data 2") and the glyph says what kind; this
 * says what it is configured to do, so a graph can be read without opening each
 * node. It is derived from the doc alone, so it is the same on every render and
 * changes only when the config does.
 *
 * `null` means "nothing to say yet" — an unconfigured node, or a type the catalog
 * does not know (an imported doc may carry one). The card reserves the row either
 * way, so filling in a field never resizes the box (the OR2 rule).
 *
 * Values are shown AS WRITTEN, expressions included: `if ${equals(...)}` is what
 * the author typed and what they will look for. Two things are deliberately left
 * out. A URL loses its credentials (`user:pass@`), query string and fragment,
 * which is where a literal secret would sit; headers and body are never read.
 * And no config value is ever replaced by an id: a dataset the workspace no
 * longer lists reads "a dataset", matching OR1's names-not-ids rule — while a
 * `${}` dataset reference is shown as written.
 */
export function activitySummary(
  node: Node,
  datasetName: (id: string) => string | undefined,
): string | null {
  const c = node.config;
  // A `call` blob makes a node a call whatever its type says (#953) — so it is
  // checked before the type, exactly as the reducer routes it.
  if (node.call !== undefined) {
    return callDetaches(node.call) ? 'starts a pipeline' : 'runs a pipeline and waits';
  }
  switch (node.type) {
    case HTTP_REQUEST_ACTIVITY_TYPE:
    case WEB_ACTIVITY_TYPE: {
      // #1600 OR41 C11c-2 — no Request URL: the Webhook's wait, so its summary.
      if (node.type === WEB_ACTIVITY_TYPE && webWaitsOnly(c)) {
        return `callback · timeout ${formatElapsed(webCallbackTimeoutSeconds(c) * 1000)}`;
      }
      const url = text(c.url);
      if (url === undefined) return null;
      const method = (text(c.method) ?? 'GET').toUpperCase();
      return `${method} ${url
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^[^/?#]*@/, '')
        .replace(/[?#].*$/, '')}`;
    }
    case LLM_CALL_ACTIVITY_TYPE:
      return joined([text(c.model), c.outputMode === 'structured' ? 'structured' : undefined]);
    case AGENT_TASK_ACTIVITY_TYPE:
      return text(c.task) ?? null;
    case IF_ACTIVITY_TYPE:
      return prefixed('if ', text(c.condition));
    case SWITCH_ACTIVITY_TYPE: {
      const on = text(c.on);
      if (on === undefined) return null;
      const cases = Array.isArray(c.cases) ? c.cases.length : 0;
      return `on ${on} · ${cases} ${cases === 1 ? 'case' : 'cases'}`;
    }
    case FAIL_ACTIVITY_TYPE:
      return text(c.message) ?? null;
    case SET_VARIABLE_ACTIVITY_TYPE:
    case APPEND_VARIABLE_ACTIVITY_TYPE: {
      // #1600 C12a — a Set variable's Operation; an unknown one summarises nothing.
      const op = variableWriteOp(node);
      if (op === undefined) return null;
      return assignment(c.variable, op === 'set' ? '=' : '+=', c.value);
    }
    case FILTER_ACTIVITY_TYPE: {
      const items = text(c.items);
      if (items === undefined) return null;
      return joined([items, prefixed('where ', text(c.predicate)) ?? undefined], ' ');
    }
    case WAIT_ACTIVITY_TYPE:
      return prefixed('wait ', duration(c.seconds));
    case WEBHOOK_ACTIVITY_TYPE:
      return prefixed('callback · timeout ', duration(c.timeoutSeconds));
    case EXECUTE_PIPELINE_ACTIVITY_TYPE:
      // Unreachable with a `call` blob (handled above); a doc without one has
      // not been pointed at a pipeline yet.
      return null;
    case FILE_READ_ACTIVITY_TYPE:
    case FILE_LIST_ACTIVITY_TYPE:
    case GET_METADATA_ACTIVITY_TYPE:
      return text(c.path) ?? null;
    case FILE_WRITE_ACTIVITY_TYPE:
      return prefixed('→ ', text(c.path));
    case FILE_DELETE_ACTIVITY_TYPE:
      return prefixed('delete ', text(c.path));
    case DELETE_ACTIVITY_TYPE: {
      // #1600 OR41 C9a — a folder's selection reads as path/wildcard.
      const path = text(c.path);
      if (c.pathType === 'file' || path === undefined) return prefixed('delete ', path);
      const wildcard = text(c.wildcard) ?? '*';
      return `delete ${path}/${wildcard}${c.recursive === true ? ' · subfolders' : ''}`;
    }
    case FILE_COPY_ACTIVITY_TYPE:
    case FILE_MOVE_ACTIVITY_TYPE:
      return arrow(text(c.source), text(c.dest));
    case COPY_ACTIVITY_TYPE: {
      const ids = node.datasetIds;
      if (ids === undefined) return null;
      const from = inlineSourceLabel(node) ?? dataset(ids.source, datasetName);
      const line = arrow(from, dataset(ids.sink, datasetName));
      // `append` is the default and says nothing; `overwrite` deletes, and a
      // destructive step should say so on its face.
      return line !== null && c.mode === 'overwrite' ? `${line} · overwrite` : line;
    }
    case COPY_FILES_ACTIVITY_TYPE: {
      // An empty sink folder is the connection's first allowed folder.
      const to = joined([text(c.sinkFolder), text(c.sinkFileName)], '/') ?? 'sink root';
      const line = arrow(text(c.sourcePath), to);
      // Keep is the default and says nothing; delete and move change the source.
      const after =
        c.afterCopy === 'delete' ? 'delete source' : c.afterCopy === 'move' ? 'move source' : null;
      return line !== null && after !== null ? `${line} · ${after}` : line;
    }
    case LOOKUP_ACTIVITY_TYPE:
      return prefixed(
        'from ',
        inlineSourceLabel(node) ?? dataset(node.datasetIds?.source, datasetName),
      );
    default:
      return null;
  }
}

/**
 * #1600 C1q — an inline source on the card: the `schema.table` of a table, or
 * "query" (a statement is too long for a card; the Source tab shows it).
 */
function inlineSourceLabel(node: Node): string | undefined {
  const inline = node.inlineDatasets?.source;
  if (inline === undefined) return undefined;
  if (inline.kind === 'query') return 'query';
  const { table, schema } = inline.config;
  const name = typeof table === 'string' ? table : '';
  return (typeof schema === 'string' ? `${schema}.${name}` : name) || undefined;
}

/** A small mark on a card for a policy that changes how the step runs. */
export interface ActivityBadge {
  key: 'inactive' | 'retry' | 'timeout' | 'secure';
  /** What is drawn — short, since the card is narrow. */
  text: string;
  /** The whole sentence: the accessible name and the tooltip. */
  label: string;
}

/**
 * #1394 OR3 — the policy knobs worth seeing without opening the node: retries, a
 * timeout, and secure input/output. The words match the Policy tab's.
 */
export function activityBadges(node: Node): ActivityBadge[] {
  const badges: ActivityBadge[] = [];
  // #1600 OR41 C0c — first, because it outranks every policy: a switched-off
  // step never runs. The mark is ADF's: "inactive" plus the outcome it records.
  if (isInactive(node)) {
    const markAs = inactiveMarkAs(node);
    const outcome = MARK_AS_TITLES[markAs] ?? markAs;
    badges.push({
      key: 'inactive',
      // The monitor's word for the same fact, so the card and the run agree.
      text: inactiveStatusLabel(markAs),
      label: `Inactive: never runs, and records ${outcome}`,
    });
  }
  const p = node.policy;
  if (p === undefined) return badges;
  if (p.retry !== undefined && p.retry > 0) {
    badges.push({
      key: 'retry',
      text: `↻ ${p.retry}`,
      label: `Retries up to ${p.retry} ${p.retry === 1 ? 'time' : 'times'}`,
    });
  }
  if (p.timeoutSeconds !== undefined) {
    const d = formatElapsed(p.timeoutSeconds * 1000);
    badges.push({ key: 'timeout', text: `⏱ ${d}`, label: `Times out after ${d}` });
  }
  const secure = [p.secureInput === true && 'input', p.secureOutput === true && 'output'].filter(
    (s): s is string => s !== false,
  );
  if (secure.length > 0) {
    badges.push({ key: 'secure', text: 'secure', label: `Secure ${secure.join(' and ')}` });
  }
  return badges;
}

/** A config value as one line of text, or `undefined` when there is nothing. */
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const line = s.trim().split('\n')[0]!.trim();
  return line === '' ? undefined : line;
}

/**
 * A duration field. These are `${}` expressions by rule (`validateWaitConfig`), so
 * a LITERAL is `${30}`: that reads as a duration, and anything else — a
 * reference, a function call — is shown as written.
 */
function duration(v: unknown): string | undefined {
  const s = text(v);
  const literal = s === undefined ? null : /^\$\{\s*(\d+)\s*\}$/.exec(s);
  return literal === null ? s : formatElapsed(Number(literal[1]) * 1000);
}

function dataset(id: string | undefined, name: (id: string) => string | undefined) {
  if (id === undefined) return undefined;
  // Either end may be a `${}` expression (dynamic routing), resolved at dispatch.
  return name(id) ?? (id.includes('${') ? id : 'a dataset');
}

function prefixed(prefix: string, s: string | undefined): string | null {
  return s === undefined ? null : `${prefix}${s}`;
}

function arrow(from: string | undefined, to: string | undefined): string | null {
  return from === undefined || to === undefined ? null : `${from} → ${to}`;
}

function assignment(variable: unknown, op: string, value: unknown): string | null {
  const name = text(variable);
  if (name === undefined) return null;
  // An empty string is a value (set it to ""), not an unset one.
  const v = value === '' ? '""' : text(value);
  return v === undefined ? name : `${name} ${op} ${v}`;
}

function joined(parts: (string | undefined)[], sep = ' · '): string | null {
  const present = parts.filter((p): p is string => p !== undefined);
  return present.length === 0 ? null : present.join(sep);
}

/**
 * #1394 OR3 — the dataset-name lookup `activitySummary` takes, from the
 * workspace's dataset list. One home for it: the authoring canvas and the run
 * canvas both build one.
 */
export function datasetNameLookup(
  datasets: readonly { id: string; name: string }[],
): (id: string) => string | undefined {
  const names = new Map(datasets.map((d) => [d.id, d.name]));
  return (id) => names.get(id);
}
