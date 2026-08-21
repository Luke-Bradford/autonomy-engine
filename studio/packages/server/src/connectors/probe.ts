import pLimit from 'p-limit';
import {
  canonicalStringify,
  type ConnectionKind,
  type ConnectionProbeResult,
} from '@autonomy-studio/shared';
import type { ConnectorRegistry } from './registry.js';
import { redactSecrets } from './redact.js';

/**
 * #1191 — the route boundary for `ConnectorAdapter.testConnection`.
 *
 * The method has existed since the first adapter and, until this ticket, had no
 * route and no UI caller: eight implementations reachable only from their own
 * tests. This module is the seam that makes it reachable WITHOUT handing an
 * HTTP caller the adapter directly, and everything in it exists because a route
 * has obligations an adapter does not.
 *
 * Why this is not `llmProbeGet` (`llm-shared.ts`), which has a similar shape and
 * a nearly identical docblock: that one is a per-FETCH helper THREE adapters
 * call to implement their own probe — it bounds one HTTP GET. This is the
 * per-ADAPTER layer ABOVE all eight: registry lookup, the concurrency cap, the
 * never-settles backstop, and boundary redaction. They are stacked, not
 * duplicated — an `anthropic_api` probe passes through both.
 */

/**
 * The ceiling on ONE probe, and deliberately not a mirror of any adapter's own
 * budget.
 *
 * It sits above `DEFAULT_LLM_TIMEOUT_MS` (120_000) with grace, so a
 * default-configured adapter running its own honest timeout is never pre-empted
 * — the LLM probes pass `timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS` straight to
 * `llmProbeGet`, and postgres's worst case on defaults is 10s connect + 30s
 * statement. What it catches is an adapter that NEVER SETTLES, which is a
 * contract violation rather than a slow answer: `testConnection` is typed to
 * resolve, and `postgres-session.ts` documents the exact hazard (a `pg` client
 * whose `connectionTimeoutMillis` no longer applies once the handshake starts)
 * that makes the promise worth a backstop.
 *
 * STATED HONESTLY, because the constant cannot be right for everyone: every
 * adapter timeout is operator-configurable and unbounded (`timeoutMs`,
 * `connectTimeoutMs` are all `z.number().int().positive().optional()`). An
 * operator who configures a budget ABOVE this will see this backstop's sentence
 * instead of their adapter's. That is knowingly accepted — a liveness probe
 * that has not answered in over two minutes has already answered the question —
 * and the sentence says the attempt was ABANDONED rather than claiming the
 * store timed out, so the reading is never mistaken for the store's own verdict.
 *
 * Kept here rather than in `limits.ts`: `limits.ts` holds bounds several
 * subsystems share (`SQLITE_BUSY_TIMEOUT_MS`), and precedent for probe-shaped
 * timeouts is local (`DEFAULT_HTTP_TIMEOUT_MS` lives with the http adapter).
 * This one has exactly one consumer, three lines below it.
 */
export const PROBE_BACKSTOP_MS = 130_000;

/**
 * How many probes may be in flight at once, process-wide.
 *
 * A probe opens a real socket to an operator-named host, and the backstop above
 * is a RACE, not a cancel — when it fires, the underlying attempt keeps running
 * and keeps holding its socket. Without a cap, N concurrent requests mean N live
 * sockets (and, for postgres, N server-side sessions) with nothing bounding
 * them, on a server that sets no `requestTimeout`.
 *
 * `pLimit` is the same primitive the executor bounds its RUNNING phase with
 * (`run/executor.ts`, `pLimit(deps.concurrency ?? 4)`), at the same default —
 * the house pattern rather than a rate-limiter invented for one route.
 *
 * It is MODULE-LEVEL, and deliberately so, which is a real difference from the
 * executor's (created per `createExecutor` call) and from the connector
 * registry this ticket takes care to decorate per app. Those two hold per-app
 * STATE — a supervisor closure, a run's dependencies — and sharing them across
 * instances would leak. This holds no state; it rations a resource that is
 * genuinely process-wide, because outbound sockets belong to the process and
 * not to whichever `buildApp` happened to open them. Two app instances in one
 * process SHARE this budget, which is the intended reading rather than an
 * oversight. The visible cost is in tests: concurrent test apps throttle each
 * other, which shows up as slower probes, never as a failure.
 *
 * Note what it does and does not buy: it bounds RESOURCES, not request rate. A
 * flood of probes queues rather than being refused, so the observable effect of
 * saturation is slow responses, not exhausted sockets. Rate-limiting proper is a
 * separate concern with no primitive anywhere in this server (#1203).
 */
export const PROBE_CONCURRENCY = 4;

const probeLimit = pLimit(PROBE_CONCURRENCY);

