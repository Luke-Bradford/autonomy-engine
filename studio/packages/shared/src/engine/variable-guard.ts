// #844 V4 — the pipeline-variable DETERMINISM GUARD (spec V-D6) and the
// rerun-from-failed write carry (V-D7). V5 wired both: the guard runs inside
// `validatePipelineDoc` (`validate-pipeline.ts`) and the carry in the server's
// rerun-from-failed reseed.
import { APPEND_VARIABLE_ACTIVITY_TYPE, SET_VARIABLE_ACTIVITY_TYPE } from '../catalog/types.js';
import { docNodeIdOf } from './instance-key.js';
import {
  backEdgeResetBody,
  containerJoin,
  containerMembership,
  declaredBranchesOf,
  isParallelForeach,
  nodeDescendants,
  nodeJoin,
  partitionReadiness,
  settledRawOf,
  type ValidatedDoc,
  type VariableReads,
} from './params.js';
import type { ReseedFrontier } from './reduce.js';
import type { Container, Edge, EngineEvent, VariableWrite } from './types.js';

/**
 * The save-time determinism guard (spec V-D6): a pipeline's final variable
 * values must not depend on which of two concurrently runnable nodes finishes
 * first. The event log would still REPLAY such a run exactly; what the guard
 * protects is the outcome.
 *
 * For each variable, its ACCESSORS are its writers (the `set`/`append` nodes
 * naming it) and its readers (`reads`, the validators' own scan). Every pair
 * that includes a writer must be ORDERED (one must be terminal before the other
 * dispatches) or EXCLUSIVE (they sit under disjoint outcomes of one decision),
 * compared in the scope they share after lifting a container child to its
 * container. Every error names the two accessors and the variable — the edge
 * the author needs to add.
 *
 * CONSERVATIVE ON PURPOSE: a false reject names two nodes to connect; a false
 * accept is a run whose result depends on timing.
 *
 * `reads` is REQUIRED, and is the full reader list only for a doc the two
 * validators accept ({@link variableReadsOf}). A default computed here would
 * hand back `[]` for a refused doc whose scan never reached a read — a fail-open
 * answer. The guard is meaningful only beside the validators, which is how V5
 * wires it.
 *
 * A `set`/`append` node whose `variable` is not a literal name is refused here
 * rather than skipped: skipping it would leave a writer the guard never checks.
 */
