import { useId, useState, type ReactNode } from 'react';
import { Tab, TabList } from '@fluentui/react-components';

export interface PanelTab<K extends string> {
  key: K;
  label: string;
  content: ReactNode;
}

/**
 * #852 / #844 — the property dock's tab strip (U7 "bottom dock, tabbed").
 *
 * EVERY panel stays MOUNTED and the inactive ones are `hidden`, deliberately.
 * The panels hold drafts — `ConfigEditor`'s unapplied form, a half-typed param
 * name — and a strip that unmounted the panel it left would silently discard
 * them on a tab switch. `RunsPage` renders one `tabpanel` whose contents change,
 * which is right for a filter over one list and wrong here.
 *
 * Fluent's `TabList` for the same reason `RunsPage` uses it: it brings the
 * roving tabindex and arrow-key movement the `tab` role advertises.
 *
 * Controlled when `selected`/`onSelect` are given — `PropertyPanel` lifts the
 * choice so selecting another node keeps the tab the operator was on, as ADF
 * does — and self-managed otherwise, so a panel rendered on its own (a unit
 * test, or a future host) still works.
 */
export function PanelTabs<K extends string>({
  label,
  tabs,
  selected,
  onSelect,
}: {
  label: string;
  tabs: readonly [PanelTab<K>, ...PanelTab<K>[]];
  selected?: K;
  onSelect?: (key: K) => void;
}) {
  const baseId = useId();
  const [own, setOwn] = useState<K>(tabs[0].key);
  const requested = selected ?? own;
  // A lifted choice this panel does not offer (a node tab carried onto a panel
  // with fewer tabs) falls back to the first, rather than showing nothing.
  const current = tabs.some((t) => t.key === requested) ? requested : tabs[0].key;
  const tabId = (key: K) => `${baseId}-tab-${key}`;
  const panelId = (key: K) => `${baseId}-panel-${key}`;

  return (
    <>
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
      >
        {tabs.map((t) => (
          <Tab key={t.key} value={t.key} id={tabId(t.key)} aria-controls={panelId(t.key)}>
            {t.label}
          </Tab>
        ))}
      </TabList>
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
