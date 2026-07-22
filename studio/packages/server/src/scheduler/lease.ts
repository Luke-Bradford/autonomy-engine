import { z, ZodError } from 'zod';
import { buildDedupeKey, type ArmWakeupInput, type Run } from '@autonomy-studio/shared';
import { LEASE_TTL_MS, type DriveDeps } from '../run/driver.js';
import { emptyReconcileReport, reconcileOne } from '../run/reconcile.js';
import { getRun, listParsedRuns, updateRun } from '../repo/runs.js';
import { RunLogUnparseableError } from '../run/events.js';
import { armWakeup, getWakeupByKey, supersedeWakeup } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

/**
 * #5 S7 — the RUN LEASE service: lease-expiry reclaim with generation tokens,
 * plus the heartbeat renewal S4 deferred. One module for the whole lease
 * lifecycle (the heartbeat SWEEP, the `run_lease` alarm HANDLER, and the
 * RECLAIM), because the three share two pieces of private state — the
 * `reclaimsInFlight` set and the alarm-identity scheme — and splitting them
 * would force both into a public seam.
 *
 * ## The invariant
 *
 * **Every `running` row holds a `leaseUntil`, and (within one sweep interval) a
 * pending `run_lease` alarm due at it.** The lease is "when to next VERIFY
 * liveness":
 *
 *  - a run with a LIVE DRIVE is renewed by the sweep — heartbeat stamped, lease
 *    pushed out, and the alarm SUPERSEDED to the new generation ("heartbeats
 *    supersede old alarms", spec #5's codex-hardened line) — so its alarm never
 *    fires;
 *  - a run alive on its OWN durable node alarm (a retry hold, a crash-gap
 *    parked wait) gets its lease RENEWED by the reclaim's `held` verdict — a
 *    self-perpetuating liveness check, not an interrupt;
 *  - a genuinely STRANDED run (its drive gone: a lost spawn, an untracked fault
 *    path) is reclaimed — resumed if its in-flight work was provably
 *    idempotent, frozen `interrupted` otherwise — by re-running the boot
 *    reconciler's per-activity policy (`reconcileOne`) under the drive lock.
 *
 * `waiting`/`queued`/terminal rows carry `leaseUntil = null` (S4 releases it)
 * and are out of lease scope: their liveness is their own alarm / the admission
 * queue. A pending lease alarm they leave behind fires into a `not_running`
 * suppression and is pruned by #464 retention — self-cleaning, no cancel pass.
 *
 * ## The generation token
 *
 * The alarm's ref carries the `leaseUntil` it was armed against. At fire, the
 * handler reclaims ONLY if the run row still holds that exact value and it is
 * expired (`leaseUntil <= now` — the one expiry comparison, `leaseExpired`);
 * any renewal (a heartbeat, a park→resume re-stamp via `syncRunLifecycle`)
 * changes the row's `leaseUntil`, so a stale generation's alarm suppresses as
 * `lease_renewed` instead of reclaiming a healthy run. Expiry itself is
 * structural at fire time: `dueAt === ref.leaseUntil`, so a token-matching
 * alarm the clock has deemed due is expired by construction.
 *
 * ## At-least-once, both directions
 *
 * The alarm's fire and settle are one transaction (the clock's contract), and
 * the reclaim is spawned `afterCommit` — so a crash or fault between the settle
 * and the reclaim would LOSE the reclaim. The sweep is the self-heal: a
 * `running` row with no live drive whose lease is expired (or whose
 * current-generation alarm is SPENT without having resolved the run) gets its
 * generation BUMPED — `leaseUntil` re-stamped and a fresh, immediately-due
 * alarm armed under the new (strictly advancing, hence collision-free) key.
 * Nothing is ever silently un-armed; the #465 discriminator trap cannot bite.
 *
 * ## Why the handler is bespoke (not `createDurableAlarmHandler`)
 *
 * The shared skeleton appends a per-kind DUE EVENT and re-drives the run via
 * `driveRun`. This kind appends no due event (the durable lifecycle facts —
 * `run.resumed`/`run.interrupted` — are appended by `reconcileOne` under the
 * lock) and spawns `reclaimRun`-via-`reconcileOne`, not `driveRun`; forcing it
 * through the skeleton would mean a fake event and a wrong drive path.
 */

/**
 * The `kind` under which a run's lease-expiry alarm is armed. Lives HERE (not
 * `driver.ts`, where the node/container kinds live) because the lease service
 * is its only armer as well as its only handler — the driver never arms it.
 */
