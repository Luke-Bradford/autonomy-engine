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

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
 * POSIX-oriented: refuses a key file that grants ANY group/other
 * permission bits. On platforms without POSIX mode bits (Windows) this
 * check is best-effort — `stat` mode there does not reflect the real ACL,
 * so it can only catch the POSIX-style cases, not Windows ACL misconfigs.
 */
function assertKeyFilePermissionsAreSecure(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use master key file at "${path}": mode ${mode.toString(8)} grants group/other ` +
        `access. Fix with \`chmod 600 ${path}\` before restarting.`,
    );
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
  if (existsSync(keyFilePath)) {
    assertKeyFilePermissionsAreSecure(keyFilePath);
    const raw = readFileSync(keyFilePath, 'utf8');
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
 * A fresh random nonce is drawn for every call.
 */
export async function encrypt(plaintext: string, key: Uint8Array): Promise<string> {
  const s = await loadSodium();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    key,
  );

  const blob = Buffer.concat([
    Buffer.from([BLOB_VERSION, ALGO_XCHACHA20POLY1305_IETF]),
    Buffer.from(nonce),
    Buffer.from(ciphertext),
  ]);
  return blob.toString('base64');
}

/**
 * Decrypts a blob produced by `encrypt`. Verifies the Poly1305 auth tag;
 * throws `SecretDecryptionError` (never returns garbage) on a tampered
 * blob, a wrong key, or a malformed/unsupported blob.
 */
export async function decrypt(blob: string, key: Uint8Array): Promise<string> {
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

  const nonce = new Uint8Array(raw.subarray(HEADER_BYTES, HEADER_BYTES + nonceBytes));
  const ciphertext = new Uint8Array(raw.subarray(HEADER_BYTES + nonceBytes));

  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key, 'text');
  } catch {
    // libsodium throws on auth-tag mismatch (tampered ciphertext or wrong
    // key) — surface a clear, non-leaky domain error, never partial output.
    throw new SecretDecryptionError('Failed to decrypt secret (tampered blob or wrong key)');
  }
}
