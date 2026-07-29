# Autonomy Studio

A config-driven, open-source harness for building and running AI-automation
pipelines — author a pipeline as a graph of activities, connect an LLM or CLI
agent, wire a trigger, fire it, and watch each run live. Runs are event-sourced
against an immutable pipeline version, so every run is reproducible and
auditable.

TypeScript end to end: a React + React Flow authoring UI, a Fastify API, and a
Drizzle + SQLite store, in a pnpm workspace. MIT-licensed, with a
permissive-only dependency tree enforced by `pnpm run audit:licenses`.

> This is the `studio/` re-platform. The bash/python autonomy **engine** at the
> repository root is a separate, older prototype with its own README — the two
> do not share code or configuration.

## Self-host with Docker (recommended)

The whole app — web UI and API — runs in a single container. From this
directory:

```bash
docker compose up --build
```

Then open <http://localhost:8080>.

The SQLite database and the secret-encryption master key both live under
`/app/data`, persisted in the named `studio-data` volume, so your pipelines and
stored connection secrets survive a restart or rebuild.

### Plain `docker run`

Equivalent without Compose:

```bash
docker build -t autonomy-studio .
docker run -p 8080:8080 -v studio-data:/app/data autonomy-studio
```

## Security posture — read before exposing it

The app **authenticates nothing yet**: every request runs as a single fixed
local principal. The container also binds `0.0.0.0` (via `HOST`) so Docker's
published port is reachable — a loopback bind inside the container network
namespace would not be.

Only expose it on a trusted network or behind your own authenticating reverse
proxy. To keep it strictly local, bind the published port to loopback on the
host — change the Compose port mapping to `127.0.0.1:8080:8080` (or use
`docker run -p 127.0.0.1:8080:8080 ...`).

## The master key — back it up

Every connection secret is encrypted at rest with a 32-byte master key. Under
Docker it is auto-generated on first boot and stored at
`/app/data/secrets/master.key` inside the persisted volume. **If that key is
lost, every stored secret becomes permanently undecryptable.**

For a production deployment, pin your own key instead of relying on the
generated one, and back it up:

- `AUTONOMY_MASTER_KEY` — the key itself, base64 or hex, supplied via the
  environment, or
- `AUTONOMY_MASTER_KEY_FILE` — an absolute path to a mounted key file (must be
  mode `0600`).

The Compose file has a commented-out `AUTONOMY_MASTER_KEY_FILE` example.

## Configuration

All configuration is via environment variables. The value shown is the default
you get in the Docker image; where the image explicitly overrides a
bare-process default (`HOST`, `DB_PATH`, `AUTONOMY_DATA_DIR`, `WEB_ROOT`), the
description notes the bare-process value.

| Variable                      | Default                | Description                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `8080`                 | HTTP port the server listens on.                                                                                                                                                                                                                                                                                                                                                       |
| `HOST`                        | `0.0.0.0`              | Bind address. Defaults to `127.0.0.1` for a bare process; the image binds all interfaces so the published port is reachable.                                                                                                                                                                                                                                                           |
| `DB_PATH`                     | `/app/data/app.sqlite` | SQLite database file. Bare-process default is `data/app.sqlite` (relative to the working directory).                                                                                                                                                                                                                                                                                   |
| `AUTONOMY_DATA_DIR`           | `/app/data`            | Base directory for derived state — the master key is stored at `<dir>/secrets/master.key` when no explicit key/key-file is set.                                                                                                                                                                                                                                                        |
| `WEB_ROOT`                    | `/app/web`             | Directory of the built web bundle to serve. Unset for a bare process (dev serves the web via Vite); the image serves the built SPA.                                                                                                                                                                                                                                                    |
| `AUTONOMY_MASTER_KEY`         | _(unset)_              | Pin the secret-encryption master key directly (base64 or hex). Takes precedence over the key file and generation.                                                                                                                                                                                                                                                                      |
| `AUTONOMY_MASTER_KEY_FILE`    | _(unset)_              | Absolute path to a mounted master-key file (`0600`). Used when `AUTONOMY_MASTER_KEY` is unset.                                                                                                                                                                                                                                                                                         |
| `GH_TOKEN` / `GITHUB_TOKEN`   | _(unset)_              | GitHub token used to auto-open pull requests for git-connected workspaces. Without one, PRs fall back to a guided-manual flow.                                                                                                                                                                                                                                                         |
| `WAKEUP_RETENTION_DAYS`       | `30`                   | Days to retain settled scheduled-wakeup rows before the housekeeping sweep prunes them. `0` disables the sweep.                                                                                                                                                                                                                                                                        |
| `WEBHOOK_RETENTION_DAYS`      | `30`                   | Days to retain delivered webhook rows before pruning. `0` disables the sweep.                                                                                                                                                                                                                                                                                                          |
| `RETENTION_BATCH_ROWS`        | `1000`                 | Rows deleted per bounded batch by the retention sweeps.                                                                                                                                                                                                                                                                                                                                |
| `RETENTION_SWEEP_MAX_BATCHES` | `50`                   | Max batches a recurring sweep tick prunes (the boot sweep always fully drains).                                                                                                                                                                                                                                                                                                        |
| `CLAUDE_QUOTA_ENABLED`        | `1` (enabled)          | Set to `0` to switch off the account-quota surface (`GET /api/quota`). Enabled, it reads the operator's Claude OAuth token from the macOS Keychain **on request only** and queries the provider's usage endpoint; disabled, it always reports `null` and never touches the credential store. macOS-only — on any other host (including the Docker image) the reading is always `null`. |

An invalid numeric value (e.g. a non-integer `PORT`, or a retention count below
`1`) fails fast at boot with a clear error rather than degrading silently.

## Local development

Requires Node.js **>= 22** and pnpm **11** (via `corepack enable`).

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the API on `:8080` and the Vite web dev server on `:5173`, which
proxies `/api` and `/health` (WebSocket upgrades included) to the API. Open
<http://localhost:5173>.

Other workspace scripts:

| Command                   | What it does                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `pnpm build`              | Build `shared`, `server`, and `web` for production.             |
| `pnpm test`               | Run the vitest suites across all packages.                      |
| `pnpm test:e2e`           | Playwright browser specs (needs `playwright install chromium`). |
| `pnpm typecheck`          | Type-check every package (strict).                              |
| `pnpm lint`               | ESLint (flat config) + Prettier check.                          |
| `pnpm format`             | Apply Prettier formatting.                                      |
| `pnpm run audit:licenses` | Fail-closed audit that every dependency license is permissive.  |

## Example pipelines

Ready-to-import example pipelines live in [`examples/`](examples/) — import one
via `POST /api/import` to get a fresh install off the ground. Start with
`01-filter-numbers.pipeline.json`, which needs no connection to run. See
[`examples/README.md`](examples/README.md) for the full set and how to import.

## Layout

```text
packages/
  shared/   Zod schemas + the pure run reducer, shared front-end and back-end
  server/   Fastify API, Drizzle + SQLite store, engine, scheduler
  web/       React + React Flow authoring UI (Vite)
  cli/       command-line tooling (e.g. the license audit)
docs/       target architecture, foundation specs, backlog
examples/   ready-to-import example pipelines (see examples/README.md)
```

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
