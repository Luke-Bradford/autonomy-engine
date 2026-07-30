# Packaging Phase 1 — release identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio knows and displays which version it is running, and tells you when a newer release
exists.

**Architecture:** The build writes a `manifest.json` next to the server's `dist/`. The server reads it
once at startup (falling back to a dev placeholder when absent) and serves it at `GET /api/version`.
A CI job publishes that same manifest to a GitHub Release on tag. `GET /api/update/available` has the
**server** fetch the published manifest and compare — server-side so there is no CORS problem and so
a token can be added later without touching the browser. The web shell renders the running version,
and a banner when a newer one exists.

**Tech Stack:** Fastify + Zod (server), React + Vite (web), `@autonomy-studio/shared` for schemas,
vitest for unit tests, Playwright for e2e, GitHub Actions for the release job.

## Global Constraints

- **TypeScript strict + ESM** throughout `studio/`. Imports of local modules use the `.js` extension.
- **Zod schemas live in `@autonomy-studio/shared`** and are the single source of truth shared by the
  server route and the web client. Never hand-roll a matching interface on one side.
- **`/health` stays a bare liveness probe** — it must keep returning exactly `{"ok":true}`. Version is
  a separate concern with a separate consumer.
- **The version is baked at build time, never read from git at runtime** — a packaged install has no
  git and no `.git` directory.
- **No new runtime dependency.** Use `node:fs`, `node:os` and the global `fetch`.
- Lint/format: `pnpm -C studio lint` (eslint flat + prettier). Typecheck: `pnpm -C studio typecheck`.
- Tests: `pnpm -C studio test`. E2E: `pnpm -C studio test:e2e` (**builds first — never run bare
  `playwright test`**, it tests a stale `dist`).
- Follow the repo's PR workflow, but branch **`attended/studio-792-phase-1`** — NOT `feat/studio-*`
  or `fix/studio-*`. The headless build loop is running concurrently and its triage adopts any
  open branch matching those two prefixes, so a conventionally-named branch here would be picked
  up and finished by the loop mid-task. Never commit to `main`.

---

### Task 1: Version identity — shared schema and `GET /api/version`

**Files:**

- Create: `studio/packages/shared/src/schemas/build-info.ts`
- Modify: `studio/packages/shared/src/schemas/index.ts` (add the export)
- Create: `studio/packages/server/src/build-info.ts`
- Create: `studio/packages/server/src/__tests__/build-info.test.ts`
- Create: `studio/packages/server/src/routes/version.ts`
- Create: `studio/packages/server/src/routes/__tests__/version.test.ts`
- Modify: `studio/packages/server/src/index.ts` (register the route beside the others, ~line 45)

**Interfaces:**

- Produces: `BuildInfoSchema` / `type BuildInfo` from `@autonomy-studio/shared`;
  `resolveBuildInfo(manifestPath: string): BuildInfo` from `server/src/build-info.js`;
  `versionRoutes` (a Fastify plugin) from `server/src/routes/version.js`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test for the shared schema and the resolver**

Create `studio/packages/server/src/__tests__/build-info.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- build-info`
Expected: FAIL — `Cannot find module '../build-info.js'`.

- [ ] **Step 3: Add the shared schema**

Create `studio/packages/shared/src/schemas/build-info.ts`:

```ts
import { z } from 'zod';

/**
 * The identity of a BUILT artifact, written by the release build and read back
 * at runtime. Shared because two consumers must agree on it: the server route
 * that serves it and the web client that renders it — and, from phase 2, the
 * update check that compares a local one against a published one.
 *
 * `commit` is a short sha and `arch` matches `process.arch` (`arm64`/`x64`);
 * `better-sqlite3` is a native addon, so artifacts are architecture-specific and
 * the arch has to travel with the identity rather than be inferred later.
 */
export const BuildInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1),
  builtAt: z.string().datetime(),
  arch: z.string().min(1),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;
```

Add to `studio/packages/shared/src/schemas/index.ts`, following the existing export style:

```ts
export * from './build-info.js';
```

- [ ] **Step 4: Implement the resolver**

Create `studio/packages/server/src/build-info.ts`:

