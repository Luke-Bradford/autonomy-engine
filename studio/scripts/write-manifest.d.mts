/**
 * Hand-written type declaration for `write-manifest.mjs`, matched by TS's
 * node16/nodenext resolution via the shared `write-manifest` basename — this
 * keeps the script itself plain, dependency-free JS (it also runs directly as
 * `node scripts/write-manifest.mjs ...` from CI and the Dockerfile) while
 * still giving the server package's typecheck project a real signature to
 * check the test against, without pulling the .mjs source itself into that
 * project (which would trip `rootDir`: the script lives at the workspace
 * root, outside `packages/server`).
 */
export interface ManifestInput {
  dir: string;
  version: string;
  commit: string;
  arch: string;
}

export interface Manifest {
  version: string;
  commit: string;
  builtAt: string;
  arch: string;
}

export function writeManifest(input: ManifestInput): Manifest;
