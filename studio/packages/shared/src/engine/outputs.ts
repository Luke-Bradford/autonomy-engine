import {
  NodeOutputsFieldSchema,
  type Container,
  type Node,
  type OutputType,
} from '../schemas/pipeline.js';

/**
 * A node's declared output contract, read from `config.outputs`. This is the
 * SINGLE SOURCE OF TRUTH for a node's outputs, shared by:
 *  - the runtime reducer (`reduce.ts` `storeOutputs`/`validateOutputs`) — which
 *    keeps ONLY declared keys and type-checks them at `node.succeeded` time; and
 *  - static validation (`params.ts` `validateRefs`) — which rejects a
 *    `${nodes.X.output.NAME}` ref whose NAME the producer does not declare.
 * Keeping both paths on this one helper stops the two from ever disagreeing
 * about which output names a node produces.
 */
export type DeclaredOutput = { name: string; type: OutputType };

/**
 * What a node's `config.outputs` says — THREE distinct facts (#1 F13a):
 *
 *  - `absent`   — no `outputs` key. "No contract": the reducer stores the
 *                 executor's whole payload and static validation enforces no
 *                 names. Permissive BY DESIGN — an unconfigured node is not an
 *                 error.
 *  - `invalid`  — an `outputs` key that is CORRUPT (not an array of
 *                 `{name,type}`, a duplicate name, an unaddressable name).
 *  - `declared` — a valid contract.
 *
 * `invalid` and `absent` were ONE `null` before F13a, and that conflation was a
 * silent FAIL-OPEN: a single typo (`type: 'strng'`) disabled output type
 * checking, key filtering AND ref-name checking for that node, with no
 * diagnostic anywhere. A corrupt contract must never be read as "no contract" —
 * the same fail-safe rule the merge gate lives by (an API failure is never
 * "green"). The reducer therefore FAILS a node whose contract is `invalid`.
 *
 * `StrictNodeSchema` refuses `invalid` on the WRITE path, so a doc saved by this
 * build cannot carry one. This reader still handles it because the READ path is
 * deliberately tolerant (a corrupt row must stay loadable to be repaired), so
 * `invalid` remains reachable at run time for a row written before F13a.
 */
export type OutputContract =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'declared'; outputs: DeclaredOutput[] };

/**
 * A contract that is SAFE to store outputs against — i.e. one that has been
 * checked. `storeOutputs` takes this, not a bare `OutputContract`, so "never
 * store against a corrupt contract" is enforced by the TYPE rather than by a
 * comment asking the caller to validate first. The pre-F13a code had exactly
 * that comment-enforced shape, and it is how the original fail-open survived.
 */
export type CheckedContract = Exclude<OutputContract, { kind: 'invalid' }>;

/**
 * Read a node's output contract. Parses against `NodeOutputsFieldSchema` — the
 * same schema the write path enforces — so "a valid contract" means exactly one
 * thing in this engine.
 */
export function outputContract(node: Node): OutputContract {
  const parsed = NodeOutputsFieldSchema.safeParse(node.config['outputs']);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    return { kind: 'invalid', reason };
  }
  return parsed.data === undefined
    ? { kind: 'absent' }
    : { kind: 'declared', outputs: parsed.data };
}

/**
 * A CONTAINER's output contract for the static ref-checker (#567). A `foreach`
 * aggregates its body into the SINGLE output `results` — an opaque `json` array
 * (element shape is run-time-only, #6 E4) — the exact shape the reducer projects
 * (`projectContainerOutputs`: `{ results }`). A `loop`/`stage` projects its LAST
 * round's MERGED child outputs, a DYNAMIC shape with no fixed contract, so its
 * name-check is skipped (`absent`) while the container id stays a first-class
 * producer for dominance. Lives beside `outputContract` so both producer kinds —
 * node and container — read from this one module (this file's SSOT reason).
 */
export function containerOutputContract(c: Pick<Container, 'kind'>): OutputContract {
  return c.kind === 'foreach'
    ? { kind: 'declared', outputs: [{ name: 'results', type: 'json' }] }
    : { kind: 'absent' };
}

// `declaredOutputNames` (a names-only `Set` view) was REMOVED at #6 E6: the
// static checker now needs each output's TYPE as well as its name, so it reads
// the contract directly and `ScanScope.outputsById` carries the full
// `{name,type}`. A names-only view would be a second answer to "what does this
// node declare?" — exactly the drift this module's SSOT rule exists to prevent.
//
// `declaredOutputs` (which returned `DeclaredOutput[] | null`) was REPLACED by
// `outputContract` at #1 F13a: that `null` collapsed "absent" and "malformed"
// into one value, which is precisely what let a corrupt contract fail open.
