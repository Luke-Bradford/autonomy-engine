import type { Node } from '../schemas/pipeline.js';
import { getActivity } from './registry.js';
import {
  llmOutputSchemaSchema,
  llmStructuredOutputSurfaceSchema,
  lowerOutputSchema,
} from './llm-config.js';
import { AGENT_TASK_ACTIVITY_TYPE, LLM_CALL_ACTIVITY_TYPE } from './types.js';

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

/**
 * #2 L4a — DERIVE a structured `llm_call` node's `config.outputs` from its
 * `outputSchema` (the restricted subset). For every `llm_call` node in
 * `outputMode:'structured'` with a VALID `outputSchema`, this sets
 * `config.outputs` to the lowered `Output[]`. Run this BEFORE `lowerNodeOutputs`
 * in `createPipelineVersion`, so the generic catalog-default pass then sees a
 * present value and correctly skips (a structured node's contract is its schema,
 * not the `[text, stopReason]` default).
 *
 * ## The one deliberate exception to `lowerNodeOutputs`'s never-overwrite rule
 *
 * `lowerNodeOutputs` (above) NEVER overwrites a present `config.outputs` — that is
 * how it avoids masking a corrupt or author-authored contract. This helper does
 * the OPPOSITE for structured nodes: it OVERWRITES whatever is there. That is safe
 * precisely because a structured node's `config.outputs` is DERIVED, not authored:
 * there is no author override to protect, and no meaningful "corrupt contract" to
 * mask — the single source of truth is the `outputSchema`. In particular this is
 * what replaces a STALE catalog-default seed (`[text, stopReason]`, written
 * client-side by the web palette on node creation) once the author switches the
 * node to structured mode. A structured node arriving with an already-CORRUPT
 * incoming `config.outputs` is refused earlier (the first `StrictNodeSchema` parse
 * in `createPipelineVersion`, before any lowering runs), so overwrite never has to
 * reason about corruption.
 *
 * An INVALID `outputSchema` (fails the subset) is left UN-lowered: the node is
 * returned unchanged so its prior contract stands and the save-time validator
 * (`validateLlmCallOutput`) raises the readable diagnostic → the whole save is
 * refused (400), and no garbage-lowered contract ever persists. The
 * `llmStructuredOutputSurfaceSchema.safeParse(...).success` gate here is the SAME
 * subset check `validateLlmCallOutput` reports through, so "what lowers" and "what
 * saves" can never disagree.
 */
export function lowerLlmStructuredOutputs(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.type !== LLM_CALL_ACTIVITY_TYPE) return node;
    const surface = llmStructuredOutputSurfaceSchema.safeParse(node.config);
    // Not structured, or an invalid/absent schema: leave the node alone (a text
    // node is seeded by `lowerNodeOutputs`; an invalid schema is a save-time
    // diagnostic, not a lowering concern).
    if (!surface.success) return node;
    // `success` implies the coupling held, so `outputMode:'structured'` guarantees
    // a valid `outputSchema` is present — the explicit `=== undefined` guard states
    // that invariant to the type system rather than asserting it away with `!`.
    const { outputMode, outputSchema } = surface.data;
    if (outputMode !== 'structured' || outputSchema === undefined) return node;
    return {
      ...node,
      config: { ...node.config, outputs: lowerOutputSchema(outputSchema) },
    };
  });
}

/**
 * #2 L11b — DERIVE a structured `agent_task` node's `config.outputs` from its
 * `outputSchema`, the `agent_task` counterpart of `lowerLlmStructuredOutputs`.
 * `agent_task` has no `outputMode` flag: the PRESENCE of a valid `outputSchema` IS
 * the opt-in, so the gate is `llmOutputSchemaSchema.safeParse(config.outputSchema)`
 * directly (not the `{outputMode,outputSchema}` coupling surface `llm_call` needs).
 *
 * This gate is the SAME predicate `validateAgentTaskOutput` (`engine/params.ts`)
 * uses, so "what lowers" and "what saves" can never disagree (the SSOT invariant
 * `lowerLlmStructuredOutputs` documents): an ABSENT schema → left alone (seeded by
 * `lowerNodeOutputs` to the catalog default `[output, exitCode]`); an INVALID
 * schema → left UN-lowered so the prior contract stands and the save-time
 * diagnostic refuses the whole save; a VALID schema → OVERWRITE `config.outputs`
 * with the lowered rows (safe for the identical reason: a structured node's
 * contract is DERIVED, not authored). Run BEFORE `lowerNodeOutputs`.
 */
export function lowerAgentTaskStructuredOutputs(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.type !== AGENT_TASK_ACTIVITY_TYPE) return node;
    const raw = node.config['outputSchema'];
    if (raw === undefined) return node;
    const parsed = llmOutputSchemaSchema.safeParse(raw);
    if (!parsed.success) return node;
    return {
      ...node,
      config: { ...node.config, outputs: lowerOutputSchema(parsed.data) },
    };
  });
}
