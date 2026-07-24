# autonomy-studio — Bun single-binary spike (feasibility note)

_P7 packaging (#409), last item. 2026-07-24. **Evaluate-only** — this note is the
deliverable; no production code was changed to chase it. Docker
(`2026-07-12-target-architecture.md`, Dist row) remains the primary, recommended
ship. Bun was **not** installed and no `bun build --compile` was actually run in
this environment (see "Honesty caveat" at the end): every Bun claim below is
sourced from the official Bun docs (linked) and cross-checked against the studio
codebase as it stands at `main`; items that would need a real compile to confirm
are flagged **[unproven]**._

## Question

Could Autonomy Studio ship as a single self-contained executable via Bun's
`bun build --compile`, instead of (or alongside) the Docker image, so a user can
download one file and run it with no Node, no `pnpm install`, no container?

## Verdict (short)

**Feasible, but not free, and not for v1.** A working single binary needs **four
reshapes** of code that today reads from disk at runtime, plus it **collides with
a settled architecture decision** — "Node runtime for dev AND ship (**no Node/Bun
split**)" (`2026-07-12-target-architecture.md`, line 35). `bun build --compile`
ships the **Bun runtime itself** inside the binary, so *any* single-binary path
means the shipped app runs on Bun while dev/test/CI run on Node — that is the
split the architecture deliberately rejected.

Recommendation: **keep Docker as the primary ship, defer the single binary.** This
matches and now *concretises* the arch doc's existing "Bun single-binary spike
later" stance. This note does **not** re-open or resolve the "no Node/Bun split"
decision either way — it enumerates the cost so whoever eventually picks up a
scoped single-binary project (or the operator, if they want to revisit the
principle) starts from facts rather than a blank page.

## What `bun build --compile` gives you