export function variableGuardErrors(doc: ValidatedDoc, reads: VariableReads): string[] {
  // No writer, nothing to guard — and this runs on every save and every canvas
  // validation, so an ordinary doc pays for none of the analysis below.
  if (!doc.nodes.some((n) => isVariableWriter(n.type))) return [];
  const containers = doc.containers ?? [];
  const containerById = new Map(containers.map((c) => [c.id, c]));
  const owner = containerMembership(containers).owner;
  const settled = settledRawOf(doc);
  const part = partitionReadiness(doc, containers, owner);
  const req = outcomeConstraints(doc, containerById, part);

  // Back-edge bodies, from the reducer's own reset-body SSOT. Only a BARE
  // (node-targeted) body can straddle a pair: a container-targeted back-edge must
  // have its source inside the container (`validateDoc`'s `resetsOwnSource`), so
  // its body is every child of that container — nothing in its scope is outside
  // it, and everything outside the container is ordered around it by lifting
  // (the container moves on only after its last bounce).
  const nodeIds = doc.nodes.map((n) => n.id);
  const descendants = nodeDescendants(doc);
  const bodies = part.backEdges.map((be) => ({
    edge: be,
    body: new Set(backEdgeResetBody(be, nodeIds, descendants, containerById)),
  }));
  /** The first bare body holding `p` but not `q` — `p` can re-run after `q` has run. */
  const bodyAlone = (p: string, q: string) =>
    bodies.find(({ body }) => body.has(p) && !body.has(q));

  const accessors = new Map<string, { writers: Set<string>; readers: Set<string> }>();
  const entry = (name: string) => {
    let a = accessors.get(name);
    if (a === undefined) {
      a = { writers: new Set(), readers: new Set() };
      accessors.set(name, a);
    }
    return a;
  };
  const errors: string[] = [];
  for (const n of doc.nodes) {
    if (!isVariableWriter(n.type)) continue;
    const v = n.config['variable'];
    if (typeof v !== 'string' || v === '' || v.includes('${')) {
      errors.push(
        `node '${n.id}' (${n.type}): 'variable' must be a literal variable name, or the ` +
          `determinism guard cannot tell what it writes`,
      );
      continue;
    }
    entry(v).writers.add(n.id);
    // D2's settled no-self-reference rule (ADF parity; spec V-D4 and open
    // question 1), extended from `set` to `append`, where an array appending
    // itself is the same hazard. Read off the validators' own scan (`reads`), so
    // every `${}` site that can hold the read is covered.
    if (reads.get(n.id)?.has(v) === true) {
      errors.push(
        `node '${n.id}' (${n.type}) reads variable '${v}', which it writes — a variable ` +
          'cannot reference itself; copy it into a second variable first',
      );
    }
  }
  for (const [id, names] of reads) for (const name of names) entry(name).readers.add(id);

  for (const name of [...accessors.keys()].sort()) {
    const { writers, readers } = accessors.get(name)!;
    if (writers.size === 0) continue;
    const describe = (id: string): string => {
      const role = writers.has(id) ? 'writes' : 'reads';
      const kind = containerById.has(id) ? 'container' : 'node';
      const inside = owner.get(id);
      return inside === undefined
        ? `${kind} '${id}' ${role} it`
        : `${kind} '${id}' (in container '${inside}') ${role} it`;
    };

    for (const w of [...writers].sort()) {
      const c = containerById.get(owner.get(w) ?? '');
      // `allowNondeterministicVars` lifts exactly this rule and nothing else: the
      // author has accepted that item instances race (spec V-D6).
      if (c !== undefined && isParallelForeach(c) && c.allowNondeterministicVars !== true) {
        errors.push(
          `variable '${name}': ${describe(w)} inside parallel foreach '${c.id}' ` +
            `(batchCount >= 2), where its item instances race — make the foreach sequential, ` +
            'or set allowNondeterministicVars on it to accept a timing-dependent result',
        );
      }
    }

    const ids = [...new Set([...writers, ...readers])].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (!writers.has(a) && !writers.has(b)) continue;
        const sa = owner.get(a);
        const sb = owner.get(b);
        // A container's own field against a child of that container: `items` is
        // evaluated once, before any child (`enterForeachStep`); `exitWhen` only
        // once every child of the round is terminal (`stepContainers`).
        if (sb === a || sa === b) continue;
        // Lift across scopes: containers do not nest, so a child stands in for
        // its container and the pair is compared at top level.
        const x = sa === sb ? a : (sa ?? a);
        const y = sa === sb ? b : (sb ?? b);
        const lifted = x !== a || y !== b;

        // A writer in a bare back-edge body is re-run by every bounce, so each
        // accessor of its variable must bounce with it (spec V-D6).
        const writerBody =
          (writers.has(x) && bodyAlone(x, y)) || (writers.has(y) && bodyAlone(y, x));
        if (writerBody) {
          const [inside, outside] = writerBody.body.has(x) ? [a, b] : [b, a];
          errors.push(
            `variable '${name}': ${describe(inside)} inside the body of back-edge ` +
              `'${writerBody.edge.from}'→'${writerBody.edge.to}', but ${describe(outside)} ` +
              `outside that body — a bounce re-runs the write around it`,
          );
          continue;
        }

        // ORDERED — must precede, never "may precede" (`settledRaw`). `p` before
        // `q` does not hold if a bounce can re-run `p` after `q`: a bounce fires
        // on its source's outcome while that source's forward edges release what
        // lies downstream, so a body READER can run again beside a later writer.
        const before = (p: string, q: string) =>
          (settled.get(q)?.has(p) ?? false) && bodyAlone(p, q) === undefined;
        if (before(x, y) || before(y, x)) continue;

        // EXCLUSIVE — a decision decides once per round. One inside a bare body
        // decides again on every bounce, so it separates only a pair that
        // bounces with it.
        const cx = req.get(x);
        const cy = req.get(y);
        let exclusive = false;
        if (cx !== undefined && cy !== undefined) {
          for (const [n, ox] of cx) {
            if (n === x || n === y) continue;
            const oy = cy.get(n);
            if (oy === undefined || [...ox].some((o) => oy.has(o))) continue;
            if (bodies.some(({ body }) => body.has(n) && !(body.has(x) && body.has(y)))) continue;
            exclusive = true;
            break;
          }
        }
        if (exclusive) continue;

        errors.push(
          `variable '${name}': ${describe(a)} and ${describe(b)}, and they can run in either ` +
            `order, so its value would depend on timing — ` +
            (lifted ? `order '${x}' and '${y}' with an edge` : `add an edge between them`) +
            `, or put them on different outcomes of one decision`,
        );
      }
    }
  }
  return errors;
}

