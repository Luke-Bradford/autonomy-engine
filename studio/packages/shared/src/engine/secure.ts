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
 *  - `node.succeeded` / `externalWait.completed` / `node.awaitingCallback` and an
 *    early callback on `externalWait.created` (secureOutput) — every output
 *    VALUE becomes a marker. Keys stay: they are the author's declared vocabulary,
 *    and `validateOutputs` still has to see them to report a missing output.
 *  - `node.output` (secureOutput) — the streamed value AND its name; an adapter
 *    may build a name from data, which is why the plaintext scrub
 *    (`redactEventPlaintexts`) scrubs names too.
 *  - `node.failed.error` / `activity.warned.reason` / a callback's
 *    `reportedError` (either flag) — free text an
 *    adapter may build from a request or response body. `kind`/`code` stay, so
 *    retry policy and failure routing are unchanged; only the prose is withheld.
 *  - the content hashes on `activity.captured` / `activity.agentTelemetry` /
 *    `activity.toolCalled` (either flag) — they are UNSALTED sha256, so a short
 *    secret (a one-time code, a yes/no answer) is recoverable by guessing.
 *    Lengths and counts stay: they are the cost/latency facts those events exist
 *    for. A `capture: 'full'` node's captured TEXTS go the same way: system,
 *    turns, completion and (#605) the reasoning summary.
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
import { RUN_LOG_STREAMS } from '../catalog/session-log.js';
import type { Node } from '../schemas/pipeline.js';
import type { CapturedContent, EngineEvent, ResolvedUserProperty } from './types.js';
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

/** #1600 C0d — every value and error is the marker; the names stay. */
function redactUserProperties(props: ResolvedUserProperty[]): ResolvedUserProperty[] {
  return props.map(({ name, error }) =>
    error !== undefined ? { name, error: SECURE_REDACTED } : { name, value: SECURE_REDACTED },
  );
}

/**
 * PURE: the event as it may be persisted, given the doc node it belongs to
 * (`undefined` — a run-level event, or a node the doc does not know — passes
 * untouched).
 */
export function redactSecureEvent(node: Node | undefined, event: EngineEvent): EngineEvent {
  if (node === undefined || !isSecureNode(node)) return event;
  const redacted = redactSecureFields(node, event);
  // #1600 C0d / #1673 — user properties, on whichever event records them (a
  // dispatch, a failure before it, or an engine-evaluated activity's own
  // event): EITHER flag, as for `node.dispatched`'s input, because a `${}` in
  // one can echo the input.
  return 'userProperties' in redacted && redacted.userProperties !== undefined
    ? { ...redacted, userProperties: redactUserProperties(redacted.userProperties) }
    : redacted;
}

/** `redactSecureEvent`'s per-event fields, but for the user properties. */
function redactSecureFields(node: Node, event: EngineEvent): EngineEvent {
  const secureOut = hasSecureOutput(node);
  switch (event.type) {
    case 'node.succeeded':
      return secureOut ? { ...event, outputs: redactOutputs(node, event.outputs) } : event;
    case 'externalWait.completed': {
      // #1600 C11c — a reported failure's message quotes the callback, as a
      // `node.failed` error may quote a response: EITHER flag withholds it.
      const withError =
        event.reportedError !== undefined
          ? { ...event, reportedError: SECURE_ERROR_WITHHELD }
          : event;
      return secureOut && event.outputs !== undefined
        ? { ...withError, outputs: redactOutputs(node, event.outputs) }
        : withError;
    }
    // #1600 C11c — the request's outputs, held for the callback: as `node.succeeded`.
    case 'node.awaitingCallback':
      return secureOut ? { ...event, outputs: redactOutputs(node, event.outputs) } : event;
    // #1600 C11c — a callback that arrived before the park: as `externalWait.completed`.
    case 'externalWait.created': {
      if (event.arrived === undefined) return event;
      const callback = secureOut
        ? redactOutputs(node, { callback: event.arrived.callback }).callback
        : event.arrived.callback;
      return {
        ...event,
        arrived: {
          callback,
          ...(event.arrived.reportedError !== undefined
            ? { reportedError: SECURE_ERROR_WITHHELD }
            : {}),
        },
      };
    }
    case 'node.output':
      // #1600 OR41 C9c — a session log line carries an item's error, as a
      // failure does, so EITHER flag withholds it, as for `node.failed`; so does
      // a failed Script's server message (#1801).
      return secureOut || RUN_LOG_STREAMS.has(event.name)
        ? { ...event, name: SECURE_REDACTED, value: SECURE_REDACTED }
        : event;
    case 'node.failed':
      return { ...event, error: SECURE_ERROR_WITHHELD };
    // #1600 C8d — a Wait until's reason names the path, as a failure would.
    case 'node.notReady':
      return { ...event, reason: SECURE_ERROR_WITHHELD };
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
        ...(event.reasoning !== undefined ? { reasoning: redactCaptured(event.reasoning) } : {}),
      };
    case 'node.dispatched':
      // #890 — EITHER flag, as for `activity.captured`: a node's outputs, errors
      // and transcript routinely echo its input, so withholding the input on
      // `secureInput` alone would still leave it readable on a `secureOutput`
      // node through the other half. `chars` stays, as it does there. The
      // resolved parameters (`params`) are input too, and go the same way.
      return event.input === undefined && event.params === undefined
        ? event
        : {
            ...event,
            ...(event.input !== undefined
              ? { input: { text: SECURE_REDACTED, chars: event.input.chars } }
              : {}),
            ...(event.params !== undefined
              ? { params: { text: SECURE_REDACTED, chars: event.params.chars } }
              : {}),
          };
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

/** The node id an event is ABOUT, for the ones `redactSecureEvent` scrubs.
 * #1673 — an If, Switch, variable write or call records user properties on an
 * event left out here; none of them can be secure (`validateSecurePolicy`). */
export function secureEventNodeId(event: EngineEvent): string | undefined {
  switch (event.type) {
    case 'node.dispatched':
    case 'node.succeeded':
    case 'externalWait.completed':
    case 'externalWait.created':
    case 'node.awaitingCallback':
    case 'node.output':
    case 'node.failed':
    case 'node.notReady':
    case 'activity.warned':
    case 'activity.captured':
    case 'activity.agentTelemetry':
    case 'activity.toolCalled':
    case 'timer.waitScheduled': // #1673 — a Wait's user properties are on the event that parks it.
    case 'node.inactive': // #1673 — any activity can be switched off, a secure one included.
      return event.nodeId;
    // #844 V5 (spec V-D8) — listed EXPLICITLY as never secure rather than left to
    // the default: a `set`/`append` node cannot carry a secure flag
    // (`validateSecurePolicy`), because the value it writes is readable
    // everywhere as `${vars.<name>}`, so there is nothing here to withhold.
    case 'variable.set':
    case 'variable.append':
      return undefined;
    default:
      return undefined;
  }
}
