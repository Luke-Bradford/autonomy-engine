import { useId, useState, type ReactNode } from 'react';
import { Tab, TabList } from '@fluentui/react-components';

/** #1477 OR29 — a tab label's mark and what it means. */
export interface PanelTabStatus {
  glyph: string;
  tone: 'error' | 'pending' | 'complete';
  description: string;
}

export interface PanelTab<K extends string> {
  key: K;
  label: string;
  content: ReactNode;
  /**
   * #1477 OR29 — a mark after the label ("⚠ 2", "•", "✓") and what it means.
   * The mark is `aria-hidden` and the meaning is the tab's DESCRIPTION, so the
   * tab's accessible name stays its label: a name that changed with every
   * keystroke would be re-announced, and would no longer say which tab it is.
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
 * Fluent's `TabList`, because it brings the roving tabindex and arrow-key
 * movement the `tab` role advertises.
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
  reserveStatus,
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
  /** #1477 — keep the mark slot laid out even while no tab has a mark. */
  reserveStatus?: boolean;
}) {
  const baseId = useId();
  const [own, setOwn] = useState<K>(tabs[0].key);
  const current = selected ?? own;
  const tabId = (key: K) => `${baseId}-tab-${key}`;

  const panelId = (key: K) => `${baseId}-panel-${key}`;

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
    >
      {tabs.map((t) => (
        <Tab
          key={t.key}
          value={t.key}
          id={tabId(t.key)}
          aria-controls={panelId(t.key)}
          aria-describedby={t.status ? `${tabId(t.key)}-status` : undefined}
        >
          {t.label}
          {/* Reserved, the property dock's slot keeps its width while empty, so a
              mark arriving with the first keystroke moves no tab along. */}
          {(reserveStatus === true || t.status !== undefined) && (
            <span className="panel-tabs__status" data-tone={t.status?.tone} aria-hidden="true">
              {t.status?.glyph}
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