/**
 * What an entity DISPATCHING implies about the outcomes of the decisions before
 * it, within one round of its scope: `id → (decision id → the outcomes that
 * decision can have had)`. An absent decision is unconstrained.
 *
 * The same must-analysis shape as `computeGraph`'s `settled`, over the reducer's
 * own readiness rule (`computeReadiness`): conditions on ONE predecessor OR
 * together, predecessors AND under `all` and OR under `any`. An edge that fires
 * says its source reached an outcome it accepts, AND — because that source ran —
 * everything the source's own dispatch implied. A `skipped` edge says only that
 * its source was skipped: a skipped node never dispatched, so nothing upstream
 * of it holds (the same inversion `settled` applies).
 *
 * Outcomes are atomic: `S`/`F`/`K` (success / failure / skipped), and for an
 * `if`/`switch` one `B:<label>` per branch instead of `S` — a branching node
 * terminates `success` whichever branch it took, so its `success` edge fires
 * beside EVERY branch and is the union of them.
 *
 * An entity the topological pass never reaches (a forward cycle `validateDoc`
 * refuses) keeps no constraints, which can only under-claim exclusivity.
 */
function outcomeConstraints(
  doc: Pick<ValidatedDoc, 'nodes'>,
  containerById: Map<string, Container>,
  part: ReturnType<typeof partitionReadiness>,
): Map<string, Map<string, Set<string>>> {
  type Constraints = Map<string, Set<string>>;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const incomingOf = (id: string): Edge[] =>
    part.topIncoming.get(id) ?? part.childIncoming.get(id) ?? [];

  // Every branch label a branching node can take: declared, plus any an edge
  // names (a stray label is refused by `validateDoc`, and naming it here keeps
  // `success` a superset of every branch edge regardless).
  const branchesOf = new Map<string, Set<string>>();
  for (const id of part.endpointIds) {
    const n = nodeById.get(id);
    const declared = n === undefined ? undefined : declaredBranchesOf(n);
    if (declared !== undefined) branchesOf.set(id, new Set(declared));
  }
  for (const id of part.endpointIds) {
    for (const e of incomingOf(id)) {
      if (e.on === 'branch') branchesOf.get(e.from)?.add(e.branch);
    }
  }
  const outcomesOf = (e: Edge): Set<string> => {
    if (e.on === 'skipped') return new Set(['K']);
    if (e.on === 'branch') return new Set([`B:${e.branch}`]);
    const branches = branchesOf.get(e.from);
    const ok = branches === undefined ? ['S'] : [...branches].map((b) => `B:${b}`);
    if (e.on === 'success') return new Set(ok);
    if (e.on === 'failure') return new Set(['F']);
    return new Set([...ok, 'F']); // completion
  };

  const and = (a: Constraints, b: Constraints): Constraints => {
    const out = new Map(a);
    for (const [k, s] of b) {
      const prev = out.get(k);
      out.set(k, prev === undefined ? s : new Set([...prev].filter((o) => s.has(o))));
    }
    return out;
  };
  const or = (list: Constraints[]): Constraints => {
    const [first, ...rest] = list;
    const out: Constraints = new Map();
    if (first === undefined) return out;
    for (const [k, s] of first) {
      if (rest.every((c) => c.has(k))) {
        out.set(k, new Set([...s, ...rest.flatMap((c) => [...c.get(k)!])]));
      }
    }
    return out;
  };

  const req = new Map<string, Constraints>();
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const id of part.endpointIds) {
    indeg.set(id, incomingOf(id).length);
    for (const e of incomingOf(id)) {
      const list = succ.get(e.from);
      if (list === undefined) succ.set(e.from, [e.to]);
      else list.push(e.to);
    }
  }
  const queue = [...part.endpointIds].filter((id) => indeg.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const byPred = new Map<string, Constraints[]>();
    for (const e of incomingOf(id)) {
      const fired: Constraints =
        e.on === 'skipped'
          ? new Map([[e.from, outcomesOf(e)]])
          : and(req.get(e.from) ?? new Map(), new Map([[e.from, outcomesOf(e)]]));
      const group = byPred.get(e.from);
      if (group === undefined) byPred.set(e.from, [fired]);
      else group.push(fired);
    }
    const groups = [...byPred.values()].map(or);
    const c = containerById.get(id);
    const join = c !== undefined ? containerJoin(c) : nodeJoin(nodeById.get(id) ?? { config: {} });
    req.set(id, groups.length === 0 ? new Map() : join === 'all' ? groups.reduce(and) : or(groups));
    for (const to of succ.get(id) ?? []) {
      const d = indeg.get(to)! - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  return req;
}

/**
 * The ids whose writes a rerun copies: the frontier plus the children of every
 * copied container — bodies travel in `copiedContainers`, never in `frontier`.
 */
export function copiedIdsOf(
  frontier: Pick<ReseedFrontier, 'frontier' | 'copiedContainers'>,
  containers: readonly Container[],
): Set<string> {
  const ids = new Set(frontier.frontier);
  for (const c of containers) {
    if (Object.prototype.hasOwnProperty.call(frontier.copiedContainers, c.id)) {
      for (const ch of c.children) ids.add(ch);
    }
  }
  return ids;
}

/**
 * The writes a rerun of the source run carries (spec V-D7): exactly the COPIED
 * nodes' writes, in the source run's log order — never a "before the failure"
 * seq cut, which has no single meaning under the drain model. A list, not a
 * final map, because a map cannot be filtered again.
 *
 *  - A rerun of a rerun: nodes the source run itself copied never ran there, so
 *    their writes arrived in its own `run.reseeded`. That event precedes every
 *    write in the source log, so reading the log in order puts the carried writes
 *    first, as they logically are. Both halves are filtered to `copiedIds`.
 *  - An instance key (`<id>@<i>`) is filtered by its doc node.
 *  - One attempt writes once: a duplicate event for the same `(nodeId,
 *    attemptId)` — a driver re-append after a crash — is taken once, first wins,
 *    as the fold's attempt/status guard applies it. V5's fold is the authority;
 *    its tests pin that this list equals what the fold applied.
 */
export function copiedVariableWritesOf(
  sourceEvents: readonly EngineEvent[],
  copiedIds: ReadonlySet<string>,
): VariableWrite[] {
  const out: VariableWrite[] = [];
  const seen = new Set<string>();
  const keep = (nodeId: string) => copiedIds.has(docNodeIdOf(nodeId));
  for (const e of sourceEvents) {
    if (e.type === 'run.reseeded') {
      for (const w of e.copiedVariableWrites ?? []) {
        if (keep(w.nodeId)) out.push({ nodeId: w.nodeId, op: w.op, name: w.name, value: w.value });
      }
      continue;
    }
    if (e.type !== 'variable.set' && e.type !== 'variable.append') continue;
    if (!keep(e.nodeId)) continue;
    const key = `${e.nodeId}\u0000${e.attemptId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      nodeId: e.nodeId,
      op: e.type === 'variable.set' ? 'set' : 'append',
      name: e.name,
      value: e.value,
    });
  }
  return out;
}

/** A `set_variable`/`append_variable` node type — the guard's writers. */
function isVariableWriter(type: string): boolean {
  return type === SET_VARIABLE_ACTIVITY_TYPE || type === APPEND_VARIABLE_ACTIVITY_TYPE;
}
