import {
  AGENT_TASK_ACTIVITY_TYPE,
  APPEND_VARIABLE_ACTIVITY_TYPE,
  callDetaches,
  COPY_ACTIVITY_TYPE,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  SET_VARIABLE_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
  type Node,
} from '@autonomy-studio/shared';
import { formatElapsed } from '../runs/format';

/**
 * #1394 OR3 — the one line a card shows under its name, saying what THIS step
 * does: `orders.csv → orders table`, `GET api.example.com/v1/orders`, `wait 30s`.
 *
 * The name says which step it is ("Copy Data 2") and the glyph says what kind; this
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
    case 'http_request': {
      const url = text(c.url);
      if (url === undefined) return null;
      const method = (text(c.method) ?? 'GET').toUpperCase();
      return `${method} ${url
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^[^/@]*@/, '')
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
      return assignment(c.variable, '=', c.value);
    case APPEND_VARIABLE_ACTIVITY_TYPE:
      return assignment(c.variable, '+=', c.value);
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
      return text(c.path) ?? null;
    case FILE_WRITE_ACTIVITY_TYPE:
      return prefixed('→ ', text(c.path));
    case FILE_DELETE_ACTIVITY_TYPE:
      return prefixed('delete ', text(c.path));
    case FILE_COPY_ACTIVITY_TYPE:
    case FILE_MOVE_ACTIVITY_TYPE:
      return arrow(text(c.source), text(c.dest));
    case COPY_ACTIVITY_TYPE: {
      const ids = node.datasetIds;
      if (ids === undefined) return null;
      const line = arrow(dataset(ids.source, datasetName), dataset(ids.sink, datasetName));
      // `append` is the default and says nothing; `overwrite` deletes, and a
      // destructive step should say so on its face.
      return line !== null && c.mode === 'overwrite' ? `${line} · overwrite` : line;
    }
    case LOOKUP_ACTIVITY_TYPE:
      return prefixed('from ', dataset(node.datasetIds?.source, datasetName));
    default:
      return null;
  }
}

/** A small mark on a card for a policy that changes how the step runs. */
export interface ActivityBadge {
  key: 'retry' | 'timeout' | 'secure';
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
  const p = node.policy;
  if (p === undefined) return [];
  const badges: ActivityBadge[] = [];
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
