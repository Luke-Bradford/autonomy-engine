# W5b — Researcher role rail (#127)

Part of #89 (W5 role rails). Slice after W5a (QA, #126). Adds the read-only,
cron-scheduled Researcher role rail the design (`docs/agent-org-design.md`) and
the `templates/autonomy-pack/config.yaml` example already reference but that no
pack file backs yet.

## Global constraints (CI-enforced)
- macOS bash 3.2.57 — no mapfile/globstar/`declare -A`/`${var,,}`.
- Python 3 stdlib only.
- shellcheck -S warning clean across the listed globs (test `.sh` included).
- Tests genuine: source the real script / import the real module; no assert-on-mock.
- Repo-agnostic: the rail is a *template* under `templates/` — placeholders/roles
  only, no target-repo owner/board/issue numbers.

## The gap this closes
`templates/autonomy-pack/config.yaml` documents a `researcher:` role whose
`prompt:` is `.autonomy/roles/researcher.md`, but `templates/autonomy-pack/roles/`
holds only `README.md` + `qa.md`. onboard.sh copies every template file
generically (`find -print0` loop), so adding the rail is enough to scaffold it;
today the documented example points at a file that never lands.

## File map
- ADD `templates/autonomy-pack/roles/researcher.md` — the rail.
- EDIT `templates/autonomy-pack/roles/README.md` — move `researcher.md` from the
  "write these yourself when enabling" note into the scaffolded-standard list
  (it now ships); leave `pm.md` as operator-written.
- EDIT `tests/test_onboard.sh` — assert onboard scaffolds `roles/researcher.md`.
- EDIT `tests/test_roles.py` — validate the *actual documented* `researcher:`
  example AND guard the config→rail linkage via `check_prompt_files`.

## Task 1 — failing tests first
1. `tests/test_onboard.sh`: add a `check "roles/researcher.md scaffolded"` line
   next to the existing `roles/qa.md` assertion (same `[ -f ... ]` idiom). This
   is the test that truly bites today — the file is absent.
2. `tests/test_roles.py`: add `test_researcher_config_example_validates` — build
   the researcher role dict **exactly as `templates/autonomy-pack/config.yaml`
   documents it** (verified against the file, not from memory):
   `enabled: false`, `account: "codex-sub"`, `trigger: {type: cron,
   schedule: "0 3 * * *"}`, `output: "handoff-to-pm"`, `web_search: false`,
   `prompt: ".autonomy/roles/researcher.md"` (no `substrate`, no `tools` — the
   documented example carries neither). Assert `validate_roles({"roles": {...}})
   == []`. If it does NOT validate, that is a real config-vs-validator bug to
   surface, not something to paper over by editing the test to a different shape.
3. `tests/test_roles.py`: add `test_researcher_prompt_path_resolves` — the drift
   guard. `validate_roles` is pure and does NOT check prompt files; path/existence
   checking lives in `check_prompt_files(config, repo_root)` (lib/roles.py:246,
   the doctor.sh path). Build a temp `repo_root`, write
   `.autonomy/roles/researcher.md` under it, and assert
   `check_prompt_files(cfg, repo_root) == []`; then remove the file and assert it
   now reports the missing-prompt error. This proves the documented `prompt:`
   path and the shipped rail path cannot silently drift — existence, not just
   non-escaping, is the invariant that catches today's bug.

## Task 2 — write the rail
`templates/autonomy-pack/roles/researcher.md`, mirroring `qa.md`'s quality bar:
- Identity: the repo's read-only Researcher; runs on a schedule (cron) or manual.
- Read-only posture, stated precisely (Codex checkpoint-1 finding): the role is
  **filesystem/repo read-only** — Read/Grep/Glob only, never edits code, runs it,
  or merges. It may WRITE to the board **only** when `output: raise-issues` AND a
  permitted GitHub/MCP write capability is actually present; if that capability is
  absent it **fails closed** to a structured findings list (never silently drops,
  never assumes a write path it lacks). Same untrusted-world posture as QA —
  findings are named precisely, never self-applied.
- What to future-think about: the app itself (health, gaps, rough edges), the
  board (stale/duplicate/missing tickets, opportunities), the stack + ecosystem
  (dependency/toolchain updates, relevant new capabilities) — bounded to *this*
  repo's remit, no speculative scope creep.
- Output contract: for `output: raise-issues`, file ONE verified GitHub issue per
  distinct finding, labelled, linked, no speculative issues (verify before
  filing) — reusing QA's one-finding-one-issue discipline. For
  `handoff-to-pm`, emit findings as a structured list for the PM role to triage.
- `web_search`: only when the role's `web_search: true`; otherwise reason from
  the repo + board alone.
- Explicit non-goals: never edits code, never merges, never re-labels the live
  board destructively (that's PM's careful remit).

## Task 3 — gates + commit
`bash tests/run_all.sh`; `shellcheck -S warning start bin/*.sh bin/agents/*.sh
tests/*.sh templates/autonomy-pack/qa/*.sh`; pre-flight-review; Codex checkpoint 2;
branch push + PR.

## Self-review notes
- No dispatch change: `web_search`/`output` remain declarative + rail-embodied,
  identical to how QA's `gate`/`scope` knobs work — no supervisor edit, no new
  invariant surface.
- Read-only researcher is the fail-safe posture (design doc: "read-only, no merge
  path") — the rail must not hand the role a write/merge path it shouldn't have.
- Not touched: engine's own `.autonomy/**`, `bin/safe_merge.sh`,
  `.github/workflows/**` (unattended guardrails). This ships only a *template*
  rail + tests.
