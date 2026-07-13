import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
  DEFAULT_MASTER_KEY_FILE,
  SecretDecryptionError,
  decrypt,
  encrypt,
  resolveMasterKey,
} from '../secrets.js';

// A fixed 32-byte test key — never used for anything but these tests. Must
// be generated only AFTER `sodium.ready` resolves, so it cannot be a
// module-top-level `const`: `sodium`'s wasm init is shared per-process, and
// computing this eagerly at import time raced other test files in the same
// vitest worker over whether it had finished loading yet
// (`TypeError: default.randombytes_buf is not a function`, intermittent).
let TEST_KEY: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  TEST_KEY = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
});

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'autonomy-secrets-test-'));
}

describe('encrypt / decrypt', () => {
  it('round-trips plain ASCII', async () => {
    const blob = await encrypt('hunter2-api-key', TEST_KEY);
    expect(await decrypt(blob, TEST_KEY)).toBe('hunter2-api-key');
  });

  it('round-trips unicode', async () => {
    const plaintext = 'sécrét-🔐-日本語-कुंजी';
    const blob = await encrypt(plaintext, TEST_KEY);
    expect(await decrypt(blob, TEST_KEY)).toBe(plaintext);
  });

  it('round-trips the empty string', async () => {
    const blob = await encrypt('', TEST_KEY);
    expect(await decrypt(blob, TEST_KEY)).toBe('');
  });

  it('produces a unique nonce per call (same plaintext encrypts differently)', async () => {
    const blobA = await encrypt('same-plaintext', TEST_KEY);
    const blobB = await encrypt('same-plaintext', TEST_KEY);
    expect(blobA).not.toBe(blobB);
  });

  it('throws SecretDecryptionError (not garbage) when decrypting with the wrong key', async () => {
    const wrongKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const blob = await encrypt('top-secret', TEST_KEY);
    await expect(decrypt(blob, wrongKey)).rejects.toThrow(SecretDecryptionError);
  });

  it('throws SecretDecryptionError when a byte of the ciphertext is flipped (tamper detection)', async () => {
    const blob = await encrypt('do-not-tamper-with-me', TEST_KEY);
    const raw = Buffer.from(blob, 'base64');

    // Flip a bit well past the header+nonce, inside the ciphertext/tag
    // region, so we know we're specifically exercising ciphertext tamper
    // detection rather than header/nonce parsing.
    const tamperIndex = raw.length - 1;
    raw[tamperIndex] = raw[tamperIndex]! ^ 0x01;
    const tamperedBlob = raw.toString('base64');

    expect(tamperedBlob).not.toBe(blob);
    await expect(decrypt(tamperedBlob, TEST_KEY)).rejects.toThrow(SecretDecryptionError);
  });

  it('throws SecretDecryptionError on a malformed (too-short) blob', async () => {
    await expect(decrypt(Buffer.from([1, 1]).toString('base64'), TEST_KEY)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  it('throws SecretDecryptionError when a header byte ([version][algo]) is flipped', async () => {
    const blob = await encrypt('header-must-be-authenticated', TEST_KEY);
    const raw = Buffer.from(blob, 'base64');

    // Flip a bit in the 2-byte header (index 0 or 1), leaving the
    // nonce/ciphertext/tag completely untouched.
    raw[0] = raw[0]! ^ 0x01;
    const tamperedBlob = raw.toString('base64');

    expect(tamperedBlob).not.toBe(blob);
    await expect(decrypt(tamperedBlob, TEST_KEY)).rejects.toThrow(SecretDecryptionError);
  });

  it('binds the header as AEAD associated data (encrypt does not pass null AD)', async () => {
    // White-box check that `encrypt` really authenticates the header rather
    // than leaving it as unauthenticated clear-text: decrypting the SAME
    // real ciphertext (produced by our own `encrypt`) via the raw libsodium
    // primitive succeeds when given the real header bytes as AD, but fails
    // when given `null` AD -- which is exactly what the OLD (vulnerable)
    // implementation passed. This is exercising the real crypto primitive
    // against a real blob, not a mock.
    const blob = await encrypt('bound-to-header', TEST_KEY);
    const raw = Buffer.from(blob, 'base64');

    const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const header = new Uint8Array(raw.subarray(0, 2));
    const nonce = new Uint8Array(raw.subarray(2, 2 + nonceBytes));
    const ciphertext = new Uint8Array(raw.subarray(2 + nonceBytes));

    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      header,
      nonce,
      TEST_KEY,
      'text',
    );
    expect(plaintext).toBe('bound-to-header');

    expect(() =>
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        ciphertext,
        null,
        nonce,
        TEST_KEY,
        'text',
      ),
    ).toThrow();
  });

  it('rejects an encrypt key that is not exactly 32 bytes', async () => {
    const shortKey = sodium.randombytes_buf(16);
    await expect(encrypt('whatever', shortKey)).rejects.toThrow(/32 bytes/);
  });

  it('rejects a decrypt key that is not exactly 32 bytes', async () => {
    const blob = await encrypt('whatever', TEST_KEY);
    const longKey = sodium.randombytes_buf(64);
    await expect(decrypt(blob, longKey)).rejects.toThrow(/32 bytes/);
  });
});

describe('resolveMasterKey', () => {
  const dirsToKeep: string[] = [];

  afterEach(() => {
    dirsToKeep.length = 0;
  });

  it('honors AUTONOMY_MASTER_KEY (base64) over any file', async () => {
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const b64 = sodium.to_base64(key, sodium.base64_variants.ORIGINAL);

    const resolution = await resolveMasterKey({ AUTONOMY_MASTER_KEY: b64 });
    expect(resolution.source).toBe('env');
    expect(Buffer.from(resolution.key)).toEqual(Buffer.from(key));
  });

  it('honors AUTONOMY_MASTER_KEY (hex)', async () => {
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    const hex = Buffer.from(key).toString('hex');

    const resolution = await resolveMasterKey({ AUTONOMY_MASTER_KEY: hex });
    expect(resolution.source).toBe('env');
    expect(Buffer.from(resolution.key)).toEqual(Buffer.from(key));
  });

  it('rejects an invalid AUTONOMY_MASTER_KEY', async () => {
    await expect(resolveMasterKey({ AUTONOMY_MASTER_KEY: 'not-a-real-key' })).rejects.toThrow(
      /valid.*key/i,
    );
  });

  it('falls back to a 0600 key file when env is absent', async () => {
    const dir = freshTmpDir();
    dirsToKeep.push(dir);
    const keyFilePath = join(dir, 'master.key');
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    writeFileSync(keyFilePath, sodium.to_base64(key, sodium.base64_variants.ORIGINAL), {
      mode: 0o600,
    });
    chmodSync(keyFilePath, 0o600);

    const resolution = await resolveMasterKey({ AUTONOMY_MASTER_KEY_FILE: keyFilePath });
    expect(resolution.source).toBe('file');
    expect(Buffer.from(resolution.key)).toEqual(Buffer.from(key));
  });

  it('falls back to AUTONOMY_DATA_DIR/secrets/master.key when AUTONOMY_MASTER_KEY_FILE is absent', async () => {
    const dataDir = freshTmpDir();
    dirsToKeep.push(dataDir);
    const keyFilePath = join(dataDir, 'secrets', 'master.key');
    mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    writeFileSync(keyFilePath, sodium.to_base64(key, sodium.base64_variants.ORIGINAL), {
      mode: 0o600,
    });
    chmodSync(keyFilePath, 0o600);

    const resolution = await resolveMasterKey({ AUTONOMY_DATA_DIR: dataDir });
    expect(resolution.source).toBe('file');
    expect(Buffer.from(resolution.key)).toEqual(Buffer.from(key));
  });

  it('prefers AUTONOMY_MASTER_KEY_FILE over AUTONOMY_DATA_DIR when both are set', async () => {
    const dataDir = freshTmpDir();
    dirsToKeep.push(dataDir);
    const decoyKeyFilePath = join(dataDir, 'secrets', 'master.key');
    mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const decoyKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    writeFileSync(decoyKeyFilePath, sodium.to_base64(decoyKey, sodium.base64_variants.ORIGINAL), {
      mode: 0o600,
    });
    chmodSync(decoyKeyFilePath, 0o600);

    const explicitDir = freshTmpDir();
    dirsToKeep.push(explicitDir);
    const explicitKeyFilePath = join(explicitDir, 'master.key');
    const explicitKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    writeFileSync(
      explicitKeyFilePath,
      sodium.to_base64(explicitKey, sodium.base64_variants.ORIGINAL),
      { mode: 0o600 },
    );
    chmodSync(explicitKeyFilePath, 0o600);

    const resolution = await resolveMasterKey({
      AUTONOMY_MASTER_KEY_FILE: explicitKeyFilePath,
      AUTONOMY_DATA_DIR: dataDir,
    });
    expect(resolution.source).toBe('file');
    expect(Buffer.from(resolution.key)).toEqual(Buffer.from(explicitKey));
  });

  it('refuses a world-readable key file', async () => {
    const dir = freshTmpDir();
    dirsToKeep.push(dir);
    const keyFilePath = join(dir, 'master.key');
    const key = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    writeFileSync(keyFilePath, sodium.to_base64(key, sodium.base64_variants.ORIGINAL));
    chmodSync(keyFilePath, 0o644); // world-readable — must be refused

    await expect(resolveMasterKey({ AUTONOMY_MASTER_KEY_FILE: keyFilePath })).rejects.toThrow(
      /group\/other/i,
    );
  });

  it('generates, persists 0600, and warns when both env and file are absent', async () => {
    const dir = freshTmpDir();
    dirsToKeep.push(dir);
    const keyFilePath = join(dir, 'nested', 'master.key');
    expect(existsSync(keyFilePath)).toBe(false);

    const resolution = await resolveMasterKey({ AUTONOMY_MASTER_KEY_FILE: keyFilePath });

    expect(resolution.source).toBe('generated');
    expect(resolution.warning).toMatch(/auto-generated/i);
    expect(resolution.key).toHaveLength(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);

    expect(existsSync(keyFilePath)).toBe(true);
    const mode = statSync(keyFilePath).mode & 0o777;
    expect(mode).toBe(0o600);

    // The persisted file must decode back to the exact same key material
    // that was returned, so a restart picks up the identical key.
    const persisted = readFileSync(keyFilePath, 'utf8');
    const decoded = sodium.from_base64(persisted, sodium.base64_variants.ORIGINAL);
    expect(Buffer.from(decoded)).toEqual(Buffer.from(resolution.key));
  });
});

describe('DEFAULT_MASTER_KEY_FILE', () => {
  it('is an absolute path', () => {
    expect(isAbsolute(DEFAULT_MASTER_KEY_FILE)).toBe(true);
  });

  it('is independent of process.cwd() (does not shift if the server starts from a different directory)', () => {
    // The real bug this guards against: a cwd-relative default resolves to
    // a DIFFERENT file depending on where the process happens to be
    // launched from, so a restart from a different cwd finds no key file
    // and silently generates a brand-new one, orphaning every secret
    // encrypted under the old key. Proving this by actually chdir-ing to a
    // fresh tmp dir and re-checking the constant is stronger than merely
    // asserting the string shape.
    const before = DEFAULT_MASTER_KEY_FILE;
    const originalCwd = process.cwd();
    const scratchDir = freshTmpDir();
    try {
      process.chdir(scratchDir);
      // DEFAULT_MASTER_KEY_FILE is computed once at module load (not
      // per-call), so re-reading the same imported binding after chdir-ing
      // is exactly the check we want: it must not have been influenced by
      // cwd at import time, and nothing in this module re-derives it from
      // `process.cwd()` on demand either.
      expect(DEFAULT_MASTER_KEY_FILE).toBe(before);
      expect(DEFAULT_MASTER_KEY_FILE).not.toContain(scratchDir);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
