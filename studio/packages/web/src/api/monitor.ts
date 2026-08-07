import {
  AccountQuotaDisplayStateSchema,
  AiActivitySnapshotSchema,
  type AccountQuotaDisplayState,
  type AiActivitySnapshot,
  type RunSince,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * #917 — the Monitor hub's AI-activity surface: what the connected AIs have been
 * doing, and how much account quota is left.
 *
 * Two endpoints with deliberately different characters, kept in one client
 * because one page reads both and the difference between them is the thing a
 * caller most needs to know:
 *
 *  - `/api/monitor/ai-activity` is a LOCAL read (SQLite over the run-event log),
 *    owner-scoped, cheap enough to poll.
 *  - `/api/quota/display` reaches the PROVIDER. It is not cheap and must not be
 *    polled — see `fetchAccountQuotaDisplay` below.
 */

/**
 * The cross-run AI-activity snapshot. `since` is a RELATIVE window resolved by
 * the SERVER against its own clock, exactly as the run list's `since` is and for
 * the same reason: the bound is compared against a column the server stamped, so
 * resolving it in the browser would resize the window by this machine's skew.
 */
export function fetchAiActivity(
  since?: RunSince,
  signal?: AbortSignal,
): Promise<AiActivitySnapshot> {
  const suffix = since === undefined ? '' : `?since=${since}`;
  return apiFetch(`/api/monitor/ai-activity${suffix}`, {
    schema: AiActivitySnapshotSchema,
    signal,
  });
}

/**
 * The account's subscription quota, in its HUMAN shape (#987).
 *
 * `/api/quota/display`, NOT `/api/quota`. The latter is the build loop's spend
 * guard's endpoint and answers with a live reading or nothing at all — correct
 * for a gate, useless for a person, because the provider 429s most of the time
 * and the panel therefore said UNREADABLE most of the time. This one adds the
 * last reading that was actually obtained, with the timestamp it was taken at,
 * and only when there is no live one. The browser has NO reason to call
 * `/api/quota` and does not.
 *
 * MUST NOT BE POLLED ON A TIMER, and this is a correctness constraint rather
 * than a performance preference. The standing invariant (#770) is that exactly
 * ONE process may poll the provider's usage endpoint. Since the C3 cutover that
 * process is STUDIO'S OWN background sampler (`CLAUDE_QUOTA_SAMPLER=1` on the
 * supervised server) — it used to be the prototype dashboard's, and that has now
 * been retired. The sampler ticks at half the reader's 60s TTL, so a request
 * landing in the window is a pure cache hit that touches nothing.
 *
 * What that changed is the COST of a poll, not the rule. A tab refreshing on an
 * interval would still hit the request path whenever the cache had just expired,
 * racing the sampler for the same bucket — a second continuous sampler in all
 * but name. Mount + an explicit operator click is user-driven and bounded; a
 * timer is not. See `AiActivityPage`, which pairs this with a "last checked"
 * stamp so a deliberately un-refreshed reading is never mistaken for a live one.
 *
 * NEVER THROWS ON AN UNREADABLE ACCOUNT: the route answers 200 with
 * `account.claude: null` plus a reason. A rejection here means the REQUEST
 * failed, which is a different fact and is rendered differently.
 */
export function fetchAccountQuotaDisplay(signal?: AbortSignal): Promise<AccountQuotaDisplayState> {
  return apiFetch('/api/quota/display', { schema: AccountQuotaDisplayStateSchema, signal });
}
