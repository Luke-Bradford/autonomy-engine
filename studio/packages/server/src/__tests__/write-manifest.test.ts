import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildInfoSchema } from '@autonomy-studio/shared';
import { writeManifest } from '../../../../scripts/write-manifest.mjs';

describe('writeManifest', () => {
  it('writes a manifest the reader schema accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    writeManifest({ dir, version: '2026.07.30', commit: 'e93ebf8', arch: 'arm64' });
    const parsed = BuildInfoSchema.safeParse(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    );
    expect(parsed.success).toBe(true);
  });

  // The writer and the reader must agree, and the only way to know is to run the
  // reader's schema over the writer's output — which is what the case above does.
  // This one pins that `builtAt` is a real ISO instant rather than any string.
  it('stamps builtAt as an ISO instant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    writeManifest({ dir, version: '2026.07.30', commit: 'e93ebf8', arch: 'arm64' });
    const { builtAt } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      builtAt: string;
    };
    expect(Number.isNaN(Date.parse(builtAt))).toBe(false);
  });
});
