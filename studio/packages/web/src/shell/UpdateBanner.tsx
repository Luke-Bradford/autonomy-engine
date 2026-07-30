import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@autonomy-studio/shared';
import { getUpdateStatus } from '../api/version';

/**
 * Announces a newer release. Phase 1 only TELLS — applying it is phase 2, so this
 * links to the release rather than offering a button that does not exist yet.
 *
 * `role="status"` rather than `alert`: an available update is informational, and
 * `alert` interrupts a screen reader mid-task for something that can wait.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getUpdateStatus(controller.signal)
      .then(setStatus)
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, []);

  if (!status?.updateAvailable || status.latest === null) return null;
  return (
    <div className="update-banner" role="status">
      Version <strong>{status.latest.version}</strong> is available (running{' '}
      {status.current.version}
      ).{' '}
      <a
        href="https://github.com/Luke-Bradford/autonomy-engine/releases/latest"
        target="_blank"
        rel="noreferrer"
      >
        Release notes
      </a>
    </div>
  );
}
