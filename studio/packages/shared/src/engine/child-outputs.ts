import type { Node, PipelineVersion } from '../schemas/pipeline.js';
import type { RunState } from './types.js';

/**
 * #796 (P3b) — what a `call_pipeline` child run hands back to its parent, i.e.
 * the `outputs` on `call.returned`.
 *
 * The rule is deliberately the CONTAINER rule, one scope out: `mergeChildOutputs`
 * (`reduce.ts`) projects a `stage`/`loop`'s outputs by merging its declared
 * children's output maps in sorted id order, last-key-wins. A run's "children"
 * are its doc's nodes, so this merges `state.outputs[node.id]` over
 * `doc.nodes` in sorted id order, with each node's own output names merged
 * sorted. Same determinism, same collision rule, no second convention for an
 * operator to learn.
 *
 * Iterating `doc.nodes` rather than `Object.keys(state.outputs)` is the
 * load-bearing part, not a stylistic choice. `state.outputs` is keyed by node id
 * AND by parallel-`foreach` INSTANCE keys (`engine/instance-key.ts`), so a raw
 * key walk would hand the parent per-item internals of a loop body under names
 * the child pipeline never presents as its own. A doc-node walk sees exactly the
 * nodes an author drew.
 *
 * NOT filtered by the child's declared pipeline-level `outputs`. Those are
 * declaration-only today — `Output` is `{name, type, …}` with no value
 * expression, they are explicitly not `${}`-addressable
 * (`schemas/pipeline.ts`), and nothing in the codebase reads them — so
 * narrowing to them would either invent a name-matching binding rule no spec
 * defines, or (since every pipeline in existence declares none) return `{}`
 * from every call node and make the whole seam unobservable. When pipeline
 * outputs gain a real binding, THIS is the function that narrows to it.
 *
 * A `failure` child still projects (the findings loop — `call.returned`'s
 * schema says so): whatever the child managed to produce is real, and the
 * parent's failure edge is what decides whether it may be used.
 */
export function projectChildRunOutputs(
  doc: Pick<PipelineVersion, 'nodes'>,
  state: Pick<RunState, 'outputs'>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ids = doc.nodes.map((n: Node) => n.id).sort();
  for (const id of ids) {
    const nodeOutputs = state.outputs[id];
    if (nodeOutputs === undefined) continue;
    for (const name of Object.keys(nodeOutputs).sort()) out[name] = nodeOutputs[name];
  }
  return out;
}
