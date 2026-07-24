import { Switch, Tooltip } from '@fluentui/react-components';
import { useStore } from 'zustand';
import { uiStore, type UiStore } from '../stores/uiStore';

interface ThemeToggleProps {
  /**
   * Injectable for tests; the app uses the singleton. MUST be the same store
   * `AppThemeProvider` renders from — injecting into one and not the other
   * leaves this switch mutating a store nothing is subscribed to. The
   * composed-tree case in `App.test.tsx` is what guards the pairing.
   *
   * U2 considered moving this behind a React context. It did not: there is
   * still exactly ONE consumer (this toggle) and one provider, so a context
   * would be ceremony around a singleton. When a second independent consumer
   * arrives — U15's Settings surface is the likely one — that is the moment.
   */
  store?: UiStore;
}

/**
 * The light/dark control. A Fluent `Switch` rather than an icon button: it is
 * natively `role="switch"`, so its state is announced and is also visible in
 * the thumb's POSITION rather than by colour alone; it is keyboard-operable and
 * carries Fluent's own focus ring — the shell's accessibility criteria without
 * hand-rolled ARIA.
 *
 * U2 moved it into the 48px hub rail, which is too narrow for the visible text
 * label it previously carried. The name is preserved in full on two channels
 * instead: `aria-label` (so the accessible name is still exactly "Dark mode" —
 * what the unit and e2e specs query by role and name) and a Fluent `Tooltip`
 * for sighted pointer and keyboard users. `relationship="description"`, NOT
 * `"label"`: a labelling tooltip would set `aria-labelledby` and fight the
 * `aria-label` for the accessible name.
 */
export function ThemeToggle({ store = uiStore }: ThemeToggleProps) {
  const mode = useStore(store, (s) => s.themeMode);
  const setThemeMode = useStore(store, (s) => s.setThemeMode);

  return (
    <Tooltip content="Dark mode" relationship="description" positioning="after">
      <Switch
        aria-label="Dark mode"
        checked={mode === 'dark'}
        onChange={(_event, data) => setThemeMode(data.checked ? 'dark' : 'light')}
      />
    </Tooltip>
  );
}
