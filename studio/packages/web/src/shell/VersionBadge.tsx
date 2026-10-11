import { Tooltip } from '@fluentui/react-components';
import { Fragment, useEffect, useState } from 'react';
import { getVersion } from '../api/version';

/**
 * The running build, in the rail foot beside the theme switch.
 *
 * Renders NOTHING on failure. This sits in the chrome of every page, so an error
 * state here would follow the user everywhere for something that is purely
 * informational — the app works identically without it.
 *
 * WRAPPING. At caption type a version is wider than the 48px rail (#1594 OR40
 * S6p; it was 9.6px and clipped), so it may break onto a second line after
 * each `.` and `-`: `2026.` / `07.30`, `0.0.0-` / `dev`. A release version
 * has no hyphen, so without the `<wbr>`s it would break wherever the line ran
 * out, mid-number. The text is unchanged; only break points are added.
 *
 * ACCESSIBLE NAME. A version is still read more easily whole, and the
 * SIGHTED case is served by the Fluent `Tooltip` (with
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
        {version.split(/(?<=[.-])/).map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <wbr />}
            {part}
          </Fragment>
        ))}
      </span>
    </Tooltip>
  );
}