export const LEASE_WAKEUP_KIND = 'run_lease';

/** How often the heartbeat sweep runs. LEASE_TTL_MS (5 min) is the miss
 * budget: five consecutive missed sweeps before a live run's lease can expire
 * (and even then the `drive_live` suppression stops a false reclaim). */
export const LEASE_SWEEP_MS = 60_000;

/**
 * S1's "typed `ref` per kind". `leaseUntil` is the GENERATION TOKEN — the lease
 * value this alarm was armed against, stringified because `WakeupRef` is a
 * flat string→string map. Like retry's `attemptId`, the ref pins the
 * occurrence, so the `lease-<n>` discriminator is formally vacuous — kept
 * because the field is required and self-describing in a DB browser.
 */
export const LeaseWakeupRefSchema = z.object({
  runId: z.string().min(1),
  leaseUntil: z.string().regex(/^\d+$/),
});

/** The ONE expiry comparison (all sites): expired means `leaseUntil <= now`. */
function leaseExpired(leaseUntil: number, now: number): boolean {
  return leaseUntil <= now;
}

/** The alarm's full identity+schedule for one `(runId, leaseUntil)` generation.
 * `dueAt` IS the lease expiry — one value, three roles (due time, token, key). */
function leaseArmInput(runId: string, leaseUntil: number): ArmWakeupInput {
  return {
    kind: LEASE_WAKEUP_KIND,
    ref: { runId, leaseUntil: String(leaseUntil) },
    dueAt: leaseUntil,
    discriminator: `lease-${leaseUntil}`,
  };
}

export type LeaseServiceDeps = DriveDeps;

export interface LeaseService {
  /** The `run_lease` clock handler — register alongside the others. */
  handler: WakeupHandler;
  /** One heartbeat pass over every `running` row. Never throws (per-run faults
   * are logged and skip that run; the scan fault logs and returns). */
  sweep(): void;
  /**
   * The reclaim itself. Production's ONLY caller is the handler's
   * `afterCommit`; exposed for the same reason `reconcile.ts` exports
   * `ReconcileInvariantError` — the under-lock abort guard is not reachable
   * from a natural fixture (an uncontended `serialize` starts its work in the
   * same frame as the fire, leaving no window to interpose), and an untested
   * guard gets deleted as ceremony. A test queues this behind a held drive and
   * changes the run's state before releasing it.
   */
  reclaim(runId: string): Promise<void>;
}