```ts
import { readFileSync } from 'node:fs';
import { arch } from 'node:process';
import { BuildInfoSchema, type BuildInfo } from '@autonomy-studio/shared';

/** What a checkout without a release manifest reports. */
export const DEV_VERSION = '0.0.0-dev';

/**
 * Read the build's identity, or a dev placeholder.
 *
 * TOTAL by construction: absent, unreadable, unparseable and wrong-shape all
 * return the placeholder rather than throwing. This runs on the boot path, and a
 * server that refuses to start because a metadata file is malformed would turn a
 * cosmetic problem into an outage — including, in phase 2, one where the file is
 * half-written because an update is mid-flight.
 */
export function resolveBuildInfo(manifestPath: string): BuildInfo {
  const fallback: BuildInfo = {
    version: DEV_VERSION,
    commit: 'dev',
    builtAt: new Date(0).toISOString(),
    arch,
  };
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = BuildInfoSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- build-info`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing route test**

Create `studio/packages/server/src/routes/__tests__/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../__tests__/build-test-app.js';

describe('GET /api/version', () => {
  it('serves the running build identity', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.version).toBe('string');
    expect(typeof body.commit).toBe('string');
    expect(typeof body.arch).toBe('string');
    await app.close();
  });

  // The version endpoint must NOT change /health. It is a separate concern with
  // a separate consumer, and a liveness probe that grows fields is one that
  // eventually breaks something that polls it.
  it('leaves /health as a bare liveness probe', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- routes/__tests__/version`
Expected: FAIL — 404 on `/api/version`.

- [ ] **Step 8: Implement the route**

Create `studio/packages/server/src/routes/version.ts`:

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { resolveBuildInfo } from '../build-info.js';

/**
 * `manifest.json` sits NEXT TO the server build, i.e. `app/manifest.json` with
 * the code in `app/dist/`.
 *
 * TWO levels up, not one: this file compiles to `dist/routes/version.js` (tsc
 * preserves the `routes/` subdirectory), so one `..` would land inside `dist/`.
 * Two reaches the package root in dev — where the build writes it — and the app
 * root in a packaged install, where the Dockerfile's `WORKDIR /app` puts the
 * code in `/app/dist`. Resolved from this module's own URL rather than
 * `process.cwd()`, because the launchd service's working directory is not
 * guaranteed to be the install root.
 */
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'manifest.json');

/** Read ONCE at registration: the artifact cannot change under a running process. */
export function versionRoutes(fastify: FastifyInstance): void {
  const info = resolveBuildInfo(MANIFEST_PATH);
  fastify.get('/api/version', () => info);
}
```

Register it in `studio/packages/server/src/index.ts` beside the other route imports and
registrations, following the existing pattern:

```ts
import { versionRoutes } from './routes/version.js';
// ...alongside the other `await app.register(...)` calls:
await app.register(versionRoutes);
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- version`
Expected: PASS.

- [ ] **Step 10: Full gate, then commit**

Run: `pnpm -C studio lint && pnpm -C studio typecheck && pnpm -C studio test`
Expected: all green.

```bash
git add studio/packages/shared/src/schemas/build-info.ts \
        studio/packages/shared/src/schemas/index.ts \
        studio/packages/server/src/build-info.ts \
        studio/packages/server/src/routes/version.ts \
        studio/packages/server/src/__tests__/build-info.test.ts \
        studio/packages/server/src/routes/__tests__/version.test.ts \
        studio/packages/server/src/index.ts
