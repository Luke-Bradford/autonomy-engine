import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppSettingsSchema } from '@autonomy-studio/shared';
import { buildTestApp, buildTestAppWithContext } from '../../__tests__/build-test-app.js';

/**
 * A key file the resolver will accept: 32 bytes, base64, mode 0600.
 *
 * `readKeyFileSecurely` refuses ANY group/other permission bit, so the mode is
 * load-bearing — written through `writeFileSync`'s `mode` rather than left to
 * the process umask, which would produce 0644 and make the resolver throw.
 */
function writeKeyFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 });
  return path;
}

describe('GET /api/settings', () => {
  it('reports a key file as its source, by absolute path', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-settings-'));
    const keyFile = writeKeyFile(join(tmpDir, 'master.key'));
    const { app } = await buildTestAppWithContext({ masterKeyFile: keyFile });

    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(AppSettingsSchema.parse(res.json())).toEqual({
      masterKey: { source: 'file', keyFilePath: keyFile },
    });

    await app.close();
  });

  /*
   * The DEFAULT test app points at a key file that does not exist, so this is
   * the first-run path — the one the whole surface exists for. It is also what
   * the e2e sees, since `playwright.config.ts` blanks both key env vars and
   * `reset-state.mjs` wipes the data dir before the server boots.
   */
  it('reports a first-run auto-generated key, naming the file it wrote', async () => {
    const app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = AppSettingsSchema.parse(res.json());
    expect(body.masterKey.source).toBe('generated');
    expect(body.masterKey.keyFilePath).toMatch(/master\.key$/);

    await app.close();
  });

  /*
   * The response must carry the key's PROVENANCE and nothing else. Asserted on
   * the RAW body rather than a parsed one: `AppSettingsSchema.parse` strips
   * unknown keys, so parsing first would make this pass no matter what the
   * server actually serialized — the mutation that proves it is widening the
   * object `masterKeyStatusOf` builds, which only the raw body can see.
   */
  it('serves no key material', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });

    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['masterKey']);
    expect(Object.keys(body.masterKey as object).sort()).toEqual(['keyFilePath', 'source']);

    await app.close();
  });
});
