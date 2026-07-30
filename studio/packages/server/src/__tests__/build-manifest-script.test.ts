import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_VERSION } from '../build-info.js';

/**
 * `studio/package.json`'s `build:manifest` script hardcodes the dev-placeholder
 * version as a literal — an npm script can't `import` the `DEV_VERSION` constant
 * from `build-info.ts`. That leaves two independent copies of the same string.
 * If they drift, every `pnpm dev` build writes a manifest whose version no
 * longer matches `DEV_VERSION`, so `checkForUpdate`'s dev short-circuit
 * (`current.version === DEV_VERSION`) stops firing, a real network call fires
 * on every page load, and the update banner shows permanently in dev. This
 * pins the two together so changing one without the other fails here instead
 * of silently at runtime.
 */
describe('build:manifest script', () => {
  it('embeds the current DEV_VERSION, not a stale duplicate', () => {
    const pkgPath = join(import.meta.dirname, '..', '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:manifest']).toContain(DEV_VERSION);
  });
});