/**
 * Every config key whose value the OVERLAY changed, sorted. Empty when the
 * overlay is byte-for-byte the stored config.
 *
 * TOTAL BY DESIGN — it takes no `kind` and consults no allowlist, and that is
 * the whole correction. The first version of this asked
 * `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS` which keys were dangerous, which was
 * wrong twice over. That table answers a DIFFERENT question (which keys a
 * pipeline node may override at dispatch, further gated by the connection's own
 * `parameters` opt-in allowlist), and it is EMPTY for `http`, `anthropic_api`,
 * `openai_api`, `ollama` and `agent_cli`. Three of those five send the stored
 * secret straight to `config.baseUrl` as an auth header — so consulting that
 * table left the exact exfiltration hole it was invoked to close wide open for
 * them, while looking closed.
 *
 * The lesson is the rule: enumerating dangerous keys is a guess about every
 * adapter's future, and it fails silently and in the permissive direction. A
 * probe that spends a credential the caller cannot see must run against the
 * config that credential was bound to — ALL of it. A new kind, or a new config
 * key on an old kind, is covered the day it is added, with nobody remembering
 * to add it here.
 *
 * The union of both key sets is walked: an overlay that DROPS a key changes the
 * config every bit as much as one that rewrites it, and the overlay replaces
 * the config wholesale rather than merging. Values compare canonically, so key
 * order inside an object-valued setting is never mistaken for a change.
 */
export function configKeysChangedByOverlay(
  stored: Record<string, unknown>,
  overlay: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(stored), ...Object.keys(overlay)]);
  return [...keys]
    .filter(
      (key) => canonicalStringify(stored[key] ?? null) !== canonicalStringify(overlay[key] ?? null),
    )
    .sort();
}

/** What `probeConnection` needs; `secret` is already decrypted by the caller. */
export interface ProbeConnectionArgs {
  registry: ConnectorRegistry;
  kind: ConnectionKind;
  config: Record<string, unknown>;
  secret: string | null;
  /** Overridable so a test can prove the backstop without waiting 130s. */
  backstopMs?: number;
}

/**
 * Run one adapter's `testConnection` under the route's obligations, and NEVER
 * throw: every path here resolves to a `ConnectionProbeResult`, because the
 * caller is an HTTP handler and an adapter bug must produce a sentence an
 * operator can read, not a 500 they cannot.
 */
export async function probeConnection(args: ProbeConnectionArgs): Promise<ConnectionProbeResult> {
  const { registry, kind, config, secret, backstopMs = PROBE_BACKSTOP_MS } = args;

  const adapter = registry.get(kind);
  if (!adapter) {
    // Defensive, and unreachable through either route today: both parse `kind`
    // through `ConnectionKindSchema`, and the registry holds every member of
    // that enum. It exists so a kind added to the enum without an adapter fails
    // LOUDLY here — the same posture the executor takes ("no adapter for
    // connection kind …") rather than a silent `ok`.
    return { ok: false, error: `no adapter for connection kind '${kind}'` };
  }

  return probeLimit(async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const backstop = new Promise<ConnectionProbeResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `the connection test did not answer within ${Math.round(
                backstopMs / 1000,
              )}s and was abandoned — the attempt may still be running`,
            }),
          backstopMs,
        );
        // Never hold the process open. The case this timer exists for is an
        // adapter that has HUNG, so without `unref` a graceful `app.close()`
        // could sit waiting out the full backstop for a probe whose answer
        // nobody is going to read.
        timer.unref?.();
      });
      const result = await Promise.race([adapter.testConnection(config, secret), backstop]);
      return redactProbeResult(result, secret);
    } catch (err) {
      // The contract says this cannot happen (`sqlite`/`postgres` both pin
      // "typed to RESOLVE, never reject"). If it does, it is an adapter bug, and
      // the thrown message is the least trustworthy string in the system — it
      // may quote a value we passed in — so it goes through redaction like any
      // other.
      return redactProbeResult(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        secret,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}

/**
 * Boundary redaction. Every adapter already redacts its own secret out of its
 * own sentence, so this is a backstop over a promise someone else made — the
 * `postgres` adapter's own `[redacted]` sentinel and this one's `***` can both
 * appear, which is fine: the property that matters is that the plaintext does
 * not.
 *
 * `[secret]` is the COMPLETE set of plaintexts on this path, and that is a
 * property of the signature rather than luck: `testConnection` takes no
 * `secretFields` argument, so the node-level config-sink channel
 * (`ActivityCatalogEntry.secretSinkFields`) is never resolved for a probe. Were
 * that argument ever added, this call would silently under-redact.
 */
function redactProbeResult(result: ConnectionProbeResult, secret: string | null) {
  if (result.ok) return result;
  return { ok: false as const, error: redactSecrets(result.error, [secret]) };
}