git commit -m "feat(studio): #792 phase 1 — GET /api/version reads a build manifest"
```

---

### Task 2: Show the running version in the shell

**Files:**

- Create: `studio/packages/web/src/api/version.ts`
- Create: `studio/packages/web/src/api/version.test.ts`
- Create: `studio/packages/web/src/shell/VersionBadge.tsx`
- Create: `studio/packages/web/src/shell/VersionBadge.test.tsx`
- Modify: `studio/packages/web/src/shell/AppShell.tsx` (render it in the hub rail foot)
- Modify: `studio/packages/web/src/index.css` (one rule)

**Interfaces:**

- Consumes: `BuildInfoSchema` / `BuildInfo` from `@autonomy-studio/shared` (Task 1);
  `GET /api/version` (Task 1); `apiFetch` from `../api/client`.
- Produces: `getVersion(signal?: AbortSignal): Promise<BuildInfo>` from `api/version.ts`;
  `<VersionBadge />` from `shell/VersionBadge.tsx`.

- [ ] **Step 1: Write the failing api-client test**

Create `studio/packages/web/src/api/version.test.ts`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from './version';

afterEach(() => vi.restoreAllMocks());

describe('getVersion', () => {
  it('parses the build identity through the shared schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '2026.07.30',
          commit: 'e93ebf8',
          builtAt: '2026-07-30T09:12:44.000Z',
          arch: 'arm64',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(getVersion()).resolves.toMatchObject({ version: '2026.07.30', arch: 'arm64' });
  });

  // A response that does not match the shared schema must REJECT rather than
  // flow a half-typed object into the UI — the schema is a contract check.
  it('rejects a response of the wrong shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getVersion()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/web test -- api/version`
Expected: FAIL — cannot resolve `./version`.

- [ ] **Step 3: Implement the client**

Create `studio/packages/web/src/api/version.ts`:

```ts
import { BuildInfoSchema, type BuildInfo } from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The running build's identity. Parsed through the SAME shared schema the server
 * validates against, exactly as the other clients in this directory do — a
 * contract check between the two halves, not a formality.
 */
export function getVersion(signal?: AbortSignal): Promise<BuildInfo> {
  return apiFetch('/api/version', { schema: BuildInfoSchema, signal });
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm -C studio --filter @autonomy-studio/web test -- api/version`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Create `studio/packages/web/src/shell/VersionBadge.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionBadge } from './VersionBadge';
import * as api from '../api/version';

afterEach(() => vi.restoreAllMocks());

describe('VersionBadge', () => {
  it('shows the running version once loaded', async () => {
    vi.spyOn(api, 'getVersion').mockResolvedValue({
      version: '2026.07.30',
      commit: 'e93ebf8',
      builtAt: '2026-07-30T09:12:44.000Z',
      arch: 'arm64',
    });
    render(<VersionBadge />);
    await waitFor(() => expect(screen.getByText('2026.07.30')).toBeInTheDocument());
  });

  // A failed version fetch must not put an error in the chrome of every page.
  // It is decoration; the app is fully usable without it.
  it('renders nothing when the version cannot be read', async () => {
    vi.spyOn(api, 'getVersion').mockRejectedValue(new Error('offline'));
    const { container } = render(<VersionBadge />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/web test -- VersionBadge`
Expected: FAIL — cannot resolve `./VersionBadge`.

- [ ] **Step 7: Implement the component**

Create `studio/packages/web/src/shell/VersionBadge.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getVersion } from '../api/version';

/**
 * The running build, in the rail foot beside the theme switch.
 *
 * Renders NOTHING on failure. This sits in the chrome of every page, so an error
 * state here would follow the user everywhere for something that is purely
 * informational — the app works identically without it.
 */
export function VersionBadge(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getVersion(controller.signal)
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(null));
    return () => controller.abort();
  }, []);

  if (version === null) return null;
  return (
    <span className="version-badge" title={`studio ${version}`}>
      {version}
    </span>
  );
}
```

Render it in `AppShell.tsx` inside the hub rail, after the theme switch. Add to `index.css`:

```css
.version-badge {
  font-size: 0.6rem;
  color: var(--muted);
  padding-bottom: 0.35rem;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `pnpm -C studio --filter @autonomy-studio/web test -- VersionBadge`
Expected: PASS.

- [ ] **Step 9: Full gate, then commit**

Run: `pnpm -C studio lint && pnpm -C studio typecheck && pnpm -C studio test`

```bash
git add studio/packages/web/src/api/version.ts studio/packages/web/src/api/version.test.ts \
        studio/packages/web/src/shell/VersionBadge.tsx studio/packages/web/src/shell/VersionBadge.test.tsx \
        studio/packages/web/src/shell/AppShell.tsx studio/packages/web/src/index.css
