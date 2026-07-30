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
 * wider than the rail at 0.6rem). Clipping is purely visual — it does not
 * remove the text node from the accessibility tree — so the string was
 * already reachable by AT without any extra role or tab stop; what clipping
 * actually breaks is the SIGHTED case, which the Fluent `Tooltip` (with
 * `relationship="label"` for a pinned accessible name, matching
 * `ThemeToggle`'s pattern) fixes on its own. The span stays a plain,
 * non-interactive `generic` element: no `role="status"` (this is not a live
 * region — the version does not update after mount, so there is nothing to
 * announce, and giving it a live-region role would have every page load
 * politely narrate the version to a screen reader) and no `tabIndex` (a
 * non-actionable tab stop in the global Tab sequence, present on every page).
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
      <span className="version-badge" aria-label={version}>
        {version}
      </span>
    </Tooltip>
  );
}
