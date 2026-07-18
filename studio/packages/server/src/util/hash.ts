import { createHash } from 'node:crypto';

/**
 * `sha256(input)` as lowercase hex. The single SSOT for a content fingerprint,
 * reused by the external-wait token at-rest handle (`hashExternalWaitToken`) and
 * the #2 L9 LLM prompt/completion capture (`buildCapture`).
 *
 * NOTE ON REDACTION: this is a plain (unsalted) fingerprint — good for detecting
 * prompt DRIFT / reproducibility (identical content ⇒ identical hash) but NOT a
 * redaction guarantee: a short or low-entropy input is a brute-forceable oracle.
 * L9's capture stores it only because no field is D8-secure yet (F4 unlanded);
 * when F4 lands, a field marked secure must switch to a keyed HMAC (see
 * `deriveExternalWaitToken`'s `createHmac`) so the fingerprint stops leaking.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