git commit -m "feat(studio): #792 phase 1 — show the running version in the shell"
```

---

### Task 3: Write `manifest.json` at build, and publish it on tag

**Files:**

- Create: `studio/scripts/write-manifest.mjs`
- Create: `studio/packages/server/src/__tests__/write-manifest.test.ts`
  (inside the SERVER package — vitest discovers tests per package root, so a test under
  `studio/scripts/` would never be collected; it imports the script by relative path)
- Modify: `studio/package.json` (a `build:manifest` script, called by `build`)
- Create: `.github/workflows/studio-release.yml`
- Modify: `studio/.gitignore` (ignore the generated `packages/server/manifest.json`)
- Modify: `studio/Dockerfile` (copy the manifest into the image — see Step 5b)

**Interfaces:**

- Consumes: `BuildInfoSchema` from `@autonomy-studio/shared` (Task 1) — the writer validates its own
  output against the same schema the reader parses.
- Produces: `studio/packages/server/manifest.json` at build; a GitHub Release asset `manifest.json`
  on tag.

- [ ] **Step 1: Write the failing test**

Create `studio/packages/server/src/__tests__/write-manifest.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- write-manifest`
Expected: FAIL — cannot resolve `../../../../scripts/write-manifest.mjs`.

- [ ] **Step 3: Implement the writer**

Create `studio/scripts/write-manifest.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- write-manifest`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the release workflow**

Create `.github/workflows/studio-release.yml`:

```yaml
name: studio-release

on:
  push:
    tags: ['studio-v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.0.6 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm, cache-dependency-path: studio/pnpm-lock.yaml }

      - name: Install
        working-directory: studio
        run: pnpm install --frozen-lockfile

      - name: Build
        working-directory: studio
        run: pnpm build

      # VERSION comes from the tag and COMMIT from the checkout, so the published
      # manifest and the one baked into the artifact are produced from the same
      # two facts rather than derived independently.
      - name: Write manifest
        working-directory: studio
        env:
          TAG: ${{ github.ref_name }}
        run: |
          VERSION="${TAG#studio-v}"
          node scripts/write-manifest.mjs packages/server "$VERSION" "$(git rev-parse --short HEAD)" x64
          cat packages/server/manifest.json

      - name: Publish the manifest to the release
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name }}
        run: gh release create "$TAG" --generate-notes studio/packages/server/manifest.json
```

Wire the manifest into local builds — in `studio/package.json`, have `build` call it after the
existing steps so a dev build also carries an identity:

```json
"build:manifest": "node scripts/write-manifest.mjs packages/server 0.0.0-dev $(git rev-parse --short HEAD 2>/dev/null || echo dev) $(node -p process.arch)"
```

Add to `studio/.gitignore`:

```gitignore
packages/server/manifest.json
```

- [ ] **Step 5b: Copy the manifest into the container image**

Raised by the Task 1 review as "cannot verify from diff", and confirmed: the Dockerfile has no step
that places `manifest.json` in the image, so a released CONTAINER would serve the dev placeholder —
wrong in the ship path the architecture doc calls primary.

`version.ts` resolves the manifest two levels up from `dist/routes/`, which is `/app/manifest.json`
given the image's `WORKDIR /app`. Add a copy beside the existing ones in the runtime stage of
`studio/Dockerfile`:

```dockerfile
COPY --from=build /app/packages/server/manifest.json ./manifest.json
```

The build stage must therefore write it before that copy — add the manifest step to the build stage
right after the existing `pnpm --filter ... build` line:

```dockerfile
RUN node scripts/write-manifest.mjs packages/server \
      "${STUDIO_VERSION:-0.0.0-dev}" "${STUDIO_COMMIT:-dev}" "$(node -p process.arch)"
```

Verify by building and asking the running container what it is:

```bash
cd studio && docker build -t studio-manifest-check . && \
  docker run --rm -d --name mcheck -p 8898:8080 \
    -e AUTONOMY_MASTER_KEY="$(python3 -c 'import os,base64;print(base64.b64encode(os.urandom(32)).decode())')" \
    studio-manifest-check && sleep 12 && \
  curl -s http://127.0.0.1:8898/api/version; docker rm -f mcheck
