/**
 * #1573 OR38 — the editor's Code view: the whole pipeline doc as JSON, and the
 * check that decides what of a typed doc the canvas can take.
 *
 * Two tiers, because the canvas already holds some refusals and not others:
 *
 * - **Blocking** — Apply stays off. Text that is not JSON; anything the save's
 *   write schema (`PipelineDraftBodySchema`) refuses; a key that schema would
 *   silently DROP (a typo'd field must not vanish on Apply — the form can never
 *   author one, so the JSON must not either); and what the canvas cannot draw:
 *   an unknown activity type, a duplicate id, and an edge to nothing (React Flow
 *   drops such an edge, so the author would meet a badge over an edge they can
 *   neither see nor delete — the trap `loadVersion` repairs on open).
 * - **Not blocking** — what `validateCanvas` reports: the same badges the canvas
 *   shows for a draft built in the form. Apply takes them, and the badges then
 *   show them, so a draft that already carries one can still be edited here.
 *
 * Every problem is located on a line of the text where it can be: a Zod issue
 * by its path, an issue that names a node, edge or container by that element.
 */
import { PipelineDraftBodySchema, getActivity, type GlobalRead } from '@autonomy-studio/shared';
import { lineOfPath, positionOf, scanJson, type JsonPathStep } from '../../lib/json/jsonText';
import { workingDocOf, type WorkingDoc, type WorkingDocSource } from './canvasStore';
import { validateCanvas } from './canvasDoc';
import { edgeEndpointIds } from './connectRules';
import { issueSubject, readableIssue } from './containerRules';

/**
 * The doc's fields, in the order the view lays them out: what the pipeline is,
 * its inputs and state, then the graph. Exactly the version body a save sends,
 * less its CAS basis — nothing the form sets is missing, and nothing else is
 * there. (`concurrency` is the pipeline row's, not a version's, so it is not.)
 */
export const CODE_VIEW_KEYS = [
  'description',
  'annotations',
  'params',
  'variables',
  'outputs',
  'nodes',
  'edges',
  'containers',
] as const satisfies readonly (keyof WorkingDoc)[];

/** The working doc as the view shows it: formatted, keys in `CODE_VIEW_KEYS` order. */
export function codeViewText(doc: WorkingDoc): string {
  return JSON.stringify(Object.fromEntries(CODE_VIEW_KEYS.map((k) => [k, doc[k]])), null, 2);
}

export interface CodeProblem {
  readonly message: string;
  /** 1-based line in the text, or `null` when the problem has no one place. */
  readonly line: number | null;
  /** Whether it keeps Apply off (see the module doc). */
  readonly blocking: boolean;
}

export interface CodeCheck {
  /** The doc to apply; `null` while any problem blocks. */
  readonly doc: WorkingDocSource | null;
  readonly problems: readonly CodeProblem[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pathText = (path: readonly PropertyKey[]): string =>
  path
    .map((s) => (typeof s === 'number' ? `[${s}]` : `.${String(s)}`))
    .join('')
    .replace(/^\./, '');

/**
 * The paths of keys `raw` holds and `parsed` does not: what a non-strict schema
 * strips. Walked only where both sides are the same shape — anywhere the schema
 * rewrote a value, the schema has already said what it accepts.
 */
function droppedKeys(raw: Json, parsed: unknown, path: JsonPathStep[] = []): JsonPathStep[][] {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed) || parsed.length !== raw.length) return [];
    return raw.flatMap((item, i) => droppedKeys(item, parsed[i], [...path, i]));
  }
  if (!isObject(raw) || !isObject(parsed)) return [];
  return Object.entries(raw).flatMap(([key, value]) =>
    key in parsed ? droppedKeys(value, parsed[key], [...path, key]) : [[...path, key]],
  );
}

/** Each id that appears more than once, with the index of every repeat after the first. */
function repeats(ids: readonly string[]): { id: string; index: number }[] {
  const seen = new Set<string>();
  return ids.flatMap((id, index) => {
    if (seen.has(id)) return [{ id, index }];
    seen.add(id);
    return [];
  });
}

