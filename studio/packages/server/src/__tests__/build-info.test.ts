import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBuildInfo, DEV_VERSION } from '../build-info.js';

const dir = () => mkdtempSync(join(tmpdir(), 'build-info-'));

describe('resolveBuildInfo', () => {
  it('reads a manifest written by the build', () => {
    const d = dir();
    writeFileSync(
      join(d, 'manifest.json'),
      JSON.stringify({
        version: '2026.07.30',
        commit: 'e93ebf8',
        builtAt: '2026-07-30T09:12:44.000Z',
        arch: 'arm64',
      }),
    );
    expect(resolveBuildInfo(join(d, 'manifest.json'))).toEqual({
      version: '2026.07.30',
      commit: 'e93ebf8',
      builtAt: '2026-07-30T09:12:44.000Z',
      arch: 'arm64',
    });
  });

  // A dev checkout has no manifest. This must NOT throw: the server has to boot
  // under `pnpm dev`, and a missing manifest is the normal case there.
  it('falls back to a dev placeholder when the manifest is absent', () => {
    const info = resolveBuildInfo(join(dir(), 'manifest.json'));
    expect(info.version).toBe(DEV_VERSION);
    expect(info.commit).toBe('dev');
  });

  // Corrupt manifest must degrade the same way, never crash the boot path. A
  // half-written file during an update is a realistic way to reach this.
  it('falls back when the manifest is unparseable', () => {
    const d = dir();
    writeFileSync(join(d, 'manifest.json'), '{ not json');
    expect(resolveBuildInfo(join(d, 'manifest.json')).version).toBe(DEV_VERSION);
  });

  // Present but WRONG SHAPE is distinct from absent, and must also degrade
  // rather than serve a half-parsed object to the update comparison.
  it('falls back when the manifest is valid JSON of the wrong shape', () => {
    const d = dir();
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ version: 42 }));
    expect(resolveBuildInfo(join(d, 'manifest.json')).version).toBe(DEV_VERSION);
  });
});