export function createLeaseService(deps: LeaseServiceDeps): LeaseService {
  const now = deps.now ?? (() => Date.now());

  /**
   * Runs whose RECLAIM is currently in flight. Two readers, both load-bearing:
   * the sweep must not treat a reclaim's `drives.serialize` registration as a
   * live drive (it would stamp `heartbeatAt` — false liveness evidence — and
   * renew the lease out from under the reclaim's guard), and the handler must
   * not spawn a second reclaim for a generation-bumped sibling alarm while one
   * is queued. In-memory on purpose: a crash empties it, and the durable
   * self-heal (the sweep's generation bump) re-arms whatever was lost.
   */
  const reclaimsInFlight = new Set<string>();

  /**
   * The live-app reconcile: `reconcileOne` under the drive lock (the lock
   * contract in `reconcile.ts`'s header — this is its second sanctioned entry
   * point). Everything is re-checked under the lock: between the fire's commit
   * and lock acquisition the run can be resumed by a wait alarm, settled by a
   * drive we queued behind, or deleted — the guard aborts on any of it.
   */
  async function reclaim(runId: string): Promise<void> {
    reclaimsInFlight.add(runId);
    try {
      await deps.drives.serialize(runId, async () => {
        const at = now();
        const run = getRun(deps.db, runId);
        if (run === null || run.status !== 'running') return;
        if (run.leaseUntil === null || !leaseExpired(run.leaseUntil, at)) return;

        const report = emptyReconcileReport();
        await reconcileOne(deps, report, run, 'lease_reclaim');

        // `held` — alive on its own durable node alarm (retry hold / crash-gap
        // parked wait): RENEW the liveness-check chain instead of churning
        // reclaims every TTL. (`deferred` is executor-less boot territory and
        // cannot occur here — `DriveDeps.executor` is required — but if it ever
        // did, "check again later" is the right verdict for it too.)
        // `resumed`/`finalized`/`resynced`/`interrupted` need nothing: the run
        // is now terminal, or `syncRunLifecycle` re-stamped its lease on a real
        // status change and the sweep re-arms its alarm within one interval.
        if (report.held.includes(runId) || report.deferred.includes(runId)) {
          renewHeldLease(runId, at);
        }
        deps.log?.warn?.({ runId, report }, 'run_lease: reclaimed a dead-lease run');
      });
    } catch (err) {
      // #646 — a corrupt run LOG is PERMANENT (typed at the source by
      // `loadEngineEvents`), so "the sweep will re-arm" below would poison-churn:
      // every sweep sees the expired lease, bumps the generation, fires, and
      // `reconcileOne` throws the same error again — one new wakeup row + one
      // error log per sweep interval per corrupt run, forever. Renew the lease
      // instead (the held-run treatment): the churn is bounded to once per TTL,
      // each renewal re-logs the corruption as the needs-attention signal, and
      // repairing the log makes the next reclaim succeed normally.
      if (err instanceof RunLogUnparseableError) {
        renewHeldLease(runId, now());
        deps.log?.error(
          { err, runId },
          'run_lease: run log unparseable — lease renewed, needs repair',
        );
        return;
      }
      // Includes `ReconcileInvariantError`: at boot that crashes the process,
      // but here a throw would land in the clock's floating afterCommit catch
      // as one log line anyway — so log it with the run id attached and rely
      // on the sweep's generation bump to retry. The lease stays expired.
      deps.log?.error({ err, runId }, 'run_lease: reclaim failed — the sweep will re-arm');
    } finally {
      reclaimsInFlight.delete(runId);
    }
  }

  /**
   * Renew a HELD run's lease + arm the next generation's alarm, atomically.
   * Patches `leaseUntil` ONLY — `heartbeatAt` is live-drive evidence and a
   * held run has no drive. Re-checks the row inside the transaction: the
   * `reconcileOne` above may have resumed-and-terminalized the run (a held
   * node alongside live siblings), and a terminal row must keep its null lease.
   */
  function renewHeldLease(runId: string, at: number): void {
    deps.db.transaction((tx) => {
      const cur = getRun(tx, runId);
      if (cur === null || cur.status !== 'running') return;
      const leaseUntil = at + LEASE_TTL_MS;
      updateRun(tx, runId, { leaseUntil });
      armWakeup(tx, leaseArmInput(runId, leaseUntil));
    });
  }

  const handler: WakeupHandler = {
    kind: LEASE_WAKEUP_KIND,
    refSchema: LeaseWakeupRefSchema,
    fire(row, _delivery, db: Db): WakeupFireResult {
      const ref = LeaseWakeupRefSchema.parse(row.ref);
      // #646 — the `run_unparseable` suppress the durable-alarm skeleton got in
      // #642, mirrored into this bespoke handler: every `running` row holds a
      // pending `run_lease` alarm (the module invariant), so the corrupt row the
      // lenient boot scan now lets SURVIVE would otherwise throw here on every
      // tick — the clock's per-row catch keeps the alarm pending, a 1 Hz
      // poison-fire loop for as long as the row exists. Suppress is self-healing:
      // once the row is repaired, the sweep's expired-lease branch re-arms.
      let run: Run | null;
      try {
        run = getRun(db, ref.runId);
      } catch (err) {
        if (err instanceof ZodError || err instanceof SyntaxError) {
          deps.log?.warn?.(
            { err, runId: ref.runId },
            'run_lease: run row unparseable — suppressing (permanently corrupt)',
          );
          return { status: 'suppressed', reason: 'run_unparseable' };
        }
        throw err;
      }
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };
      if (run.status !== 'running') return { status: 'suppressed', reason: 'not_running' };
      // THE GENERATION-TOKEN CHECK (codex-hardened): reclaim only if the row
      // still holds the exact lease this alarm was armed against. A heartbeat
      // renewal or a park→resume re-stamp moved it → this alarm is stale.
      if (String(run.leaseUntil) !== ref.leaseUntil) {
        return { status: 'suppressed', reason: 'lease_renewed' };
      }
      // Ordered before the registry check: a reclaim's own `serialize`
      // registration would read as a live drive and mislabel the reason.
      if (reclaimsInFlight.has(ref.runId)) {
        return { status: 'suppressed', reason: 'reclaim_in_flight' };
      }
      // A live drive with an expired lease means the SWEEP stalled, not the
      // run: never reclaim under a live drive — the next sweep renews.
      if (deps.drives.activeRunIds().includes(ref.runId)) {
        return { status: 'suppressed', reason: 'drive_live' };
      }
      // Spawned post-commit (the clock contract): the reclaim's own durable
      // events are appended under the drive lock, never inside this fire tx.
      return { status: 'fired', afterCommit: () => reclaim(ref.runId) };
    },
  };

  /** One row's sweep verdict — split out so `sweep`'s per-run catch wraps a
   * call, not forty lines. */
  function sweepOne(run: Run, at: number): void {
    // The reclaim owns this run right now; its verdict sets the next state.
    if (reclaimsInFlight.has(run.id)) return;

    if (deps.drives.activeRunIds().includes(run.id)) {
      // BRANCH 1 — a live drive: heartbeat + renew + supersede, ONE
      // transaction, so the row's lease and the pending alarm's generation can
      // never diverge across a crash (`supersedeWakeup`'s repo tx nests as a
      // SAVEPOINT). Repo calls rather than `clock.arm` on purpose: atomicity
      // needs the shared tx handle, and the arm-time ref validation the clock
      // provides is structural here — this module builds every ref it arms
      // from its own `leaseArmInput`.
      const prev = run.leaseUntil;
      const leaseUntil = at + LEASE_TTL_MS;
      deps.db.transaction((tx) => {
        updateRun(tx, run.id, { heartbeatAt: at, leaseUntil });
        const next = leaseArmInput(run.id, leaseUntil);
        if (prev === null || prev === leaseUntil) {
          // Nothing to supersede (first grant), or a same-ms re-sweep landed on
          // the identical generation (arm is then an idempotent no-op).
          armWakeup(tx, next);
        } else {
          supersedeWakeup(tx, { old: leaseArmInput(run.id, prev), next, at });
        }
      });
      return;
    }

    const prev = run.leaseUntil;
    const leaseLive = prev !== null && !leaseExpired(prev, at);
    if (leaseLive) {
      const existing = getWakeupByKey(
        deps.db,
        LEASE_WAKEUP_KIND,
        buildDedupeKey(leaseArmInput(run.id, prev)),
      );
      // BRANCH 2 — no drive, lease still live: make sure the alarm that will
      // notice its expiry exists (covers the drive-dropped-before-first-sweep
      // window and a boot-resumed run whose old generation already settled).
      // A pending row means a healthy watch — nothing to do. A SPENT row at a
      // live generation cannot happen by construction (the handler only
      // settles a generation the clock deemed due), so it falls through to
      // the bump below rather than being trusted.
      if (existing === null) {
        armWakeup(deps.db, leaseArmInput(run.id, prev));
        return;
      }
      if (existing.status === 'pending') return;
    }

    // BRANCH 3 — no drive and (lease expired | never granted | spent at the
    // current generation): a reclaim was lost, or never armed. Bump the
    // generation — strictly advancing, so the new key can never collide with a
    // spent row (#465's silent-never-arms trap) — and arm it immediately due.
    const bumpTo = Math.max(at, (prev ?? 0) + 1);
    deps.db.transaction((tx) => {
      updateRun(tx, run.id, { leaseUntil: bumpTo });
      armWakeup(tx, leaseArmInput(run.id, bumpTo));
    });
  }

  function sweep(): void {
    let rows: Run[];
    const at = now();
    try {
      // #646 — lenient per row: with the strict list, ONE corrupt `running` row
      // threw the whole scan into the catch below, silencing the S7 lease
      // heartbeat for EVERY live run for as long as the row existed. `warn`, not
      // `error`: this repeats every sweep interval until the row is repaired —
      // the boot report's `corrupt` bucket is the error-level attention signal;
      // this is the recurring reminder.
      rows = listParsedRuns(deps.db, { status: 'running' }, (id, err) => {
        deps.log?.warn?.({ err, runId: id }, 'run_lease: sweep skipping a corrupt run row');
      });
    } catch (err) {
      deps.log?.error({ err }, 'run_lease: sweep scan failed');
      return;
    }
    for (const run of rows) {
      // Per-run isolation (the #479 discipline): one bad row must not stop the
      // heartbeat for every other live run — a fully stalled sweep would decay
      // every live run's alarm into `drive_live` suppressions.
      try {
        sweepOne(run, at);
      } catch (err) {
        deps.log?.error({ err, runId: run.id }, 'run_lease: sweep failed for run');
      }
    }
  }

  return { handler, sweep, reclaim };
}
