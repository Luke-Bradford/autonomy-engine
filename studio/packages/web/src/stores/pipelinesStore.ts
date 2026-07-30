import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Pipeline } from '@autonomy-studio/shared';
import { listPipelines } from '../api/pipelines';

/**
 * Where the list stands, as four distinguishable facts rather than a pair of
 * booleans that can encode states nobody meant (`loading && error`).
 *
 * `error` is a REFRESH failure, not "we know nothing": `pipelines` keeps the
 * last good answer through it. Consumers must therefore branch on `status`, not
 * on `pipelines.length` — an empty array means "no pipelines" only once a load
 * has actually succeeded.
 */
export type PipelinesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PipelinesState {
  status: PipelinesStatus;
  pipelines: Pipeline[];
  /** Message from the most recent failed load; cleared by the next success. */
  error: string | null;
  /**
   * ── The three entry points, as ONE guard matrix ─────────────────────────────
   *
   * Three actions each carrying their own near-identical status guard is a trap
   * for the next reader, so the whole decision table lives here once:
   *
   * | status    | `ensureFresh` | `recoverIfFailed` | `refresh` |
   * |-----------|---------------|-------------------|-----------|
   * | `idle`    | load          | —                 | load      |
   * | `loading` | —             | —                 | load      |
   * | `ready`   | load          | —                 | load      |
   * | `error`   | —             | **load**          | load      |
   *
   * The single cell that distinguishes `ensureFresh` from `recoverIfFailed` is
   * `error`, and it is the whole of #761: see each doc below for why that cell
   * has to be answered differently depending on WHY the caller is asking.
   *
   * `loading` → skip is shared by both, and it is what makes the request count
   * DETERMINISTIC while the Author hub mounts two consumers in one commit: the
   * first to run starts the load, the second sees `loading` and stands down.
   * `load` sets `status:'loading'` SYNCHRONOUSLY before its await, so this holds
   * whatever order React runs their effects in. Note it bounds requests per
   * mount/navigation, NOT in-flight loads: a superseded older request can still
   * be pending when a newer one settles (see `latestLoad`).
   */
  /**
   * The MOUNT-TIME entry point, for every consumer: bring the list up to date,
   * unless doing so would be wasteful or harmful.
   *
   * - `idle` / `ready` → load. Loading from `ready` is what keeps a re-entered
   *   hub honest: a pipeline created by the CLI, by an import, or in another
   *   tab is otherwise invisible until a browser reload. (An earlier cut only
   *   loaded from `idle`, which silently made the list fetch-once-per-page-load
   *   — a freshness regression against the per-mount fetch it replaced.)
   * - `loading` → skip (see the matrix above).
   * - `error` → skip, so a broken server cannot be hammered by remounts. A
   *   REMOUNT is not a retry: this is a deliberate contract, pinned by name in
   *   `pipelinesStore.test.ts`, and #761 did NOT relax it. Recovery is the
   *   explicit Retry control that BOTH consumers offer, or `recoverIfFailed`
   *   below when the user has navigated.
   */
  ensureFresh: () => void;
  /**
   * #761 — the ROUTE-ENTRY entry point: retry a load that FAILED, and otherwise
   * do nothing at all.
   *
   * Why this cannot just be `ensureFresh`: the Author pane
   * (`pages/author/FactoryResources.tsx`) does not unmount while the user moves
   * around WITHIN the hub, so its mount-time `ensureFresh` runs exactly once per
   * page load. Combined with `error → skip` above, a single transient 5xx left
   * the pane's banner up and its tree empty *permanently* — reading as "the app
   * is broken" on the hub's primary navigation surface — until the user found
   * Retry or reloaded the browser. `PipelinesPage` is sticky the same way: it
   * DOES remount, but `error → skip` defeats the fresh mount on its own.
   *
   * Why this cannot just be `refresh`: `refresh` loads unconditionally, so
   * calling it on every navigation would add a request per navigation against a
   * perfectly healthy server. This one is inert unless there is a failure to
   * recover from, which is what makes it safe to wire to route entry.
   *
   * It adds no new hammering class. `ensureFresh` ALREADY issues one request per
   * mount from `ready`, so a pathological remount loop can hammer today; this
   * makes the `error` path behave like the `ready` path, bounded at one request
   * per mount/navigation — ordinary per-mount-fetch semantics, and bounded by
   * user action rather than by render count.
   */
  recoverIfFailed: () => void;
  /**
   * Refetch unconditionally. Every mutation (create/rename/duplicate/delete)
   * ends in one of these, which is the whole reason this store exists: the pane
   * and the page are mounted SIMULTANEOUSLY over the same list, so a write in
   * one has to be visible in the other. It is also what Retry calls.
   *
   * NEVER rejects — a caller awaiting a post-mutation refresh must not have to
   * handle a second failure mode on top of the mutation's own.
   *
   * CAVEAT: a SUPERSEDED refresh resolves as soon as its own request settles,
   * without waiting for the fresher one that replaced it. So `await refresh()`
   * means "my request is done", not "the list is now current". No caller
   * depends on the stronger reading — both only use it to sequence UI state —
   * but one that did would need the store to expose the winning load's promise.
   */
  refresh: () => Promise<void>;
}

