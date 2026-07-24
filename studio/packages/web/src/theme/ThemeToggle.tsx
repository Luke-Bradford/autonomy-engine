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
 * for sighted pointer and keyboard users, matching the rail's hub buttons.
 *
 * `relationship="label"`, verified against `useTooltipBase.js:214-219` in the
 * pinned Fluent version rather than assumed: for STRING content it sets
 * `aria-label` (only non-string content falls back to `aria-labelledby`), and
 * `applyTriggerPropsToChildren` spreads the child's own props LAST, so the
 * `Switch`'s explicit `aria-label` wins either way — the two cannot fight.
 * `"description"` would be wrong here: it sets `aria-describedby` to text
 * identical to the accessible name, so a screen reader announces "Dark mode,
 * switch, off … Dark mode".
 */
export function ThemeToggle({ store = uiStore }: ThemeToggleProps) {
  const mode = useStore(store, (s) => s.themeMode);
  const setThemeMode = useStore(store, (s) => s.setThemeMode);

  return (
    <Tooltip content="Dark mode" relationship="label" positioning="after">
      <Switch
        aria-label="Dark mode"
        checked={mode === 'dark'}
        onChange={(_event, data) => setThemeMode(data.checked ? 'dark' : 'light')}
      />
    </Tooltip>
  );
}
