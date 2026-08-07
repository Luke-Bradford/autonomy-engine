import {
  AccountQuotaStateSchema,
  AiActivitySnapshotSchema,
  type AccountQuotaState,
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
 *  - `/api/quota` reaches the PROVIDER. It is not cheap and must not be polled —
 *    see `fetchAccountQuota` below.
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
 * The account's subscription quota.
 *
 * MUST NOT BE POLLED ON A TIMER, and this is a correctness constraint rather
 * than a performance preference. The server's reader has no background sampler:
 * it reads on the request path (behind a 60s TTL and a doubling 429 backoff),
 * and the standing invariant is that exactly ONE process may poll the provider's
 * usage endpoint. Until the old prototype dashboard's sampler is retired, that
 * one process is the dashboard — so an open tab refreshing this on an interval
 * would be a second continuous sampler in all but name, and account contention
 * is exactly what it would produce. Mount + an explicit operator click is
 * user-driven and bounded; a timer is not. See `AiActivityPage`, which pairs
 * this with an "as of" stamp so a deliberately un-refreshed reading is never
 * mistaken for a live one.
 *
 * NEVER THROWS ON AN UNREADABLE ACCOUNT: the route answers 200 with
 * `account.claude: null` plus a reason. A rejection here means the REQUEST
 * failed, which is a different fact and is rendered differently.
 */
export function fetchAccountQuota(signal?: AbortSignal): Promise<AccountQuotaState> {
  return apiFetch('/api/quota', { schema: AccountQuotaStateSchema, signal });
}
