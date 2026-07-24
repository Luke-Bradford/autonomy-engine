import { useLayoutEffect, type ReactNode } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { useStore } from 'zustand';
import { uiStore, type UiStore } from '../stores/uiStore';
import { FLUENT_ROOT_CLASS, THEMES, syncColorScheme } from './fluentTheme';

interface AppThemeProviderProps {
  children: ReactNode;
  /** Injectable for tests; the app uses the singleton. Must be the same store
   *  `ThemeToggle` reads — see the note on its `store` prop. */
  store?: UiStore;
}

/**
 * The theme SSOT. ONE value — `uiStore.themeMode` — drives every themed
 * surface, which is the whole point of U1:
 *
 * 1. `<FluentProvider theme>` re-emits the `--colorXxx` design tokens on the
 *    provider root, which is also `FLUENT_ROOT_CLASS`, which is what the U0
 *    `--xy-*` bridge is keyed on — so React Flow's Controls/MiniMap/edge-label
 *    chrome follows the mode with no bridge edit and no RF `colorMode`.
 * 2. `syncColorScheme` mirrors the mode onto `<html data-theme>` +
 *    `color-scheme`, which is what the pre-Fluent MVP palette (`index.css`) and
 *    the browser's native controls key on.
 *
 * `useLayoutEffect` (not `useEffect`) so a mode CHANGE lands before the browser
 * paints the new tree rather than a frame after it. It is not enough for the
 * FIRST paint — the render-blocking stylesheet is applied long before this
 * bundle runs — so `main.tsx` also mirrors the mode at module scope. jsdom
 * paints nothing, so the layout-vs-passive distinction is not unit-testable;
 * it is a browser-verify observation.
 */
export function AppThemeProvider({ children, store = uiStore }: AppThemeProviderProps) {
  const mode = useStore(store, (s) => s.themeMode);

  useLayoutEffect(() => {
    syncColorScheme(mode);
  }, [mode]);

  return (
    <FluentProvider theme={THEMES[mode]} className={FLUENT_ROOT_CLASS}>
      {children}
    </FluentProvider>
  );
}
