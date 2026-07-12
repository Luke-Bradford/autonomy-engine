# .autonomy/triggers/ — starter trigger files

A **trigger** is a first-class JSON file, `.autonomy/triggers/<name>.json`, that
binds ONE pipeline and decides **when** it runs. Triggers are the dispatch unit:
the engine enumerates every trigger each loop iteration and starts runs from them.

The four files here are **inert examples** — each ships `"enabled": false`, so
onboarding never auto-arms a loop. They exist to be read, copied, and edited.
Enable one by setting `"enabled": true` (and adjust the bound pipeline / params
for your repo first).

| file | firing mode | what it does |
|---|---|---|
| `continuous-example.json` | `continuous` | starts a run whenever capacity is free — the classic always-on loop |
| `nightly-example.json` | `schedule` | one run on a cron schedule (here `0 3 * * *`, **UTC**) |
| `on-pr-sync-example.json` | `event` | starts a run on a repo event (here `pr.synchronize`), mapping payload fields to pipeline params |
| `manual-example.json` | `manual` | never fires on its own — run it on demand ("run now") from the dashboard |

All four bind the shipped `ticket-to-merge` pipeline.

## The shape

```json
{
  "name": "<matches the filename stem>",
  "pipeline": "<a pipeline under .autonomy/pipelines/>",
  "firing": { "mode": "continuous | schedule | event | manual" },
  "concurrency": { "policy": "skip | queue | parallel", "max": 1 },
  "enabled": false
}
```

- **`name` must equal the filename stem** — a rename can't silently fork identity.
- **`firing.schedule`** (a 5-field cron expression, UTC) is required for `schedule`
  and invalid for any other mode.
- **`firing.event`** is one of `pr.opened`, `issue.created`, `merge.done`,
  `pr.synchronize`; **`firing.map`** feeds event payload fields (`item`, `sha`,
  `event`) into pipeline params. `sha` exists only on `pr.synchronize`.
- **`concurrency.policy`**: `skip` (drop a fire while one is running), `queue`
  (at most one waiting; `max` must be 1; not valid for `event`), or `parallel`
  (up to `max` at once). Omit the block for the safe default `{skip, 1}`.
- **`params`**, **`lane`**, and **`run_windows`** are optional (see the schema
  reference in the engine's `docs/pipelines.md`).

## Event triggers and params

`on-pr-sync-example.json` maps `item` → `ticket` and `sha` → `head_sha`. The
bound pipeline must **declare** those params for the mapping to resolve — the
shipped `ticket-to-merge` pipeline declares no params, so this file is a
template to adapt (point it at a pipeline that declares matching params, or drop
the map). Param existence is checked when a run starts, not at validation.

## Triggers vs. the `roles:` block

A `roles:` entry in `config.yaml` is auto-shimmed into an equivalent trigger, so
you don't need a file for a simple loop. A **native trigger file supersedes a
role shim of the same name** — name a starter after a role only if you mean to
override it (that's why these are `-example`-suffixed).

## Checking your triggers

- `bin/doctor.sh <repo>` reports every trigger (validity, mode, native/shim,
  enabled/disabled, bound pipeline) — read-only, never provisions.
- `python3 lib/triggers.py show <repo> <name>` prints one trigger's resolved fields.
- `python3 lib/triggers.py validate <repo>` fails only on a refused (invalid or
  colliding) trigger.