```

Expected: a JSON body whose `version` is NOT `0.0.0-dev` when the build args are set, proving the
manifest reached the image rather than the endpoint falling back.

- [ ] **Step 6: Verify the workflow parses and the manifest round-trips**

Run:

```bash
cd studio && node scripts/write-manifest.mjs packages/server 2026.07.30 testsha arm64 && \
  cat packages/server/manifest.json && \
  pnpm --filter @autonomy-studio/server test -- build-info
```

Expected: the file is written, and `resolveBuildInfo` reads it back — the writer and reader agreeing
on real output rather than on two schemas that merely look alike.

- [ ] **Step 7: Full gate, then commit**

Run: `pnpm -C studio lint && pnpm -C studio typecheck && pnpm -C studio test`

```bash
git add studio/scripts/write-manifest.mjs studio/packages/server/src/__tests__/write-manifest.test.ts \
        studio/package.json studio/.gitignore .github/workflows/studio-release.yml
git commit -m "feat(studio): #792 phase 1 — write a build manifest and publish it on tag"
```

---

### Task 4: `GET /api/update/available` and the banner

**Files:**

- Create: `studio/packages/shared/src/schemas/update-status.ts`
- Modify: `studio/packages/shared/src/schemas/index.ts`
- Create: `studio/packages/server/src/update/check.ts`
- Create: `studio/packages/server/src/update/__tests__/check.test.ts`
- Modify: `studio/packages/server/src/routes/version.ts` (add the second route)
- Modify: `studio/packages/server/src/routes/__tests__/version.test.ts`
- Create: `studio/packages/web/src/shell/UpdateBanner.tsx`
- Create: `studio/packages/web/src/shell/UpdateBanner.test.tsx`
- Modify: `studio/packages/web/src/api/version.ts` (add `getUpdateStatus`)
- Modify: `studio/packages/web/src/shell/AppShell.tsx`, `studio/packages/web/src/index.css`

**Interfaces:**

- Consumes: `resolveBuildInfo`, `BuildInfo` (Task 1); `apiFetch` (Task 2).
- Produces: `UpdateStatusSchema` / `type UpdateStatus`
  (`{ current: BuildInfo; latest: BuildInfo | null; updateAvailable: boolean; notes: string | null }`);
  `checkForUpdate(current, fetchImpl?)`; `getUpdateStatus()` in the web client.

- [ ] **Step 1: Write the failing check test**

Create `studio/packages/server/src/update/__tests__/check.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate } from '../check.js';

