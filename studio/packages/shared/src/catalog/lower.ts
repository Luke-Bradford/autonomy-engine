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
 * ## What counts as "absent" — the helper's own, unconditional contract
 *
 * A node is seeded ONLY when `config.outputs` is LITERALLY MISSING
 * (`config['outputs'] === undefined`), and ANY present value is left exactly as
 * it is. This holds regardless of how the input was produced — it is the helper's
 * own guarantee, not a property borrowed from a caller: a present-but-EMPTY
 * `outputs: []` ("declares nothing") is preserved, a present declared contract is
 * the author's override and is preserved, and a present-but-CORRUPT `outputs` is
 * ALSO left untouched (never seeded over) — so this can never fail open by masking
 * a corrupt contract with a benign catalog default; the corrupt value stands for
 * `StrictNodeSchema`/the reducer's `outputContract` to reject downstream.
 *
 * A literal `=== undefined` check is used rather than `outputContract`
 * (`engine/outputs.ts`) so `catalog/` imports only schema TYPES from
 * `engine`/`schemas` (no runtime `catalog → engine` edge — those layers are
 * catalog-free by design). For the WRITE caller the literal check is exactly
 * `outputContract`'s `absent`, and the reason is an ordering that is easy to
 * misread. `createPipelineVersion` passes `parsed.nodes`, where `parsed` is the
 * output of `NewPipelineVersionSchema.parse` — and that schema's `nodes` field is
 * itself `z.array(StrictNodeSchema)`. So the nodes handed to this helper have
 * ALREADY been through `StrictNodeSchema` (which refuses a corrupt `invalid`
 * `outputs`) via that FIRST parse, before lowering — leaving only `absent`/
 * `declared`, so `=== undefined` selects precisely `absent`. (The `z.array(
 * StrictNodeSchema).parse(lowerNodeOutputs(...))` wrapper at the call site is a
 * SECOND, distinct pass: it re-validates the SEEDED configs AFTER lowering, per
 * F13a's strict-on-write invariant — not the pass this equivalence rests on.)
 * That equivalence is the caller's context; the "never overwrite a present value"
 * rule above is what keeps this safe even for a caller that has not parsed first.
 *
 * An UNKNOWN type (no catalog entry) and a `call_pipeline` node (carrying
 * `Node.call`) are left `absent` — an unknown type has no catalog default to
 * seed, and a call node's outputs come from the CHILD projection, never a catalog
 * template. The call-node skip is now EXPLICIT (`node.call !== undefined`): before
 * #4 A9 it happened only incidentally because `call_pipeline` was uncatalogued, but
 * A9 catalogues `execute_pipeline` (with `outputs:[]`), so an implicit skip would
 * seed `config.outputs = []` and flip the node's contract from `absent` (stores ALL
 * child outputs) to `declared []` (stores NONE) — silently dropping every child
 * output. The skip keys off `Node.call`, so it protects a call node of ANY type.
 *
 * ## Immutability
 *
 * The catalog's `outputs` are DEEP-COPIED into the node (`{ ...o }` per output):
 * the registry is module-level shared state, so handing out an alias would let a
 * later doc edit mutate the catalog for every other consumer.
 */
export function lowerNodeOutputs(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    // Any present value — declared, empty [], or even corrupt — is left as-is;
    // seeding only ever fills a LITERALLY absent key, never overwrites (see doc).
    if (node.config['outputs'] !== undefined) return node;
    // A call node's outputs come from the child projection, never a catalog
    // template — skip it EXPLICITLY (not via the uncatalogued escape hatch below,
    // which #4 A9's `execute_pipeline` entry no longer takes). See the class doc.
    if (node.call !== undefined) return node;
    const entry = getActivity(node.type);
    if (entry === undefined) return node; // unknown type — no default to seed
    return {
      ...node,
      config: { ...node.config, outputs: entry.outputs.map((o) => ({ ...o })) },
    };
  });
}
