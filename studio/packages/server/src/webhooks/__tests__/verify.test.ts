import { describe, expect, it } from 'vitest';
import { DEFAULT_WEBHOOK_TOLERANCE_SEC, signWebhook, verifyWebhook } from '../verify.js';

const SECRET = 'top-secret-webhook-key';
const NOW_MS = 1_700_000_000_000; // fixed clock
const NOW_SEC = Math.floor(NOW_MS / 1000);

function headersFor(rawBody: Buffer, opts?: { secret?: string; tsSec?: number }) {
  const tsSec = opts?.tsSec ?? NOW_SEC;
  const timestamp = String(tsSec);
  const signature = signWebhook(opts?.secret ?? SECRET, timestamp, rawBody);
  return { timestamp, signature };
}

describe('verifyWebhook', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

  it('accepts a correctly-signed, in-window request', () => {
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: headersFor(body),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('accepts an empty body signed correctly', () => {
    const empty = Buffer.alloc(0);
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: empty,
      headers: headersFor(empty),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a wrong secret', () => {
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: headersFor(body, { secret: 'wrong-secret' }),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const headers = headersFor(body);
    const tampered = Buffer.from(JSON.stringify({ hello: 'evil' }), 'utf8');
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: tampered,
      headers,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a stale timestamp (replay beyond tolerance)', () => {
    const staleSec = NOW_SEC - DEFAULT_WEBHOOK_TOLERANCE_SEC - 1;
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: headersFor(body, { tsSec: staleSec }),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('rejects a future timestamp beyond tolerance', () => {
    const futureSec = NOW_SEC + DEFAULT_WEBHOOK_TOLERANCE_SEC + 1;
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: headersFor(body, { tsSec: futureSec }),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('accepts a timestamp exactly at the tolerance boundary', () => {
    const edgeSec = NOW_SEC - DEFAULT_WEBHOOK_TOLERANCE_SEC;
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: headersFor(body, { tsSec: edgeSec }),
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a captured signature slid onto a fresh timestamp', () => {
    // Attacker keeps a valid (old) signature but swaps in a current timestamp
    // to beat the window — the timestamp is signed, so it no longer verifies.
    const oldSec = NOW_SEC - 10;
    const captured = signWebhook(SECRET, String(oldSec), body);
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: { timestamp: String(NOW_SEC), signature: captured },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects missing headers', () => {
    expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: body,
        headers: { timestamp: undefined, signature: 'sha256=abc' },
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: 'missing timestamp' });
    expect(
      verifyWebhook({
        secret: SECRET,
        rawBody: body,
        headers: { timestamp: String(NOW_SEC), signature: undefined },
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: false, reason: 'missing signature' });
  });

  it('rejects a malformed (non-integer) timestamp', () => {
    const result = verifyWebhook({
      secret: SECRET,
      rawBody: body,
      headers: { timestamp: '1e3', signature: 'sha256=abc' },
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed timestamp' });
  });
});
