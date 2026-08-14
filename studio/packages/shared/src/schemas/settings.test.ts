import { describe, expect, it } from 'vitest';
import { AppSettingsSchema, MasterKeyStatusSchema } from './settings.js';

describe('MasterKeyStatusSchema', () => {
  it('accepts a file-backed key with its absolute path', () => {
    const parsed = MasterKeyStatusSchema.parse({
      source: 'file',
      keyFilePath: '/home/op/.autonomy-studio/secrets/master.key',
    });
    expect(parsed.keyFilePath).toBe('/home/op/.autonomy-studio/secrets/master.key');
  });

  it('accepts an env-provided key with no path', () => {
    expect(MasterKeyStatusSchema.parse({ source: 'env', keyFilePath: null })).toEqual({
      source: 'env',
      keyFilePath: null,
    });
  });

  /*
   * The two halves of the "iff" are separate cases because they fail for
   * opposite reasons, and each has a distinct consequence on the page. A
   * pathless `generated` renders the back-it-up advisory without naming the
   * file to back up — the advisory's only actionable content. A path on an
   * `env` key is the reverse: it points the operator at a file that is not
   * what the server is actually using.
   */
  it.each(['file', 'generated'] as const)('refuses a %s key with no path', (source) => {
    const result = MasterKeyStatusSchema.safeParse({ source, keyFilePath: null });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['keyFilePath']);
  });

  it('refuses an env key that reports a path', () => {
    const result = MasterKeyStatusSchema.safeParse({ source: 'env', keyFilePath: '/tmp/x.key' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['keyFilePath']);
  });

  it('refuses an empty path rather than treating "" as a location', () => {
    expect(MasterKeyStatusSchema.safeParse({ source: 'file', keyFilePath: '' }).success).toBe(
      false,
    );
  });

  it('refuses a source the page has no sentence for', () => {
    expect(
      MasterKeyStatusSchema.safeParse({ source: 'keychain', keyFilePath: '/tmp/x.key' }).success,
    ).toBe(false);
  });
});

describe('AppSettingsSchema', () => {
  /*
   * The guard against the one mistake this surface must never make. `z.object`
   * strips unknown keys, so a stray field cannot reach the client THROUGH the
   * schema — but only if every producer goes through it. This pins the shape
   * itself, so widening the status object with anything key-shaped has to be a
   * deliberate edit here as well as at the source.
   */
  it('carries the master key PROVENANCE and nothing else', () => {
    const parsed = AppSettingsSchema.parse({
      masterKey: { source: 'generated', keyFilePath: '/data/secrets/master.key' },
    });
    expect(Object.keys(parsed)).toEqual(['masterKey']);
    expect(Object.keys(parsed.masterKey).sort()).toEqual(['keyFilePath', 'source']);
  });

  it('strips a key smuggled onto the status object', () => {
    const parsed = AppSettingsSchema.parse({
      masterKey: {
        source: 'file',
        keyFilePath: '/data/secrets/master.key',
        key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    });
    expect(parsed.masterKey).not.toHaveProperty('key');
  });
});
