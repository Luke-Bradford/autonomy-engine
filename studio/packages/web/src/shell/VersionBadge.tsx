import { Tooltip } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import { getVersion } from '../api/version';

/**
 * The running build, in the rail foot beside the theme switch.
 *
 * Renders NOTHING on failure. This sits in the chrome of every page, so an error
 * state here would follow the user everywhere for something that is purely
 * informational — the app works identically without it.
 *
 * ACCESSIBLE NAME. The visible text clips inside the 48px rail (it measures
 * wider than the rail at 0.6rem), so a sighted mouse user relies on the
 * Tooltip and a keyboard/AT user relies on the accessible name — neither of
 * which a bare `title` attribute reliably provides (not consistently exposed
 * to screen readers, and a `title` on a non-interactive element is not
 * keyboard-reachable at all). Matches `ThemeToggle`'s pattern instead: a
 * Fluent `Tooltip` with `relationship="label"` for sighted pointer/keyboard
 * users, plus an explicit `aria-label` so the accessible name is pinned
 * regardless of which mechanism a given AT honours (the same belt-and-braces
 * reasoning `ThemeToggle` documents — the trigger's own `aria-label` wins over
 * whatever the tooltip would set, so the two cannot disagree).
 * `role="status"` (this codebase's existing convention for a span carrying
 * meaningful text — see `RunDetailPage.tsx`, `TriggersPage.tsx`,
 * `ActivityToolbox.tsx`) rather than the default `generic` role a bare `span`
 * gets: `generic` is a structural, name-less role in the ARIA sense, so an
 * `aria-label` on one is not guaranteed to reach a screen reader even though a
 * DOM query can still find it — this needs the real thing, not just a
 * test-passing shape. `tabIndex={0}` makes the (otherwise non-interactive)
 * span focusable, which is what makes the tooltip keyboard-reachable at all.
 */
export function VersionBadge(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getVersion(controller.signal)
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(null));
    return () => controller.abort();
  }, []);

  if (version === null) return null;
  return (
    <Tooltip content={version} relationship="label" positioning="after">
      <span className="version-badge" role="status" tabIndex={0} aria-label={version}>
        {version}
      </span>
    </Tooltip>
  );
}