From the Bun docs ([single-file executable](https://bun.sh/docs/bundler/executables)):

- Bundles all imported JS/TS + npm packages **and a copy of the Bun runtime** into
  one executable. "All built-in Bun and Node.js APIs are supported" (with caveats —
  see the compat notes below). Cross-compile to other OS/arch via `--target`
  (`bun-linux-x64`, `bun-darwin-arm64`, etc.).
- **Can embed `.node` N-API addons** into the binary — with a load-bearing caveat:
  _"the `.node` file must be required directly or it won't bundle correctly"_
  (called out specifically for `@mapbox/node-pre-gyp` and similar prebuild tools).
- **Can embed arbitrary files/dirs**, but only when they are reachable **statically**
  at build time: `import x from './f' with { type: 'file' }` (returns a virtual
  `/$bunfs/root/...` path, readable via `Bun.file()` or `node:fs`), or a build-time
  directory glob (`bun build --compile ./index.ts ./public/**/*.png`). A **runtime**
  `readdirSync()` of a loose directory is **not** auto-embedded.
- Ships its own SQLite: `bun:sqlite` (and `node:sqlite`) work under `--compile`
  with no native addon. Drizzle has a matching `drizzle-orm/bun-sqlite` driver.

Node compat is high but not total ([nodejs-apis](https://bun.sh/docs/runtime/nodejs-apis)):
`node:fs` ~92% of Node's suite, `node:http` fully implemented (one caveat: the
outgoing *client* request body is buffered, not streamed), `WebAssembly` full (so
`libsodium-wrappers` is fine), `node:crypto` mostly. Fastify is not on the
explicitly-tested list (Express is) — see reshape #4 / open risks.

## The four reshapes

Everything below is currently written for a Node process with a real filesystem
layout next to `dist/`. Under a compiled binary the working directory is the
user's cwd and the app's own files live in Bun's virtual `/$bunfs/` root, so each
of these has to change.

### 1. `better-sqlite3` native addon → almost certainly a driver swap

`packages/server/src/db/client.ts` statically imports `better-sqlite3@12.11.1` via
`drizzle-orm/better-sqlite3`. The addon is located at runtime by the `bindings` /
`prebuild-install` machinery (a filesystem search for the prebuilt `.node`), **not**
a direct `require('./better_sqlite3.node')`. Bun's embed rule is that the `.node`
must be `require`d directly to bundle — so better-sqlite3 **likely will not
auto-bundle** into the executable **[unproven]**; you'd be back to shipping a loose
`.node` beside the binary, which defeats "single file".

The clean path is to stop using a native addon at all: swap to Bun's built-in
`bun:sqlite` via `drizzle-orm/bun-sqlite`. That removes the addon problem entirely
**but** it is _not_ a one-line driver-string change — the hand-rolled migration
runner (`db/migrate.ts`) executes raw `.sql` against a `better-sqlite3` `Database`
handle whose API (`.pragma()`, `.exec()`, prepared-statement surface) differs from
the `bun:sqlite` handle, so `client.ts` + `migrate.ts` both need touching. It is
also a **sharper, second fork**: dev/test/CI would stay on Node + better-sqlite3
while only the shipped binary uses Bun + `bun:sqlite`, so the two runtimes would
run *different SQLite drivers* — a divergence beyond just "the runtime differs".

### 2. Migrations read from disk at runtime

`db/migrate.ts` resolves `MIGRATIONS_DIR` via
`join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', 'migrations')`
then `readdirSync` + `readFileSync` over 34 loose `0001_*.sql … 0034_*.sql` files.
Under `--compile`, `import.meta.url` points into `/$bunfs/` and the loose SQL dir
is not there. Reshape: embed each SQL file via a static `with { type: 'file' }`
import (or a build-time glob) and drive the runner from the embedded list instead
of a `readdirSync`. Mechanical, but it changes how the runner enumerates its work.

### 3. Web SPA served from a disk path

Since PR #699 the server serves the built SPA with `@fastify/static` rooted at the
`WEB_ROOT` env-var directory and reads `index.html` from disk once at boot
(`routes/static-web.ts`). A compiled binary has no `web/` dir on disk. Reshape:
embed the `packages/web/dist` output (glob) and serve it from the embedded blobs
(`Bun.embeddedFiles` / `Bun.serve` static routes, or read via `Bun.file()` on the
`/$bunfs` paths). The alternative — keep shipping `web/` next to the binary — again
is no longer a single file.

### 4. The `main`-module entry guard

`packages/server/src/index.ts:785` boots the server only when
`process.argv[1] === new URL(import.meta.url).pathname`. In a compiled binary the
entrypoint resolves to a `/$bunfs/root/...` virtual path, so `argv[1]` (the real
executable path) and the bunfs pathname will not match and the server would **not**
recognise itself as `main` and boot **[unproven]**. Reshape: gate on the portable
`import.meta.main` (or Bun's `Bun.isStandaloneExecutable`) instead of the
`argv[1]`-vs-pathname comparison.

## What is _not_ a problem

To keep the picture complete — two things a reader might expect on this list and
that `--compile` does **not** disturb, because they are external / user data, not
app-internal files:

- **The SQLite DB file + WAL** (`DB_PATH`, default `/app/data/app.sqlite`) is a
  user-supplied path opened at runtime — unchanged by compilation (whichever driver
  opens it).
- **Agent-CLI subprocess spawning via `execa`** launches external binaries by PATH;
  a compiled binary spawns child processes the same way (subject only to the same
  general `node:child_process` caveats Bun documents). The arch doc already steers
  clear of the one native landmine here ("avoid `node-pty`, fights single-binary").

## Other real costs (beyond the reshapes)

- **Cross-compilation of a native addon.** If you keep better-sqlite3 rather than
  swapping to `bun:sqlite`, `--target`-ing another OS/arch needs that platform's
  prebuilt `.node` — cross-compiling native addons is exactly the pain `bun:sqlite`
  removes. This is another reason the driver swap, not addon-embedding, is the real
  single-binary route.
- **Binary size.** The Bun runtime is embedded in every binary; the docs themselves
  note "Bun's binary is still way too big". Expect a large artifact per target.
- **macOS Gatekeeper / code-signing.** A downloaded, unsigned binary is quarantined;
  distributing to Mac users means `codesign` (+ ideally notarization) and a JIT
  entitlements plist, per the Bun docs. That is real release-engineering, not a flag.
- **Fastify + `@fastify/static` + `@fastify/websocket` under Bun `--compile`.**
  Not on Bun's explicitly-tested compat list. This is the single biggest **[unproven]**
  and should be the first thing an actual spike verifies.

## If someone picks this up — minimal smoke-test recipe

Evaluate-only stops here; this is the runway for a real spike, in cost order:

1. `bun --version` on a machine with Bun installed (not this CI env).
2. **Prove the runtime first, cheaply:** `bun run packages/server/src/index.ts`
   against a throwaway DB — does Fastify + websocket + static boot on Bun at all,
   before any `--compile`? If not, stop: single-binary is moot.
3. Swap the driver on a branch: `drizzle-orm/bun-sqlite` + `bun:sqlite`, adapt
   `migrate.ts`'s handle usage, run the server test suite on Bun.
4. Embed migrations (static `with { type: 'file' }`) and the web `dist` (glob);
   switch the entry guard to `Bun.isStandaloneExecutable`.
5. `bun build --compile --minify packages/server/src/index.ts --outfile studio` and
   run the compiled binary end-to-end (create connection → pipeline → trigger →
   fire → watch), then cross-compile one non-host `--target` and re-run.
6. Only then weigh size + code-signing against Docker for actual distribution.

Steps 2–4 each answer one `[unproven]` above; a hard failure at any of them is a
finding for the operator, **not** a reason to force it.

## Honesty caveat

Bun is not installed in this headless build environment and installing it to run a
throwaway compile would exceed the evaluate-only scope, so **no `bun build --compile`
was executed.** Every capability claim about Bun is from the official docs linked
above (fetched 2026-07-24); every studio-side fact is from the code at `main`.
Three conclusions are explicitly marked **[unproven]** because they depend on
runtime behaviour a real compile would settle: (a) whether better-sqlite3's
`bindings` lookup defeats addon embedding, (b) whether the `import.meta.url` entry
guard misfires under `/$bunfs/`, (c) whether Fastify + its plugins run correctly on
Bun under `--compile`. Treat this note as a scoping document, not a proof.
