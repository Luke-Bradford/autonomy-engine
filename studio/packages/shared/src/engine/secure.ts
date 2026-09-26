/**
 * #1 F4 (spec #1 D8) — EMIT-TIME redaction for a node whose `policy` sets
 * `secureOutput` and/or `secureInput`.
 *
 * WHERE it runs: `Engine.redact`, which the server's `appendAndFold` applies to
 * every event BEFORE `appendEngineEvent`. The log is the only durable record and
 * the websocket stream and the run page are fed from what was appended, so
 * scrubbing at that one seam keeps the plaintext out of every one of them. The
 * reducer then folds the REDACTED event — which is why `validateRefs` refuses a
 * downstream `${nodes.<id>.output…}` ref to a secure node: there is no value left
 * to read (resolved question 2, the MVP half).
 *
 * WHAT it scrubs, per event, for a secure node (anything else passes untouched):
 *  - `node.succeeded` / `externalWait.completed` (secureOutput) — every output
 *    VALUE becomes a marker. Keys stay: they are the author's declared vocabulary,
 *    and `validateOutputs` still has to see them to report a missing output.
 *  - `node.output` (secureOutput) — the streamed value AND its name; an adapter
 *    may build a name from data, which is why the plaintext scrub
 *    (`redactEventPlaintexts`) scrubs names too.
 *  - `node.failed.error` / `activity.warned.reason` (either flag) — free text an
 *    adapter may build from a request or response body. `kind`/`code` stay, so
 *    retry policy and failure routing are unchanged; only the prose is withheld.
 *  - the content hashes on `activity.captured` / `activity.agentTelemetry` /
 *    `activity.toolCalled` (either flag) — they are UNSALTED sha256, so a short
 *    secret (a one-time code, a yes/no answer) is recoverable by guessing.
 *    Lengths and counts stay: they are the cost/latency facts those events exist
 *    for.
 *
 * THE CONTRACT CHECK SURVIVES. A declared `number` output replaced by a string
 * marker would fail the reducer's type check on every run, so redaction decides
 * validity HERE, against the real value, and encodes the verdict in which marker
 * it writes: a value that matches its declared type becomes `SECURE_REDACTED`, a
 * value that does not becomes `SECURE_REDACTED_INVALID`. `validateOutputs` in
 * secure mode passes the first and fails the second, so a secure node that
 * produces a mistyped output still fails — with the same diagnostic — and the
 * event type never changes (a synthesised `node.failed` could not settle a
 * `waiting` node). A LEGACY log that carries plaintext for a secure node is
 * checked exactly as before: neither marker matches a real value.
 *
 * RUNS EXACTLY ONCE per event — `appendAndFold` is its only caller — so the
 * verdict is taken with the plain type check on the RAW value. That is what
 * stops an output that merely SPELLS a marker from forging a verdict (a
 * declared `string` whose value is the invalid-marker text is still a valid
 * string). The price is that it is not idempotent: re-redacting a valid
 * `number` output's marker would judge the marker string itself and flip it to
 * invalid. Nothing re-redacts, and a second caller must not be added.
 */
import type { Node } from '../schemas/pipeline.js';
import type { CapturedContent, EngineEvent } from './types.js';
import {
  outputContract,
  matchesType,
  SECURE_REDACTED,
  SECURE_REDACTED_INVALID,
} from './outputs.js';

// The markers: `SECURE_REDACTED` for a VALID output (and any other scrubbed
// field), `SECURE_REDACTED_INVALID` for an output that did NOT match its declared
// type. Declared in `outputs.ts`, whose type check reads them.
export { SECURE_REDACTED, SECURE_REDACTED_INVALID };

/** The withheld failure prose — the failure's `kind`/`code` still say what happened. */
export const SECURE_ERROR_WITHHELD =
  'error detail withheld: this node is secure (policy.secureInput/secureOutput)';

export function hasSecureOutput(node: Pick<Node, 'policy'> | undefined): boolean {
  return node?.policy?.secureOutput === true;
}

export function isSecureNode(node: Pick<Node, 'policy'> | undefined): boolean {
  return node?.policy?.secureOutput === true || node?.policy?.secureInput === true;
}

/**
 * Replace every output value by the marker that carries its contract verdict. An
 * OPTIONAL declared output left `null`/`undefined` keeps that value — "absent" is
 * not the secret, and `storeOutputs` needs it to write its present-null.
 */
