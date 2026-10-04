import { useStore } from 'zustand';
import { uiStore, type UiStore } from '../stores/uiStore';
import type { DisplayTimeZone } from './displayTime';

/**
 * #1484 — the viewer's display time zone, subscribed: a component that shows a
 * time re-renders when Settings changes it. Pure helpers that build a sentence
 * around a time take the zone as an argument; this is where a component gets it.
 */
export function useDisplayTimeZone(store: UiStore = uiStore): DisplayTimeZone {
  return useStore(store, (s) => s.displayTimeZone);
}
