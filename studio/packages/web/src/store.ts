import { create } from 'zustand';

/**
 * Tiny placeholder store — just enough to prove zustand is wired into the
 * app and importable/testable in isolation. Per the target architecture,
 * real run/UI-overlay state must stay a SEPARATE store from graph structure
 * (never run-state in `node.data`); this stub is not that store, only a
 * wiring proof.
 */
export interface CounterState {
  count: number;
  increment: () => void;
}

export const useCounterStore = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));
