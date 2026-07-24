import { Switch } from '@fluentui/react-components';
import { useStore } from 'zustand';
import { uiStore, type UiStore } from '../stores/uiStore';

interface ThemeToggleProps {
  /** Injectable for tests; the app uses the singleton. */
  store?: UiStore;
}

/**
 * The light/dark control. A Fluent `Switch` rather than an icon button: it is
 * natively `role="switch"` with a visible text label (so the state is readable
 * without relying on colour or on recognising a glyph), keyboard-operable, and
 * carries Fluent's own focus ring — the shell's accessibility criteria without
 * hand-rolled ARIA. It also avoids pulling in `@fluentui/react-icons`, a new
 * dependency the icon-button form would need; the rail's named icon imports
 * arrive with U2.
 *
 * Lives in the MVP sidebar for now; U2 moves it into the 48px hub rail.
 */
export function ThemeToggle({ store = uiStore }: ThemeToggleProps) {
  const mode = useStore(store, (s) => s.themeMode);
  const setThemeMode = useStore(store, (s) => s.setThemeMode);

  return (
    <Switch
      label="Dark mode"
      checked={mode === 'dark'}
      onChange={(_event, data) => setThemeMode(data.checked ? 'dark' : 'light')}
    />
  );
}
