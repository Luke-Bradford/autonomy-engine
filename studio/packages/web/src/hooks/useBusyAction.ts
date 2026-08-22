import { useCallback, useRef, useState } from 'react';

/**
 * #960 — one per-row single-flight guard, instead of a fifth hand-rolled copy.
 *
 * THE RACE IT EXISTS TO KILL. A row action is an unguarded `async` handler on a
 * button that stays enabled while the request is in flight, so a double-click
 * fires the act twice. `ConnectionsPage.onDelete` states the timing: two clicks
 * in one tick both read the same stale `busy` STATE, because React has not
 * re-rendered by the time the second click's handler runs. The check therefore
 * has to be against a value that is already updated synchronously — a ref.
 *
 * KEYED BY ID, NOT A PAGE-WIDE FLAG. Inherited verbatim from `onDelete`'s
 * docblock, which argued it first: the race is one ROW being acted on twice, not
 * the page being used twice. A page-wide flag would make a click on a second row
 * during the first row's request a silent no-op — no dialog, no error — which
 * reads as a dead button. A single `string | null` slot cannot honestly hold two
 * concurrent acts either: the second start would re-enable the first row, and
 * the first completion would clear the second row's flag.
 *
 * TWO MIRRORS, ONE AUTHORITY. `inFlight` (the ref) is the guard and is authority;
 * `active` (the state) exists ONLY so the button can render `disabled`. They are
 * updated together and the ref is always written first. Do not read `active` to
 * decide whether to run — that is the stale read this hook exists to remove.
 *
 * WHY A SET AND NOT A COUNTER. Callers need to ask about ONE row
 * (`active.has(id)`), and rows complete out of order.
 *
 * DELIBERATELY NOT MIGRATED, and why — `useGuardedLoad` sets this convention,
 * because the omissions are the part a later reader cannot reconstruct:
 *
 *   - `FactoryResources`'s Export. It is a Fluent `<MenuItem>`, and
 *     `useMenuItemBase` calls `setOpen(event, {open: false})` BEFORE delegating
 *     to the handler, so the item unmounts on the first click. There is no
 *     second click to guard, and a guard there would be dead code that no test
 *     could redden.
 *   - `TriggersPage`'s `onFire`/`firingId`. This one IS the page-wide flag this
 *     hook argues against, and firing a second trigger while the first is in
 *     flight really is silently ignored. It is not a drop-in swap, though: the
 *     page reports a fire through ONE `actionMsg` slot and ONE `watchRunId`,
 *     so permitting concurrent fires would let the later outcome overwrite the
 *     earlier one — losing a run link the operator was given. Deciding what the
 *     page says about two fires at once is a design question, not a migration.
 *     Tracked as #1247.
 *
 * `ConnectionsPage.onDelete` — the handler this hook was extracted FROM — is
 * migrated, and keeps its no-affordance shape: its dialog is the feedback.
 *
 * THE CALLER OWNS ERROR REPORTING. `run` releases the id in a `finally` and then
 * re-throws whatever `act` threw; it does not catch. Every current caller's `act`
 * already try/catches into that page's own error slot, which is why the call
 * sites can stay `() => void run(...)`. An `act` that CAN reject must be given a
 * caller that handles it — this hook will not swallow it, because a swallowed
 * failure on an act the operator just asked for is the worse bug.
 */
const NONE: ReadonlySet<string> = new Set<string>();

export interface BusyAction {
  /** The ids currently in flight — for rendering `disabled` only. */
  active: ReadonlySet<string>;
  /** Run `act` for `id` unless it is already in flight. Stable for the component's life. */
  run: (id: string, act: () => Promise<void>) => Promise<void>;
}

export function useBusyAction(): BusyAction {
  const inFlight = useRef(new Set<string>());
  const [active, setActive] = useState<ReadonlySet<string>>(NONE);

  const run = useCallback(async (id: string, act: () => Promise<void>) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    // A fresh Set each time: React bails out of a re-render when the next state
    // is the same object, so mutating and re-setting the same Set would leave
    // the button enabled and the affordance half of this hook doing nothing.
    setActive(new Set(inFlight.current));
    try {
      await act();
    } finally {
      inFlight.current.delete(id);
      setActive(new Set(inFlight.current));
    }
  }, []);

  return { active, run };
}
