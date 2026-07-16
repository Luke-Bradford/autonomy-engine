import type { Node } from '../schemas/pipeline.js';
import { getActivity } from './registry.js';

/**
 * #1 F13b — LOWER the catalog's canonical `outputs` into a node's
 * `config.outputs` when the node declares none. This is what makes
 * `Node.config.outputs` an OVERRIDE (F13's word) rather than the only source of
 * a contract: the catalog `outputs` is the DEFAULT, seeded here at save time.
 *
 * ## Why this exists (the defect it closes)
 *
 * The catalog `outputs` is inert metadata (`ActivityCatalogEntry.outputs` — "the
 * template the UI seeds a node's `config.outputs` from"), and the ONLY thing that
 * did the seeding was the web palette (`canvasStore.addNode`). So a node created
 * via the API, an import, the CLI, or a test carried NO contract: `outputContract`
 * → `absent` → the reducer stores the executor's whole payload unchecked and
 * static `validateRefs` name-checks nothing. Same activity type, two runtime
 * contracts, decided by which client made the node. `createPipelineVersion` (the
 * one write choke point) calls this so EVERY stored version carries its contract,
 * regardless of client.
 *
 * ## What counts as "absent"
 *
 * A node is seeded only when `config.outputs` is LITERALLY MISSING. This is the
 * `absent` case of `outputContract` (`engine/outputs.ts`), whose SSOT definition
 * is `NodeOutputsFieldSchema.safeParse(config.outputs).data === undefined` — which
 * holds iff the key is absent. A literal `config['outputs'] === undefined` check
 * is used here rather than `outputContract` so `catalog/` imports only schema
 * TYPES from `engine`/`schemas` (no runtime `catalog → engine` edge — the layering
 * `engine`/`schemas` are catalog-free by design). The two agree because this runs
 * AFTER the write-path `StrictNodeSchema` parse, which has already REFUSED any
 * corrupt (`invalid`) `outputs` — so only `absent`/`declared` reach here and the
 * literal check cannot mis-fire. A present-but-empty `outputs: []` is `declared`
 * ("declares nothing"), NOT absent, and is deliberately left untouched; a present
 * declared contract is the author's override and is never overwritten.
 *
 * An UNKNOWN type (no catalog entry) and an uncatalogued `call_pipeline` node are
 * left `absent` — there is no catalog default to seed, and a call node's outputs
 * come from the child projection, never a catalog template.
 *
 * ## Immutability
 *
 * The catalog's `outputs` are DEEP-COPIED into the node (`{ ...o }` per output):
 * the registry is module-level shared state, so handing out an alias would let a
 * later doc edit mutate the catalog for every other consumer.
 */
export function lowerNodeOutputs(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.config['outputs'] !== undefined) return node; // present (declared/[]) — never overwrite
    const entry = getActivity(node.type);
    if (entry === undefined) return node; // unknown type / call_pipeline — no default to seed
    return {
      ...node,
      config: { ...node.config, outputs: entry.outputs.map((o) => ({ ...o })) },
    };
  });
}
