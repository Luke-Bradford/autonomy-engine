/**
 * Encrypted-file-primary secret storage (P0c spike).
 *
 * THREAT MODEL — read this before wiring this into anything:
 * - Encryption at rest protects the SECRET FILE / DATABASE VOLUME if it is
 *   stolen, copied, backed up somewhere less trusted, or read by another
 *   process/user on a shared machine. That is the attack this module
 *   defends against.
 * - It does NOT protect against a compromised host with the server running:
 *   if an attacker has code execution as this process (or root), they can
 *   read `AUTONOMY_MASTER_KEY` / the key file / process memory and decrypt
 *   everything, same as the legitimate server can. There is no secret this
 *   module can keep from an attacker who already controls the runtime.
 * - Secrets are never logged, never returned to a client in plaintext, and
 *   never echoed back through error messages. Decrypt failures raise a
 *   generic `SecretDecryptionError` with no plaintext or key material in it.
 * - No silent plaintext fallback, ever: if a master key cannot be resolved
 *   through env/file, one is generated — loudly, with a warning that must
 *   reach an operator, never silently degrading to storing secrets in the
 *   clear.
 */

import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import sodium from 'libsodium-wrappers';

export type MasterKeySource = 'env' | 'file' | 'generated';

export interface MasterKeyResolution {
  /** Raw 32-byte key material. Never log this. */
  key: Uint8Array;
  source: MasterKeySource;
  /** Set (and already logged) only when `source === 'generated'`. */
  warning?: string;
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export const DEFAULT_MASTER_KEY_FILE = 'data/secrets/master.key';

const BLOB_VERSION = 1;
/** Algorithm tag byte — 1 == XChaCha20-Poly1305-IETF (the only kind so far). */
const ALGO_XCHACHA20POLY1305_IETF = 1;
const HEADER_BYTES = 2;
/**
 * Byte length of an XChaCha20-Poly1305 (IETF) key. Checked explicitly at the
 * top of `encrypt`/`decrypt` — a clear, immediate error beats relying on
 * libsodium's own (less specific) internal validation of a bad key.
 */
const KEY_BYTES = 32;

let sodiumReady: Promise<typeof sodium> | undefined;

/** Lazily awaits `sodium.ready` exactly once and hands back the module. */
async function loadSodium(): Promise<typeof sodium> {
  sodiumReady ??= sodium.ready.then(() => sodium);
  return sodiumReady;
}

function decodeKeyMaterial(
  raw: string,
  expectedBytes: number,
  s: typeof sodium,
): Uint8Array | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Hex is unambiguous at the exact expected length (base64 of the same
  // byte count is a different length), so check it first.
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === expectedBytes * 2) {
    return Uint8Array.from(Buffer.from(trimmed, 'hex'));
  }

  for (const variant of [
    s.base64_variants.ORIGINAL,
    s.base64_variants.URLSAFE_NO_PADDING,
    s.base64_variants.ORIGINAL_NO_PADDING,
    s.base64_variants.URLSAFE,
  ]) {
    try {
      const decoded = s.from_base64(trimmed, variant);
      if (decoded.length === expectedBytes) return decoded;
    } catch {
      // Try the next variant.
    }
  }
  return null;
}

/**
 * Opens `path` once and performs the permission check and the read against
 * that SAME file descriptor — never re-opening by path partway through —
 * so a swap/symlink race between the permission check and the subsequent
 * read (TOCTOU) cannot substitute a different file after the check passes.
 * `statSync(path)` followed by `readFileSync(path)` are two separate
 * syscalls against the path and are racy; `fstatSync(fd)` + reading from
 * that fd are not.
 *
 * POSIX-oriented: refuses a key file that grants ANY group/other
 * permission bits. On platforms without POSIX mode bits (Windows) this
 * check is best-effort — `stat` mode there does not reflect the real ACL,
 * so it can only catch the POSIX-style cases, not Windows ACL misconfigs.
 *
 * Returns `null` if `path` does not exist (caller falls through to key
 * generation); throws if it exists but is not sufficiently locked down, or
 * on any other I/O error.
 */
