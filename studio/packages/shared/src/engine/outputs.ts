import {
  NodeOutputsFieldSchema,
  type Container,
  type Node,
  type OutputType,
} from '../schemas/pipeline.js';

/**
 * A node's declared output contract, read from `config.outputs`. This module is
 * the SINGLE SOURCE OF TRUTH for a node's outputs — `outputContract` +
 * `validateOutputs`/`storeOutputs` (used by the runtime reducer's `node.succeeded`
 * fold and by the #4 A16 webhook-callback boundary `checkInboundOutputs`) + the
 * static `validateRefs` (`params.ts`, which rejects a `${nodes.X.output.NAME}` ref
 * whose NAME the producer does not declare) all read this one contract. Keeping
 * every path on this module stops them from ever disagreeing about which output
 * names a node produces.
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

/**
 * Store ONLY a node's DECLARED output keys, dropping anything else the producer
 * carried (an undeclared key must never become refable). A node with no
 * declared outputs has no contract to enforce → its whole payload passes.
 *
 * Takes a `CheckedContract`, so an `invalid` one cannot reach the
 * whole-payload branch: `validateOutputs` errors first and terminalizes the
 * node. That is a TYPE guarantee rather than a comment — see `CheckedContract`.
 *
 * Moved here from `reduce.ts` at #4 A16 so the runtime reducer AND the inbound
 * webhook-callback boundary (`checkInboundOutputs`) share ONE store/validate
 * SSOT rather than the server re-implementing type-checking — this module's
 * whole reason to exist (see the header).
 */
export function storeOutputs(
  contract: CheckedContract,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  return contract.kind === 'declared'
    ? Object.fromEntries(contract.outputs.map((d) => [d.name, outputs[d.name]]))
    : { ...outputs };
}

/**
 * Validate a result's outputs against the node's output contract. A missing or
 * mistyped declared output is an error. `absent` (no contract) → trivially
 * valid. `invalid` (a CORRUPT contract) → an error, never "no contract": see
 * `OutputContract` for why conflating those two fails open (#1 F13a).
 *
 * NARROWS on success: a non-`null` `checked` means the contract is
 * `CheckedContract`, which is what lets `storeOutputs` refuse an `invalid` one
 * at the type level.
 */
export function validateOutputs(
  contract: OutputContract,
  outputs: Record<string, unknown>,
): { errs: string[]; checked: CheckedContract | null } {
  // A corrupt contract is a CONFIG defect, not a bad result — the node produced
  // nothing wrong. Worded to match `validateDoc`'s `config.outputs is
  // malformed` so both paths are greppable together, and kept distinct from the
  // caller's "produced invalid outputs" framing (which would blame the node, or
  // on the call path the CHILD PIPELINE, for the author's typo).
  if (contract.kind === 'invalid') {
    return { errs: [`config.outputs is malformed (${contract.reason})`], checked: null };
  }
  if (contract.kind === 'absent') return { errs: [], checked: contract };
  const errs: string[] = [];
  for (const d of contract.outputs) {
    if (!Object.prototype.hasOwnProperty.call(outputs, d.name)) {
      errs.push(`missing declared output '${d.name}'`);
      continue;
    }
    if (!matchesType(outputs[d.name], d.type)) {
      errs.push(`output '${d.name}' is not of declared type '${d.type}'`);
    }
  }
  return { errs, checked: contract };
}

function matchesType(value: unknown, type: OutputType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    // FINITE, not merely `!isNaN` (#6 E6). `number` means finite everywhere else
    // in this engine (`matchesSig` enforces it on every fn arg), and E6 types
    // `${nodes.x.output.n}` from this very declaration — so admitting `Infinity`
    // here would seed an output that fails its own type check downstream.
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return true;
  }
}

/**
 * The verdict of validating an INBOUND, UNTRUSTED payload (a `webhook` node's
 * HTTP callback body, #4 A16) against the node's declared output contract.
 * `ok:true` carries the declared-key-FILTERED outputs safe to persist into the
 * durable `externalWait.completed` event; `ok:false` carries a human reason and a
 * `kind` telling the route how to treat it (leaving the node parked either way — a
 * malformed callback must never fail the whole run):
 *  - `'payload'` — the caller's body is missing/mistyped a declared key. The
 *    caller can fix it by retrying, so the route surfaces `reason` in the 422 (a
 *    live-token holder that reaches this check is not a state oracle — naming the
 *    field is safe).
 *  - `'contract'` — the node's OWN `config.outputs` is corrupt (a config-authoring
 *    defect on a pre-F13a row). The external caller cannot fix that by retrying, so
 *    the route logs `reason` server-side and does NOT leak the internal config
 *    text into the response.
 */
export type InboundOutputsResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; kind: 'payload' | 'contract'; reason: string };

/**
 * #4 A16 — validate a `webhook` node's inbound callback body against its
 * `config.outputs` contract at the HTTP BOUNDARY (CLAUDE.md: "validate at system
 * boundaries; trust internal code"). Reuses the SAME `validateOutputs` /
 * `storeOutputs` the reducer's `node.succeeded` fold uses, so the two paths can
 * never disagree about which output names a node produces.
 *
 * Three cases:
 *  - `declared` with keys → every declared key must be present and correctly
 *    typed (a missing/mistyped/absent key is `ok:false`); the result is filtered
 *    to ONLY declared keys (undeclared inbound keys are dropped, never persisted).
 *  - `declared:[]` (the LOWERED default for a webhook that declares nothing) or
 *    truly `absent` → `ok:true` with `{}`. Unlike the trusted-executor
 *    `node.succeeded` path (which stores the whole payload for `absent`), an
 *    untrusted external body is NEVER stored wholesale — nothing can ref an
 *    undeclared output anyway, and dumping arbitrary external JSON into the
 *    raw-served run_events log is the leak this boundary exists to stop.
 *  - `invalid` (a corrupt contract, only reachable on a pre-F13a row) → `ok:false`
 *    with `kind:'contract'` (not caller-correctable; see `InboundOutputsResult`).
 */
export function checkInboundOutputs(
  node: Node,
  body: Record<string, unknown>,
): InboundOutputsResult {
  const { errs, checked } = validateOutputs(outputContract(node), body);
  // `checked === null` <=> the contract itself is corrupt (an author's defect,
  // pre-F13a): a caller can't fix it by retrying a different body, so it is a
  // `'contract'` failure. A non-null `checked` with errors is a caller-correctable
  // `'payload'` mismatch (a missing/mistyped declared key).
  if (checked === null) {
    return { ok: false, kind: 'contract', reason: errs.join('; ') };
  }
  if (errs.length > 0) {
    return { ok: false, kind: 'payload', reason: errs.join('; ') };
  }
  // `absent`/`declared:[]` → no declared keys; never persist an untrusted body.
  if (checked.kind === 'absent') return { ok: true, outputs: {} };
  return { ok: true, outputs: storeOutputs(checked, body) };
}