const current = {
  version: '2026.07.29',
  commit: 'aaa',
  builtAt: '2026-07-29T00:00:00.000Z',
  arch: 'arm64',
};
const remote = (version: string) =>
  new Response(
    JSON.stringify({ version, commit: 'bbb', builtAt: '2026-07-30T00:00:00.000Z', arch: 'arm64' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('checkForUpdate', () => {
  it('reports an update when the published version differs', async () => {
    const res = await checkForUpdate(current, vi.fn().mockResolvedValue(remote('2026.07.30')));
    expect(res.updateAvailable).toBe(true);
    expect(res.latest?.version).toBe('2026.07.30');
  });

  it('reports none when the published version matches', async () => {
    const res = await checkForUpdate(current, vi.fn().mockResolvedValue(remote('2026.07.29')));
    expect(res.updateAvailable).toBe(false);
  });

  // Offline is NOT "up to date". Reporting no-update on a failed fetch would be
  // fail-open on the one signal this endpoint exists to give.
  it('reports latest=null, not updateAvailable=false, when the check fails', async () => {
    const res = await checkForUpdate(current, vi.fn().mockRejectedValue(new Error('offline')));
    expect(res.latest).toBeNull();
    expect(res.updateAvailable).toBe(false);
  });

  // A dev build must never claim an update is available: its placeholder version
  // differs from every published one, which would show the banner permanently.
  it('never reports an update for a dev build', async () => {
    const dev = { ...current, version: '0.0.0-dev', commit: 'dev' };
    const res = await checkForUpdate(dev, vi.fn().mockResolvedValue(remote('2026.07.30')));
    expect(res.updateAvailable).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- update/check`
Expected: FAIL — cannot resolve `../check.js`.

- [ ] **Step 3: Add the shared schema**

Create `studio/packages/shared/src/schemas/update-status.ts`:

```ts
import { z } from 'zod';
import { BuildInfoSchema } from './build-info.js';

/**
 * What the update check reports.
 *
 * `latest: null` means the check could NOT be made (offline, rate-limited, no
 * release yet) and is deliberately distinct from `updateAvailable: false`, which
 * is a positive statement that this build is current. Conflating them would make
 * "I could not tell" indistinguishable from "you are up to date" — the same
 * unreadable-is-not-zero rule the loop's spend guard follows.
 */
export const UpdateStatusSchema = z.object({
  current: BuildInfoSchema,
  latest: BuildInfoSchema.nullable(),
  updateAvailable: z.boolean(),
  notes: z.string().nullable(),
});

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
```

Export it from `schemas/index.ts` beside the others.

- [ ] **Step 4: Implement the check**

Create `studio/packages/server/src/update/check.ts`:

```ts
import { BuildInfoSchema, type BuildInfo, type UpdateStatus } from '@autonomy-studio/shared';
import { DEV_VERSION } from '../build-info.js';

/** Where the published manifest lives. Overridable for tests and forks. */
export const LATEST_MANIFEST_URL =
  process.env.STUDIO_LATEST_MANIFEST_URL ??
  'https://github.com/Luke-Bradford/autonomy-engine/releases/latest/download/manifest.json';

type FetchImpl = (url: string) => Promise<Response>;

/**
 * Compare the running build against the published one.
 *
 * Runs SERVER-SIDE, not in the browser: it avoids a cross-origin request from the
 * app, and it is where a token would go if the release ever becomes private —
 * neither of which would be true if the page fetched GitHub directly.
 */
export async function checkForUpdate(
  current: BuildInfo,
  fetchImpl: FetchImpl = (url) => fetch(url),
): Promise<UpdateStatus> {
  const unknown: UpdateStatus = { current, latest: null, updateAvailable: false, notes: null };
  // A dev build has no meaningful version to compare, and its placeholder differs
  // from every release — without this it would show the banner forever.
  if (current.version === DEV_VERSION) return unknown;

  let latest: BuildInfo;
  try {
    const res = await fetchImpl(LATEST_MANIFEST_URL);
    if (!res.ok) return unknown;
    const parsed = BuildInfoSchema.safeParse(await res.json());
    if (!parsed.success) return unknown;
    latest = parsed.data;
  } catch {
    return unknown;
  }

  return {
    current,
    latest,
    updateAvailable: latest.version !== current.version,
    notes: null,
  };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm -C studio --filter @autonomy-studio/server test -- update/check`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the route, with a test first**

Append to `studio/packages/server/src/routes/__tests__/version.test.ts`:

```ts
it('serves an update status that names the running build', async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/update/available' });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { current: { version: string }; updateAvailable: boolean };
  expect(typeof body.current.version).toBe('string');
  expect(typeof body.updateAvailable).toBe('boolean');
  await app.close();
});
```

Run it (expect FAIL, 404), then add to `routes/version.ts` — **both** the import and the route:

```ts
import { checkForUpdate } from '../update/check.js';

// inside versionRoutes, beside the existing GET /api/version:
fastify.get('/api/update/available', () => checkForUpdate(info));
```

Run again — expect PASS. (In tests this is a dev build, so it short-circuits without a network call.)

- [ ] **Step 7: Write the failing banner test**

Create `studio/packages/web/src/shell/UpdateBanner.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';
import * as api from '../api/version';

const build = (version: string) => ({
  version,
  commit: 'x',
  builtAt: '2026-07-30T00:00:00.000Z',
  arch: 'arm64',
});
afterEach(() => vi.restoreAllMocks());

describe('UpdateBanner', () => {
  it('announces an available update and names the version', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.29'),
      latest: build('2026.07.30'),
      updateAvailable: true,
      notes: null,
    });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2026.07.30'));
  });

  it('renders nothing when up to date', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.30'),
      latest: build('2026.07.30'),
      updateAvailable: false,
      notes: null,
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  // latest=null means the check could not be made. It must look like silence,
  // NOT like "up to date" — the server already distinguishes them and the UI
  // must not collapse the distinction it was given.
  it('renders nothing when the check could not be made', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.29'),
      latest: null,
      updateAvailable: false,
      notes: null,
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
```

- [ ] **Step 8: Run it and watch it fail, then implement**

Add to `studio/packages/web/src/api/version.ts`:

```ts
import { UpdateStatusSchema, type UpdateStatus } from '@autonomy-studio/shared';

export function getUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  return apiFetch('/api/update/available', { schema: UpdateStatusSchema, signal });
}
```

Create `studio/packages/web/src/shell/UpdateBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@autonomy-studio/shared';
import { getUpdateStatus } from '../api/version';

/**
 * Announces a newer release. Phase 1 only TELLS — applying it is phase 2, so this
 * links to the release rather than offering a button that does not exist yet.
 *
 * `role="status"` rather than `alert`: an available update is informational, and
 * `alert` interrupts a screen reader mid-task for something that can wait.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getUpdateStatus(controller.signal)
      .then(setStatus)
      .catch(() => setStatus(null));
    return () => controller.abort();
  }, []);

  if (!status?.updateAvailable || status.latest === null) return null;
  return (
    <div className="update-banner" role="status">
      Version <strong>{status.latest.version}</strong> is available (running {status.current.version}
      ).{' '}
      <a
        href="https://github.com/Luke-Bradford/autonomy-engine/releases/latest"
        target="_blank"
        rel="noreferrer"
      >
        Release notes
      </a>
    </div>
  );
}
```

Render it in `AppShell.tsx` above `<main className="content">`, and add to `index.css`:

```css
.update-banner {
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  padding: 0.4rem 2rem;
  font-size: 0.85rem;
}
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `pnpm -C studio --filter @autonomy-studio/web test -- UpdateBanner`
Expected: PASS, 3 tests.

- [ ] **Step 10: E2E — the version is visible in a real browser**

Create `studio/e2e/version-badge.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the shell shows a version', async ({ page }) => {
  await page.goto('/#/');
  // The e2e server is an unpackaged build, so it reports the dev placeholder —
  // which is exactly what proves the badge renders what the API returned rather
  // than a hardcoded string.
  await expect(page.locator('.version-badge')).toHaveText('0.0.0-dev');
});

test('no update banner on a dev build', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.update-banner')).toHaveCount(0);
});
```

Run: `pnpm -C studio test:e2e` (builds first — never bare `playwright test`).
Expected: PASS.

- [ ] **Step 11: Full gate, then commit**

Run: `pnpm -C studio lint && pnpm -C studio typecheck && pnpm -C studio test && pnpm -C studio test:e2e`

```bash
git add studio/packages/shared/src/schemas/update-status.ts studio/packages/shared/src/schemas/index.ts \
        studio/packages/server/src/update/ studio/packages/server/src/routes/version.ts \
        studio/packages/server/src/routes/__tests__/version.test.ts \
        studio/packages/web/src/api/version.ts studio/packages/web/src/shell/UpdateBanner.tsx \
        studio/packages/web/src/shell/UpdateBanner.test.tsx studio/packages/web/src/shell/AppShell.tsx \
        studio/packages/web/src/index.css studio/e2e/version-badge.spec.ts
git commit -m "feat(studio): #792 phase 1 — update-available check and banner"
```

---

## Done when

- `GET /api/version` returns the running build; `/health` is unchanged.
- The shell shows the version, and nothing when it cannot be read.
- `pnpm -C studio build` writes `packages/server/manifest.json`.
- Pushing a `studio-v*` tag publishes a manifest to a GitHub Release.
- `GET /api/update/available` compares the two, distinguishing "up to date" from "could not check".
- The banner appears only for a real build with a newer release.

## Deliberately NOT in this plan

Applying an update, rollback, update events, the per-arch tarball, the updater agent, the `.pkg`.
Those are phase 2 and 3 of `#792`. Phase 1 stops at **knowing and telling**.