function redactOutputs(node: Node, outputs: Record<string, unknown>): Record<string, unknown> {
  const contract = outputContract(node);
  const declared = contract.kind === 'declared' ? contract.outputs : [];
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(outputs)) {
    const d = declared.find((o) => o.name === name);
    if (d?.optional === true && (value === null || value === undefined)) {
      out[name] = value;
    } else if (d === undefined || matchesType(value, d.type)) {
      out[name] = SECURE_REDACTED;
    } else {
      out[name] = SECURE_REDACTED_INVALID;
    }
  }
  return out;
}

/**
 * One `activity.captured` field on a secure node: the hash becomes the marker,
 * and so does the text when a `capture: 'full'` node stored one (#605). The
 * text becomes the marker rather than being DROPPED, because an absent text
 * means "metadata mode" and the monitor must be able to say which it is.
 * `truncated` goes with the text; `chars` stays, as it always has.
 *
 * Stricter than the spec's per-flag split (prompt is `secureInput`-eligible,
 * completion `secureOutput`-eligible): EITHER flag withholds every field,
 * matching the hash rule F4 already applied here — a completion routinely
 * quotes its prompt, so the split would leak through the other half.
 *
 * A non-secure prompt that literally reads `SECURE_REDACTED` renders as a
 * withheld one. Outputs have the same property; the marker is not forgeable
 * INTO a secret, only into a false "withheld".
 */
function redactCaptured<T extends CapturedContent>(field: T): T {
  if (field.text === undefined) return { ...field, contentHash: SECURE_REDACTED };
  const withText: T = { ...field, contentHash: SECURE_REDACTED, text: SECURE_REDACTED };
  delete withText.truncated;
  return withText;
}

/**
 * PURE: the event as it may be persisted, given the doc node it belongs to
 * (`undefined` — a run-level event, or a node the doc does not know — passes
 * untouched).
 */
export function redactSecureEvent(node: Node | undefined, event: EngineEvent): EngineEvent {
  if (node === undefined || !isSecureNode(node)) return event;
  const secureOut = hasSecureOutput(node);
  switch (event.type) {
    case 'node.succeeded':
      return secureOut ? { ...event, outputs: redactOutputs(node, event.outputs) } : event;
    case 'externalWait.completed':
      return secureOut && event.outputs !== undefined
        ? { ...event, outputs: redactOutputs(node, event.outputs) }
        : event;
    case 'node.output':
      return secureOut ? { ...event, name: SECURE_REDACTED, value: SECURE_REDACTED } : event;
    case 'node.failed':
      return { ...event, error: SECURE_ERROR_WITHHELD };
    case 'activity.warned':
      return { ...event, reason: SECURE_ERROR_WITHHELD };
    case 'activity.captured':
      return {
        ...event,
        request: {
          ...event.request,
          ...(event.request.system !== undefined
            ? { system: redactCaptured(event.request.system) }
            : {}),
          messages: event.request.messages.map(redactCaptured),
        },
        ...(event.completion !== undefined ? { completion: redactCaptured(event.completion) } : {}),
      };
    case 'node.dispatched':
      // #890 — EITHER flag, as for `activity.captured`: a node's outputs, errors
      // and transcript routinely echo its input, so withholding the input on
      // `secureInput` alone would still leave it readable on a `secureOutput`
      // node through the other half. `chars` stays, as it does there.
      return event.input !== undefined
        ? { ...event, input: { text: SECURE_REDACTED, chars: event.input.chars } }
        : event;
    case 'activity.agentTelemetry':
      return event.outputHash !== undefined ? { ...event, outputHash: SECURE_REDACTED } : event;
    case 'activity.toolCalled':
      return {
        ...event,
        ...(event.argsHash !== undefined ? { argsHash: SECURE_REDACTED } : {}),
        ...(event.resultHash !== undefined ? { resultHash: SECURE_REDACTED } : {}),
      };
    default:
      return event;
  }
}

/** The node id an event is ABOUT, for the ones `redactSecureEvent` scrubs. */
export function secureEventNodeId(event: EngineEvent): string | undefined {
  switch (event.type) {
    case 'node.dispatched':
    case 'node.succeeded':
    case 'externalWait.completed':
    case 'node.output':
    case 'node.failed':
    case 'activity.warned':
    case 'activity.captured':
    case 'activity.agentTelemetry':
    case 'activity.toolCalled':
      return event.nodeId;
    default:
      return undefined;
  }
}
