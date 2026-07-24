import { Tooltip } from '@fluentui/react-components';
import { PanelLeftContractRegular, PanelLeftExpandRegular } from '@fluentui/react-icons';
import { Link } from 'react-router';
import { PANE_ELEMENT_ID } from './SecondaryPane';
import type { Crumb } from './routeHandle';

interface CommandBarProps {
  /** Outermost first; the last is the current page. */
  crumbs: Crumb[];
  /** Absent for a hub with no secondary pane — then there is nothing to toggle. */
  pane?: { collapsed: boolean; onToggle: () => void };
}

/**
 * The shell's command bar (U3): the pane toggle and the breadcrumb.
 *
 * NO ACTIONS REGION YET. The spec's shell diagram shows `Validate` and
 * `Save(→v)` here, but those are **U9**'s row, and they need canvas state this
 * bar has no access to. An empty labelled container shipped now would be dead
 * code plus a seam chosen before its first consumer exists; U9 adds the region
 * together with the first action that goes in it.
 *
 * The toggle lives HERE rather than at the pane's foot, where the spec diagram
 * draws `«collapse`. A control inside the pane disappears when the pane
 * collapses, which forces a second "expand" control somewhere else — two
 * controls, two code paths, two things to keep in sync, for one boolean. One
 * always-present disclosure button is also what `aria-expanded` is designed
 * for. It is absent entirely on a hub with no pane (Home), because a
 * disclosure button controlling nothing is worse than no button.
 *
 * The breadcrumb is a plain `<nav><ol>` rather than Fluent's `Breadcrumb`,
 * which IS installed and re-exported by `@fluentui/react-components`. The
 * reasons are bundle and plumbing, not capability: the U0 spike measured
 * Fluent's barrel at +64 kB gzip in one un-split chunk and set a budget, and
 * Fluent's slots take an intrinsic element for `as`, not a component — so
 * routing react-router through `BreadcrumbButton` means hand-wiring
 * `useHref` + `useLinkClickHandler` per crumb, which is more code than the
 * `<ol>` it would replace. The rail is already a plain `<nav><ul>` for the same
 * reason; Fluent tokens still theme both through the app's CSS variables.
 */
export function CommandBar({ crumbs, pane }: CommandBarProps) {
  const label = pane?.collapsed ? 'Show navigation pane' : 'Hide navigation pane';
  const ToggleIcon = pane?.collapsed ? PanelLeftExpandRegular : PanelLeftContractRegular;

  return (
    <div className="command-bar">
      {pane && (
        /* Named twice over, like the rail's icon-only links: an `aria-label` so
           the accessible name is not "" from an `aria-hidden` glyph, and a
           Fluent tooltip for sighted pointer/keyboard users. Fluent's DEFAULT
           body portal — the U0 spike forbids reparenting a surface into the
           React Flow viewport, which would double-apply the canvas transform. */
        <Tooltip content={label} relationship="label" positioning="below">
          <button
            type="button"
            className="command-bar__pane-toggle"
            aria-label={label}
            aria-expanded={!pane.collapsed}
            aria-controls={PANE_ELEMENT_ID}
            onClick={pane.onToggle}
          >
            <ToggleIcon aria-hidden="true" />
          </button>
        </Tooltip>
      )}

      {crumbs.length > 0 && (
        <nav className="command-bar__breadcrumb" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((crumb, index) => {
              /* The last crumb is where you already are. A link to the current
                 page is a no-op the user cannot tell apart from a broken one,
                 so it is plain text carrying `aria-current="page"` instead. */
              const isCurrent = index === crumbs.length - 1;
              return (
                <li key={crumb.to}>
                  {isCurrent ? (
                    <span aria-current="page">{crumb.label}</span>
                  ) : (
                    <Link to={crumb.to}>{crumb.label}</Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </div>
  );
}
