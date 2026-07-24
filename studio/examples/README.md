# Example pipelines

Ready-to-import pipelines to get a fresh self-host install off the ground. Each
file is a version-stamped **export envelope** — the exact format
`GET /api/pipelines/:id/export` produces and `POST /api/import` accepts — so you
can bring one straight into your own workspace and adapt it.

| File                               | What it shows                              | Needs setup?                    |
| ---------------------------------- | ------------------------------------------ | ------------------------------- |
| `01-filter-numbers.pipeline.json`  | A pipeline that runs with no connection    | No                              |
| `02-http-fetch.pipeline.json`      | Calling out to the world over HTTP         | Yes — bind an `http` connection |
| `03-stage-container.pipeline.json` | Grouping activities in a `stage` container | No                              |

## Import one

The body of a `POST /api/import` request _is_ the envelope file:

```bash
curl -X POST http://localhost:8080/api/import \
  -H 'content-type: application/json' \
  --data-binary @examples/01-filter-numbers.pipeline.json
```

The response is a `201` with the newly-created pipeline (with fresh ids, owned by
you) and an `attention` list of follow-up steps — for example, a node whose
connection could not be carried across workspaces and needs re-binding. Every
import re-mints ids and **never** carries a secret or a cross-workspace
connection binding across, so imported connections/triggers always start unbound.

## The examples

### `01-filter-numbers` — run it with no connection setup

One `filter` activity over a `numbers` parameter (default `[1, 2, 3, 4, 5]`),
keeping the elements greater than `2`. No connection, no external calls. To run
it, add a manual trigger bound to the imported pipeline version, then fire it
(`POST /api/triggers/:id/fire`, a "run now") and watch the run live. The
predicate shows the expression language's function form: `${greater(item, 2)}`
(there are no infix operators — comparisons are functions, and `item` is the
element being tested).

### `02-http-fetch` — reach the outside world

One `http_request` activity that fetches the `url` parameter. Because a
connection is specific to the workspace that authored it, the export **strips**
the binding: on import you get an `unresolvedConnectionRef` attention item for
the `fetch` node. Create an `http` connection in your workspace, then author a
new version of the pipeline binding the node to it (versions are immutable, so
re-binding always means a new version) before the pipeline can run.

### `03-stage-container` — group activities

Two `filter` activities grouped inside a `stage` container. A stage runs its
children as a unit and completes once they are all terminal. This one needs no
connection, and it doubles as the shipped proof that control-flow **containers**
survive an export/import round-trip intact.

## How these stay valid

`packages/server/src/portability/__tests__/examples.test.ts` imports every
`*.pipeline.json` in this directory into a throwaway database on each CI run —
exercising the same version check, strict schema, and document-validation gate a
real import does — and round-trips it back out through the export path. If a future
schema or activity-catalog change would break one of these files, that test fails
loudly rather than letting a broken example ship.