export type PipelinesStore = StoreApi<PipelinesState>;

/**
 * The pipelines list, shared by every view of it.
 *
 * Owning the list here rather than in each page is what keeps the two Author
 * surfaces consistent: before U4 the page held it in `useState`, which was
 * fine while it was the only reader.
 *
 * No `AbortSignal` plumbing, unlike the component-owned fetches it replaces. An
 * abort exists to stop a fetch writing into an UNMOUNTED component's state; the
 * result lands in a store that outlives every component, so there is nothing to
 * cancel and no leak to avoid. What DOES need handling is two loads in flight
 * at once — see the sequence check below.
 *
 * `fetchList` is injected for tests, the same seam `createUiStore` takes for
 * storage; the app uses the singleton at the bottom of this file.
 */
export function createPipelinesStore(fetchList = listPipelines): PipelinesStore {
  /**
   * Monotonic id of the most recently STARTED load. A load whose id is no
   * longer the latest has been superseded and drops its result on the floor —
   * without this, two overlapping refreshes (delete, then a fast create) apply
   * in COMPLETION order, so the slower, older answer can overwrite the newer
   * one and leave the pane showing a list the server no longer has.
   */
  let latestLoad = 0;

  return createStore<PipelinesState>((set, get) => {
    const load = async (): Promise<void> => {
      const id = (latestLoad += 1);
      /* `error` is cleared on the way IN, not just on success: otherwise a
         Retry runs with the previous failure still on screen and the Retry
         control (gated on `status === 'error'`) vanishing under the user's
         cursor — the banner would be describing a request that is no longer
         the current one. */
      set({ status: 'loading', error: null });
      try {
        const pipelines = await fetchList();
        if (id !== latestLoad) return;
        set({ status: 'ready', pipelines, error: null });
      } catch (err) {
        // A superseded load's failure is dropped too, not just its success: a
        // late rejection from an abandoned request must not bury the fresher
        // answer that replaced it under an error banner.
        if (id !== latestLoad) return;
        set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    };

    return {
      status: 'idle',
      pipelines: [],
      error: null,
      ensureFresh: () => {
        const status = get().status;
        if (status === 'loading' || status === 'error') return;
        void load();
      },
      /* Only from `error` — see the guard matrix on `PipelinesState`. `idle` is
         `ensureFresh`'s cell (nothing has been attempted, so there is nothing to
         recover), and `ready` staying inert is what lets this be wired to every
         route entry without adding request volume to a healthy server. */
      recoverIfFailed: () => {
        if (get().status !== 'error') return;
        void load();
      },
      refresh: load,
    };
  });
}

/** One list, one fetch, every consumer. */
export const pipelinesStore = createPipelinesStore();
