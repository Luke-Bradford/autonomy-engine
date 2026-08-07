import type { ClaudeAccountQuota } from '@autonomy-studio/shared';
import type { AccountQuotaReading, ClaudeAccountQuotaReader } from './claude-quota.js';

/**
 * #987 — the last reading that was actually OBTAINED, held for the HUMAN
 * surface only.
 *
 * ## Why this is not in the reader, and must never move there
 *
 * `claude-quota.ts`'s first stated divergence from the prototype is that it
 * serves NO last-good value: every sample stamps the cache with its own result,
 * so a failure REPLACES the previous reading rather than letting it survive.
 * That rule is right and load-bearing — its consumer is a spend guard, and a
 * stale-but-low reading that PERMITS a fire is the one polarity forbidden on
 * this surface (#763, #765).
 *
 * But it was being applied to two consumers with opposite needs. The operator's
 * Monitor panel asks "what is my quota?", and because the provider 429s most of
 * the time the panel said UNREADABLE most of the time — while the build loop's
 * guard was reading 58% successfully minutes earlier. A number obtained minutes
 * ago is exactly what a human wants and exactly what a gate must not have.
 *
 * So the split is in the CONTRACT, not in the rule. This module holds a
 * last-known reading OUTSIDE the reader, in a wrapper the reader knows nothing
 * about. `read()` returns its inner reader's outcome UNCHANGED, so nothing that
 * reads through it — the guard's `GET /api/quota` included — can observe a
 * difference. The only way to the retained value is `lastKnown()`, which one
 * route calls; adding a grace window to the shared reader instead is the #765
 * mistake, and would reach the guard.
 *
 * ## Why the wrapper, rather than a hook inside the reader
 *
 * A behaviourally-identical `onSample` hook inside `createClaudeAccountQuotaReader`
 * would put last-good memory inside the module whose central documented claim is
 * that it has none — making that claim unverifiable by reading the file, which
 * is the thing the claim is for.
 *
 * ## Not persisted, deliberately
 *
 * In-memory, dying with the process. The acceptance is "a number whenever one
 * was read this session"; a reading that outlives the process would be an
 * unbounded-age value restored at boot with nothing having been polled, which is
 * a strictly worse thing to show than "nothing has been read yet".
 */

/** A retained reading and when it was taken. Epoch MILLISECONDS. */
export interface LastKnownQuota {
  value: ClaudeAccountQuota;
  readAtMs: number;
}

export interface LastKnownQuotaRecorder {
  /**
   * A drop-in `ClaudeAccountQuotaReader` that records successes on the way past.
   * This is what everything else in the app should hold, so that BOTH the
   * background sampler's ticks and the guard's request-path reads keep the
   * retained value warm. A recorder fronting only the display route would
   * record almost nothing once the sampler is armed, because then almost every
   * successful read is a tick.
   */
  reader: ClaudeAccountQuotaReader;
  /** The most recent obtained reading, or `null` if none ever has been. */
  lastKnown(): LastKnownQuota | null;
}

export function createLastKnownQuotaRecorder(
  inner: ClaudeAccountQuotaReader,
  now: () => number = () => Date.now(),
): LastKnownQuotaRecorder {
  let retained: LastKnownQuota | null = null;
  /**
   * The outcome object `retained` was taken from, so a TTL cache hit does not
   * re-stamp it. The real reader returns the SAME object reference for every
   * read inside its window, so without this a 60s-cached success would keep
   * reporting an age of ~0 for a minute — an age overstated in the
   * looks-fresher direction, which is the direction that matters here.
   *
   * Reference identity is an optimisation over an injectable seam, not a
   * contract: a reader that returns a fresh equal object each time simply
   * re-stamps, and the resulting age is then bounded by that reader's own
   * caching. Either way the value is real.
   */
  let retainedFrom: AccountQuotaReading | null = null;

  return {
    reader: {
      async read(): Promise<AccountQuotaReading> {
        // Awaited, not recorded from a detached `.then`: the display route
        // reads and then builds its body, and a side chain could let that body
        // be built before the stamp landed — reporting no last-known on the
        // very read that produced one.
        const outcome = await inner.read();
        if (outcome.value !== null && outcome !== retainedFrom) {
          // Stamped AFTER the I/O rather than before it, so `readAtMs` trails
          // the true sample instant by the call's duration and the age is
          // understated by that much. Immaterial at a display's resolution, and
          // recorded here so it does not read as a bug later.
          retained = { value: outcome.value, readAtMs: now() };
          retainedFrom = outcome;
        }
        // The outcome is returned UNCHANGED and unconditionally. A failure is a
        // failure to every caller; this wrapper never substitutes.
        return outcome;
      },
    },
    lastKnown: () => retained,
  };
}
