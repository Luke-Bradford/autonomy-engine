import { Tooltip } from '@fluentui/react-components';
import { NavLink } from 'react-router';
import { HUBS } from './hubs';
import { ThemeToggle } from '../theme/ThemeToggle';
import { VersionBadge } from './VersionBadge';
import type { UiStore } from '../stores/uiStore';

interface HubRailProps {
  /** Forwarded to the theme toggle; injectable for tests. */
  store?: UiStore;
}

/**
 * The 48px hub rail — the shell's primary navigation (spec: Home / Author /
 * Monitor / Manage, active highlight, theme at the foot).
 *
 * The foot also carries `VersionBadge` (the running build, from Task 2 of the
 * packaging phase 1 plan): purely informational chrome that renders nothing on
 * failure, so it sits beside the theme switch without a seam of its own.
 *
 * Active state is signalled on THREE independent channels, because the spec's
 * accessibility criteria forbid a colour-only status:
 * - `aria-current="page"` for assistive tech;
 * - the FILLED icon variant, a shape change visible without colour;
 * - a left accent bar (`.hub-rail__link--active::before`), likewise a shape.
 * Colour is the fourth, not the only.
 *
 * All three are driven by ONE source — `NavLink`'s own `isActive` — rather than
 * a parallel path-matching helper. `NavLink` sets `aria-current` itself, so a
 * hand-rolled matcher deciding the other two would be a second opinion that can
 * disagree with the first. Its semantics were checked against this version and
 * are exactly what the rail needs: `/` matches only itself (not every route
 * beneath it), `/monitor/runs/run_42` keeps Monitor lit, and matching is on a
 * segment boundary so a future `/authoring` could not light up `/author`.
 *
 * Icon-only buttons are named twice over: an `aria-label` on the link (so the
 * accessible name is not "" from an `aria-hidden` glyph) and a Fluent `Tooltip`
 * with `relationship="label"` for sighted pointer/keyboard users. The tooltip
 * uses Fluent's DEFAULT portal (to `document.body`) — the U0 spike is explicit
 * that a surface must never be reparented into the React Flow viewport, which
 * would double-apply the canvas transform.
 */
export function HubRail({ store }: HubRailProps) {
  return (
    <nav className="hub-rail" aria-label="Primary">
      {/* The app's `h1`, restored. The 220px sidebar this rail replaced carried
          `<h1>autonomy studio</h1>`; dropping it left the whole app with no h1
          at all and every page starting at h2, which breaks screen-reader
          heading navigation (and is what axe reports as `page-has-heading-one`).
          The wordmark is only wide enough for a monogram, so the real name is
          the accessible text and the glyph is decorative. */}
      <h1 className="hub-rail__brand">
        <span aria-hidden="true">as</span>
        <span className="visually-hidden">autonomy studio</span>
      </h1>
      <ul className="hub-rail__list">
        {HUBS.map((hub) => (
          <li key={hub.id}>
            <Tooltip content={hub.label} relationship="label" positioning="after">
              <NavLink
                to={hub.path}
                aria-label={hub.label}
                className={({ isActive }) =>
                  `hub-rail__link${isActive ? ' hub-rail__link--active' : ''}`
                }
              >
                {({ isActive }) => {
                  const Glyph = isActive ? hub.IconActive : hub.Icon;
                  // The glyph is decorative: the link already carries the name,
                  // and a titled SVG would make a screen reader say it twice.
                  return <Glyph aria-hidden="true" />;
                }}
              </NavLink>
            </Tooltip>
          </li>
        ))}
      </ul>
      <div className="hub-rail__foot">
        <VersionBadge />
        <ThemeToggle store={store} />
      </div>
    </nav>
  );
}
