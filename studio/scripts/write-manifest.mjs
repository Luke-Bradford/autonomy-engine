import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write the build's identity next to the server build.
 *
 * Callers pass version/commit/arch rather than this script shelling out to git:
 * the release workflow knows them from the tag and the checkout, and a build that
 * reads git would produce a DIFFERENT manifest in a packaged install (which has
 * no git) than in CI — the one place the two must not diverge.
 */
export function writeManifest({ dir, version, commit, arch }) {
  const manifest = { version, commit, builtAt: new Date().toISOString(), arch };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, version, commit, arch] = process.argv.slice(2);
  if (!dir || !version || !commit || !arch) {
    console.error('usage: write-manifest.mjs <dir> <version> <commit> <arch>');
    process.exit(1);
  }
  writeManifest({ dir, version, commit, arch });
}
