# Contributing to Autonomy Studio

Thanks for your interest in improving Autonomy Studio. This guide covers the
development setup, the local checks that gate every change, and the pull-request
conventions the project follows.

> Scope: this guide is for the `studio/` re-platform only. The bash/python
> autonomy **engine** at the repository root is a separate, older prototype with
> its own conventions — the two share no code, dependencies, or tooling.

## Development setup

You need:

- **Node.js >= 22** (enforced by `engines` in `package.json`).
- **pnpm 11** — enable it with Corepack, which ships with Node:

  ```bash
  corepack enable
  ```

All commands below are run from this `studio/` directory (not the repository
root — pnpm's workspace is rooted here):

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the Fastify API on `:8080` and the Vite web dev server on
`:5173` (which proxies `/api` and `/health`, WebSocket upgrades included, to the
API). Open <http://localhost:5173>.

See [README.md](README.md) for self-hosting with Docker and the full
environment-variable reference.

## Workspace layout

This is a pnpm workspace of four packages:

```text
packages/
  shared/   Zod schemas + the pure run reducer, shared front-end and back-end
  server/   Fastify API, Drizzle + SQLite store, engine, scheduler
  web/       React + React Flow authoring UI (Vite)
  cli/       command-line tooling (e.g. the license audit)
docs/       target architecture, foundation specs, backlog
```

`shared` is the source of truth for schemas and run semantics; both `server` and
`web` depend on it. After editing `shared` source, rebuild it so dependents pick
up the change:

```bash
pnpm --filter @autonomy-studio/shared build
```

(The top-level `pnpm dev`, `pnpm test`, and `pnpm typecheck` scripts already
rebuild `shared` first.)

## The run model, in one paragraph

A pipeline is authored as a graph of activities. **Saving mints an immutable
version** — a stored version never changes (the database enforces this), so a
run can bind to one and stay reproducible. Running a pipeline does not mutate any
shared state directly: the engine appends **events** to a per-run append-only log
(`run_events`), and run state is derived by folding that log through a single
**pure reducer** in `shared`. The event log is the source of truth; the reducer
is deterministic and side-effect-free, so a run is fully reconstructable and
auditable from its events. When you touch run behaviour, change the reducer and
its events — never write derived state as an out-of-band mutation. The deeper
model is in [`docs/2026-07-12-target-architecture.md`](docs/2026-07-12-target-architecture.md);
open work is tracked in [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Checks — run these before opening a PR

The `studio-ci` workflow runs the following on every push and pull request that
touches `studio/**`. Run them locally first; they must all be green:

| Command                   | What it checks                                                 |
| ------------------------- | -------------------------------------------------------------- |
| `pnpm run audit:licenses` | Fail-closed audit that every dependency license is permissive. |
| `pnpm typecheck`          | Type-checks every package under TypeScript strict mode.        |
| `pnpm test`               | Runs the vitest suites across all packages.                    |
| `pnpm lint`               | ESLint (flat config) **and** `prettier --check .`.             |
| `pnpm build`              | Production build of `shared`, `server`, and `web`.             |

If lint fails on formatting, apply Prettier and re-check:

```bash
pnpm format
pnpm lint
```

Note that documentation under `studio/` **is** Prettier-checked (only the
engine's root `docs/` is Prettier-ignored), so run `pnpm format` after editing
Markdown here too.

### Tests

Follow test-driven development where it fits: write the failing test first, watch
it fail, then implement until it passes. Tests are real — they exercise the
actual reducer, schemas, and routes rather than asserting on mocks. Add coverage
for the behaviour you change, including its failure and edge cases.

## Pull requests

1. **Branch off `main`.** Never commit to `main` directly. Use a short,
   descriptive branch name.
2. **Keep the change scoped to `studio/`.** A studio change should not also edit
   the engine root (`bin/`, `lib/`, `tests/`, `start`).
3. **Use Conventional-Commit-style messages** scoped to studio, matching the
   history — e.g. `feat(studio): ...` or `fix(studio): ...`.
4. **Write a self-contained PR description**: what changed and why, the security
   model where relevant (auth, secrets, input validation, fail-open vs
   fail-closed), and any conscious tradeoffs. A reviewer should not need
   out-of-band context.
5. **Do not put `Closes #N` / `Fixes #N` for issues that must stay open.** Link
   related issues as plain `#N` in the body.

### CI and automated review

Two checks gate a merge:

- **`studio`** — the `studio-ci` workflow above (a studio change runs this).
- **`review`** — an automated code-review bot posts a verdict on the diff. Read
  its findings and resolve each one (fix it, or reply with a reasoned rebuttal).
  A pure-documentation PR skips the substantive review, but the check still runs.

Every push resets the review, so re-run the local checks before pushing a
follow-up.

## Reporting bugs and proposing changes

Open a GitHub issue describing the behaviour you saw versus what you expected,
with steps to reproduce. For larger changes, it's worth opening an issue to
discuss the approach before investing in the implementation.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
