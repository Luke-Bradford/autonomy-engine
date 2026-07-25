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
   * Load the list if nothing has loaded it yet. Idempotent and safe to call
   * from every consumer's mount effect — the Author hub mounts TWO of them at
   * once (the Factory Resources pane and the pipelines page), and a page
   * remounts on every navigation back to it.
   *
   * Deliberately NOT a retry: once a load has failed, `status` is `error` and
   * further calls do nothing, so a broken server cannot be hammered by remounts.
   * Recovery is an explicit `refresh()` behind a Retry control.
   */
  ensureLoaded: () => void;
  /**
   * Refetch unconditionally. Every mutation (create/rename/duplicate/delete)
   * ends in one of these, which is the whole reason this store exists: the pane
   * and the page are mounted SIMULTANEOUSLY over the same list, so a write in
   * one has to be visible in the other.
   *
   * NEVER rejects — a caller awaiting a post-mutation refresh must not have to
   * handle a second failure mode on top of the mutation's own.
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
      set({ status: 'loading' });
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
      ensureLoaded: () => {
        if (get().status === 'idle') void load();
      },
      refresh: load,
    };
  });
}

/** One list, one fetch, every consumer. */
export const pipelinesStore = createPipelinesStore();
