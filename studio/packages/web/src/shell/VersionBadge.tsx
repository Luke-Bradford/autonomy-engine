import { useEffect, useState } from 'react';
import { getVersion } from '../api/version';

/**
 * The running build, in the rail foot beside the theme switch.
 *
 * Renders NOTHING on failure. This sits in the chrome of every page, so an error
 * state here would follow the user everywhere for something that is purely
 * informational — the app works identically without it.
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
    <span className="version-badge" title={`studio ${version}`}>
      {version}
    </span>
  );
}
