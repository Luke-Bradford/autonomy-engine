import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * P4c — webhook request authentication (pure, clock-injected).
 *
 * A webhook caller proves it holds the trigger's per-trigger secret by signing
 * `${timestamp}.${rawBody}` with HMAC-SHA256 and sending:
 *   - `x-webhook-timestamp`: unix SECONDS (integer string).
 *   - `x-webhook-signature`: `sha256=<lowercase-hex>` of that HMAC.
 *
 * Verification is FAIL-CLOSED: any missing/malformed header, a timestamp
 * outside the tolerance window (replay/stale protection), or a signature
 * mismatch returns `{ ok: false }` and the caller MUST NOT fire. The timestamp
 * is part of the signed message, so an attacker cannot slide a captured
 * signature onto a fresh timestamp — changing the timestamp invalidates the
 * signature. Signing the RAW body bytes (not a re-serialized parse) means the
 * check is over exactly what was received.
 */

/** Default replay tolerance: a delivery whose timestamp is more than this many
 * seconds from the server clock (in either direction) is rejected. */
export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

const SIGNATURE_PREFIX = 'sha256=';

export interface WebhookAuthHeaders {
  /** `x-webhook-timestamp` — unix seconds as a string. */
  timestamp: string | undefined;
  /** `x-webhook-signature` — `sha256=<hex>`. */
  signature: string | undefined;
}

export interface VerifyWebhookParams {
  /** The per-trigger secret (plaintext), resolved from `webhook.secretRef`. */
  secret: string;
  /** The EXACT request body bytes (never a re-serialized parse). */
  rawBody: Buffer;
  headers: WebhookAuthHeaders;
  /** Server clock in ms, injected for deterministic testing. */
  nowMs: number;
  /** Replay window in seconds; defaults to `DEFAULT_WEBHOOK_TOLERANCE_SEC`. */
  toleranceSec?: number;
}

export type VerifyWebhookResult = { ok: true } | { ok: false; reason: string };

/**
 * The canonical signature for a delivery: `sha256=<hex>` over
 * `${timestamp}.` concatenated with the raw body bytes. Exported so a client
 * (and the tests) sign exactly the way the server verifies.
 */
export function signWebhook(secret: string, timestamp: string, rawBody: Buffer): string {
  const message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/** Constant-time string compare that never throws on a length mismatch
 * (`timingSafeEqual` requires equal-length buffers). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyWebhook(params: VerifyWebhookParams): VerifyWebhookResult {
  const tolerance = params.toleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
  const { timestamp, signature } = params.headers;

  if (timestamp === undefined || timestamp === '') {
    return { ok: false, reason: 'missing timestamp' };
  }
  // Strict integer seconds — reject anything Number() would coerce loosely
  // (e.g. "12 ", "0x1f", "1e3"): only optional leading `-` then digits.
  if (!/^-?\d+$/.test(timestamp)) {
    return { ok: false, reason: 'malformed timestamp' };
  }
  const tsSec = Number(timestamp);
  const nowSec = Math.floor(params.nowMs / 1000);
  if (Math.abs(nowSec - tsSec) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  if (signature === undefined || signature === '') {
    return { ok: false, reason: 'missing signature' };
  }
  const expected = signWebhook(params.secret, timestamp, params.rawBody);
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