export function checkCodeText(text: string, globals: readonly GlobalRead[]): CodeCheck {
  const blocked = (problems: CodeProblem[]): CodeCheck => ({ doc: null, problems });
  const at = (path: readonly JsonPathStep[]) => lineOfPath(text, path);

  const scan = scanJson(text);
  if (!scan.ok) {
    const { line } = positionOf(text, scan.offset);
    return blocked([{ message: `not valid JSON: ${scan.reason}`, line, blocking: true }]);
  }
  const raw = JSON.parse(text) as Json;
  if (!isObject(raw)) {
    return blocked([{ message: 'the pipeline must be a JSON object', line: 1, blocking: true }]);
  }

  const known = new Set<string>(CODE_VIEW_KEYS);
  const unknownTop = Object.keys(raw)
    .filter((k) => !known.has(k))
    .map((k) => ({ message: `${k}: not a field of the pipeline`, line: at([k]), blocking: true }));
  // Only the doc's own keys reach the schema: it also takes `catalogVersion`,
  // which is the server's to stamp, not the author's to type.
  const picked = Object.fromEntries(Object.entries(raw).filter(([k]) => known.has(k)));
  const parsed = PipelineDraftBodySchema.safeParse(picked);
  if (!parsed.success) {
    return blocked([
      ...unknownTop,
      ...parsed.error.issues.map((issue) => {
        const path = issue.path.filter(
          (s): s is JsonPathStep => typeof s === 'string' || typeof s === 'number',
        );
        const where = pathText(issue.path);
        return {
          message: where === '' ? issue.message : `${where}: ${issue.message}`,
          line: at(path),
          blocking: true,
        };
      }),
    ]);
  }
  const dropped = droppedKeys(picked as Json, parsed.data).map((path) => ({
    message: `${pathText(path)}: not a field here`,
    line: at(path),
    blocking: true,
  }));
  if (unknownTop.length > 0 || dropped.length > 0) return blocked([...unknownTop, ...dropped]);

  // The rest is judged on the doc as the canvas would hold it: lowered, as
  // `loadVersion` lowers a doc on open, so these problems are exactly the
  // badges Apply would leave on the canvas.
  const source: WorkingDocSource = {
    description: parsed.data.description,
    annotations: parsed.data.annotations,
    params: parsed.data.params,
    variables: parsed.data.variables,
    outputs: parsed.data.outputs,
    nodes: parsed.data.nodes,
    edges: parsed.data.edges,
    containers: parsed.data.containers,
  };
  const doc = workingDocOf(source);
  const structural: CodeProblem[] = [];
  doc.nodes.forEach((node, i) => {
    if (node.call !== undefined || getActivity(node.type) !== undefined) return;
    structural.push({
      message: `node '${node.id}': type: unknown activity type '${node.type}'`,
      line: at(['nodes', i, 'type']),
      blocking: true,
    });
  });
  for (const { id, index } of repeats(doc.nodes.map((n) => n.id))) {
    structural.push({
      message: `node id '${id}' is used twice`,
      line: at(['nodes', index, 'id']),
      blocking: true,
    });
  }
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  doc.containers.forEach((c, i) => {
    if (nodeIds.has(c.id)) {
      structural.push({
        message: `container id '${c.id}' is also a node's id`,
        line: at(['containers', i, 'id']),
        blocking: true,
      });
    }
  });
  for (const { id, index } of repeats(doc.containers.map((c) => c.id))) {
    structural.push({
      message: `container id '${id}' is used twice`,
      line: at(['containers', index, 'id']),
      blocking: true,
    });
  }
  for (const { id, index } of repeats(source.edges.map((e) => e.id))) {
    structural.push({
      message: `edge id '${id}' is used twice`,
      line: at(['edges', index, 'id']),
      blocking: true,
    });
  }
  // Against the TYPED edges, not `doc.edges`: `workingDocOf` drops an edge to
  // nothing, which on open repairs a stored row, and here would hide the typo.
  const endpoints = edgeEndpointIds(doc.nodes, doc.containers);
  source.edges.forEach((e, i) => {
    for (const end of ['from', 'to'] as const) {
      if (endpoints.has(e[end])) continue;
      structural.push({
        message: `edge '${e.id}': ${end}: '${e[end]}' is not a node or container in this pipeline`,
        line: at(['edges', i, end]),
        blocking: true,
      });
    }
  });
  if (structural.length > 0) return blocked(structural);

  const indexOf = {
    node: new Map(doc.nodes.map((n, i) => [n.id, ['nodes', i] as JsonPathStep[]])),
    edge: new Map(doc.edges.map((e, i) => [e.id, ['edges', i] as JsonPathStep[]])),
    container: new Map(doc.containers.map((c, i) => [c.id, ['containers', i] as JsonPathStep[]])),
  };
  const badges = validateCanvas(
    doc.nodes,
    doc.edges,
    doc.containers,
    doc.params,
    doc.variables,
    globals,
  ).map((issue): CodeProblem => {
    const subject = issueSubject(issue);
    const path = subject === undefined ? undefined : indexOf[subject.kind].get(subject.id);
    return {
      message: readableIssue(issue, doc.nodes, doc.edges, doc.containers),
      line: path === undefined ? null : at(path),
      blocking: false,
    };
  });
  return { doc: source, problems: badges };
}
