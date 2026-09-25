import { SECURE_REDACTED, SECURE_REDACTED_INVALID } from '@autonomy-studio/shared';

/**
 * #1312 — is `value` one of F4's redaction markers? A secure node's outputs are
 * replaced by these at EMIT time (`redactSecureEvent`), so the run page only
 * ever holds the marker, never the value behind it.
 */
export function isSecureMarker(value: unknown): boolean {
  return value === SECURE_REDACTED || value === SECURE_REDACTED_INVALID;
}
