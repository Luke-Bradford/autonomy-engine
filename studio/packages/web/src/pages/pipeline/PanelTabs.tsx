import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Tab, TabList } from '@fluentui/react-components';

/**
 * #1477 OR29 — a tab label's marks and what they mean. `mark` follows the label
 * ("⚠ 2", "✓") and says what the APPLIED settings are; `pending` is a dot in the
 * tab's corner for an edit not yet applied. Only the dot can come and go under
 * the author's typing, and it is drawn over the tab's padding, so a keystroke
 * moves no tab along. A mark changes on Apply and may widen its tab.
 */
export interface PanelTabStatus {
  mark?: { glyph: string; tone: 'error' | 'complete' };
  pending: boolean;
  description: string;
}

export interface PanelTab<K extends string> {
  key: K;
  label: string;
  content: ReactNode;
  /**
   * #1477 OR29 — the tab's marks. They are `aria-hidden`, and their meaning is
   * the tab's DESCRIPTION, so the tab's accessible name stays its label: a name
   * that changed with every keystroke would be re-announced, and would no longer
   * say which tab it is.
   */
  status?: PanelTabStatus;
}

/**
 * #852 / #844 — the property dock's tab strip (U7 "bottom dock, tabbed"), and
 * since #1484 OR35 M2 the run drawer's Input / Output / Error / Logs.
 *
 * EVERY panel stays MOUNTED and the inactive ones are `hidden`, deliberately.
 * The panels hold drafts — `ConfigEditor`'s unapplied form, a half-typed param
 * name — and a strip that unmounted the panel it left would silently discard
 * them on a tab switch.
 *
 * Fluent's `TabList` and `Tab` draw the strip, but the keyboard model is this
 * component's own (#1594 OR40 S5c): a roving tabindex (`stop`) and arrow-key
 * movement (`moveFocus`). Fluent's version is Tabster's arrow-navigation mover, which
 * puts focusable `aria-hidden` dummies beside the tabs, and axe fails those
 * (`aria-hidden-focus`).
 *
 * Controlled when `selected`/`onSelect` are given — `PropertyPanel` and the run
 * drawer lift the choice so selecting another node keeps the tab the operator
 * was on, as ADF does — and self-managed otherwise, so a panel rendered on its own (a unit
 * test, or a future host) still works.
 */
export function PanelTabs<K extends string>({
  label,
  tabs,
  selected,
  onSelect,
  header,
}: {
  label: string;
  tabs: readonly [PanelTab<K>, ...PanelTab<K>[]];
  selected?: K;
  onSelect?: (key: K) => void;
  /**
   * #1477 OR29 — drawn above the strip, and pinned WITH it while the panel
   * scrolls (`.panel-tabs-sticky`): the property dock's node name and its
   * Apply / Revert / ⋯ stay in reach from the bottom of a long tab.
   */
  header?: ReactNode;
}) {
  const baseId = useId();
  const [own, setOwn] = useState<K>(tabs[0].key);
  const current = selected ?? own;
  // The one tab stop. A choice that names no offered tab would leave the strip
  // unreachable by Tab, so the first tab stands in.
  const stop = tabs.some((t) => t.key === current) ? current : tabs[0].key;
  const tabId = (key: K) => `${baseId}-tab-${key}`;
  const panelId = (key: K) => `${baseId}-panel-${key}`;

  /**
   * The roving tabindex: only the selected tab is in the page's tab order, so
   * Tab enters the strip on it and leaves the strip in one press. The arrows
   * move focus along the strip and wrap (flipped right-to-left), Home and End go
   * to its ends, and none of them selects — Enter, Space or a click does, as with
   * Fluent's default (`selectTabOnFocus` off), so passing over a tab does not
   * swap the panel. A modified key is left alone: Alt+Left is the browser's Back.
   */
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const strip = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const from = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    const at = from ? strip.indexOf(from) : -1;
    if (at < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step =
      event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    const to =
      step !== 0
        ? (at + step + strip.length) % strip.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? strip.length - 1
            : undefined;
    if (to === undefined) return;
    event.preventDefault();
    strip[to]?.focus();
  };

  const strip = (
    <TabList
      className="panel-tabs"
      size="small"
      selectedValue={current}
      // Fluent types `data.value` as `unknown`; narrowed against the tabs
      // actually offered rather than asserted.
      onTabSelect={(_, data) => {
        const next = tabs.find((t) => t.key === data.value);
        if (!next) return;
        setOwn(next.key);
        onSelect?.(next.key);
      }}
      aria-label={label}
      // Switches off Tabster's mover: Fluent spreads these props over its own
      // focus attributes, so `undefined` removes the attribute the mover hangs
      // on, and with it the dummies. `PanelTabs.test.tsx` pins that it is gone.
      data-tabster={undefined}
      onKeyDown={moveFocus}
    >
      {tabs.map((t) => (
        <Tab
          key={t.key}
          value={t.key}
          id={tabId(t.key)}
          aria-controls={panelId(t.key)}
          aria-describedby={t.status ? `${tabId(t.key)}-status` : undefined}
          tabIndex={t.key === stop ? 0 : -1}
        >
          {t.label}
          {t.status?.mark && (
            <span className="panel-tabs__status" data-tone={t.status.mark.tone} aria-hidden="true">
              {t.status.mark.glyph}
            </span>
          )}
          {t.status?.pending && (
            <span className="panel-tabs__pending" aria-hidden="true">
              •
            </span>
          )}
        </Tab>
      ))}
    </TabList>
  );
  // Each mark's meaning, OUTSIDE the tabs: Fluent draws a tab's children twice
  // (once hidden, to reserve its selected width), and an id must be unique.
  const meanings = tabs.flatMap((t) =>
    t.status
      ? [
          <span key={t.key} id={`${tabId(t.key)}-status`} className="visually-hidden">
            {t.status.description}
          </span>,
        ]
      : [],
  );

  return (
    <>
      {header === undefined ? (
        strip
      ) : (
        <div className="panel-tabs-sticky">
          {header}
          {strip}
        </div>
      )}
      {meanings}
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={panelId(t.key)}
          aria-labelledby={tabId(t.key)}
          className="panel-tab"
          hidden={t.key !== current}
        >
          {t.content}
        </div>
      ))}
    </>
  );
}
