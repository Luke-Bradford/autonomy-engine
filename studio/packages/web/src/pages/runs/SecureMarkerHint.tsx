import { SECURE_REDACTED, SECURE_REDACTED_INVALID } from '@autonomy-studio/shared';
import { isSecureMarker } from './secureMarker';

/**
 * What the marker means, shown beside any value that carries it. Without this
 * the run page printed `[redacted: secure]` with nothing to say why, or where
 * the setting that caused it lives.
 */
export function SecureMarkerHint({ values }: { values: readonly unknown[] }) {
  if (!values.some(isSecureMarker)) return null;
  return (
    <p className="page-hint">
      <code>{SECURE_REDACTED}</code> marks a value withheld from the run log: this node&rsquo;s run
      policy has Secure output set, so its outputs were redacted before they were recorded.
      {values.includes(SECURE_REDACTED_INVALID) && (
        <>
          {' '}
          <code>{SECURE_REDACTED_INVALID}</code> means the withheld value also did not match its
          declared output type.
        </>
      )}
    </p>
  );
}