function readKeyFileSecurely(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  try {
    const mode = fstatSync(fd).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to use master key file at "${path}": mode ${mode.toString(8)} grants group/other ` +
          `access. Fix with \`chmod 600 ${path}\` before restarting.`,
      );
    }

    const chunks: Buffer[] = [];
    const readBuffer = Buffer.alloc(4096);
    let bytesRead: number;
    while ((bytesRead = readSync(fd, readBuffer, 0, readBuffer.length, null)) > 0) {
      chunks.push(Buffer.from(readBuffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolves the 32-byte master key used to encrypt/decrypt all secrets, in
 * order: `AUTONOMY_MASTER_KEY` env (base64 or hex) → a mounted key file at
 * `AUTONOMY_MASTER_KEY_FILE` (default `data/secrets/master.key`, must be
 * 0600) → generate a new key, persist it 0600, and return/log a loud
 * warning. Never silently falls back to plaintext.
 */
export async function resolveMasterKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MasterKeyResolution> {
  const s = await loadSodium();
  const keyBytes = s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;

  const envKey = env.AUTONOMY_MASTER_KEY;
  if (envKey !== undefined && envKey !== '') {
    const decoded = decodeKeyMaterial(envKey, keyBytes, s);
    if (!decoded) {
      throw new Error(
        `AUTONOMY_MASTER_KEY is set but is not a valid ${keyBytes}-byte key (expected base64 or hex)`,
      );
    }
    return { key: decoded, source: 'env' };
  }

  const keyFilePath = env.AUTONOMY_MASTER_KEY_FILE ?? DEFAULT_MASTER_KEY_FILE;
  const raw = readKeyFileSecurely(keyFilePath);
  if (raw !== null) {
    const decoded = decodeKeyMaterial(raw, keyBytes, s);
    if (!decoded) {
      throw new Error(
        `Master key file at "${keyFilePath}" does not contain a valid ${keyBytes}-byte key`,
      );
    }
    return { key: decoded, source: 'file' };
  }

  const generated = s.randombytes_buf(keyBytes);
  mkdirSync(dirname(keyFilePath), { recursive: true });
  writeFileSync(keyFilePath, s.to_base64(generated, s.base64_variants.ORIGINAL), {
    mode: 0o600,
  });
  chmodSync(keyFilePath, 0o600); // belt-and-braces against a permissive umask
  const warning =
    `AUTONOMY MASTER KEY WAS AUTO-GENERATED at "${keyFilePath}". This key encrypts ` +
    'ALL secrets at rest — back it up now (a password manager or your infra secrets ' +
    'store), or every existing secret becomes permanently undecryptable if this file ' +
    'is lost. Set AUTONOMY_MASTER_KEY or AUTONOMY_MASTER_KEY_FILE to pin your own key ' +
    'instead of relying on auto-generation.';
  console.warn(warning);
  return { key: generated, source: 'generated', warning };
}

/**
 * Encrypts `plaintext` with XChaCha20-Poly1305 (IETF) under `key`, returning
 * a single self-describing base64 blob: `[version][algo][nonce][ciphertext+tag]`.
 * A fresh random nonce is drawn for every call. The `[version][algo]` header
 * is passed to the AEAD as associated data (authenticated but not
 * encrypted), so `decrypt` fails the auth-tag check if either header byte is
 * altered in transit/at rest — the header is no longer just clear-text
 * trusted at face value.
 */
export async function encrypt(plaintext: string, key: Uint8Array): Promise<string> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encrypt: key must be exactly ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const s = await loadSodium();
  const header = new Uint8Array([BLOB_VERSION, ALGO_XCHACHA20POLY1305_IETF]);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    header,
    null,
    nonce,
    key,
  );

  const blob = Buffer.concat([Buffer.from(header), Buffer.from(nonce), Buffer.from(ciphertext)]);
  return blob.toString('base64');
}

/**
 * Decrypts a blob produced by `encrypt`. Verifies the Poly1305 auth tag over
 * the ciphertext AND the `[version][algo]` header (passed back in as
 * associated data, matching `encrypt`); throws `SecretDecryptionError`
 * (never returns garbage) on a tampered blob (including a tampered header),
 * a wrong key, or a malformed/unsupported blob.
 */
export async function decrypt(blob: string, key: Uint8Array): Promise<string> {
  if (key.length !== KEY_BYTES) {
    throw new Error(`decrypt: key must be exactly ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const s = await loadSodium();
  const nonceBytes = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const tagBytes = s.crypto_aead_xchacha20poly1305_ietf_ABYTES;

  let raw: Buffer;
  try {
    raw = Buffer.from(blob, 'base64');
  } catch {
    throw new SecretDecryptionError('Malformed secret blob (not valid base64)');
  }

  if (raw.length < HEADER_BYTES + nonceBytes + tagBytes) {
    throw new SecretDecryptionError('Malformed secret blob (too short)');
  }

  const version = raw[0];
  const algo = raw[1];
  if (version !== BLOB_VERSION || algo !== ALGO_XCHACHA20POLY1305_IETF) {
    throw new SecretDecryptionError(`Unsupported secret blob version/algo (${version}/${algo})`);
  }

  const header = new Uint8Array(raw.subarray(0, HEADER_BYTES));
  const nonce = new Uint8Array(raw.subarray(HEADER_BYTES, HEADER_BYTES + nonceBytes));
  const ciphertext = new Uint8Array(raw.subarray(HEADER_BYTES + nonceBytes));

  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      header,
      nonce,
      key,
      'text',
    );
  } catch {
    // libsodium throws on auth-tag mismatch (tampered ciphertext, tampered
    // header, or wrong key) — surface a clear, non-leaky domain error, never
    // partial output.
    throw new SecretDecryptionError('Failed to decrypt secret (tampered blob or wrong key)');
  }
}
