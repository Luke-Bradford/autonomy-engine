# Workstreams slice 3a — the pair becomes configurable end-to-end

Operator feedback (2026-07-08 evening): "The workstream defines a model …
but I can't change anything. I can't define that as a coder I want opus or
fable to do any planning … that sonnet or haiku could do the coding. What
effort for each. … the config I can't even edit looks confusing to a human."

## Root problem

The planner's model lives in a COMMITTED agent file
(`.claude/agents/planner.md` frontmatter) — not configurable at all without
a commit, and unreachable from the live shadow. The coder's model/effort ARE
config but the page's editors still write the retired overlay.

## Design

1. **Planner config moves into config.yaml**: `agent.planner.model`
   (optional; model id). The live shadow makes it UI-editable instantly.
2. **The engine MATERIALIZES the agent file** from config each session:
   after preflight succeeds, `run_session` renders
   `templates/planner-agent.md` with the configured `model:` into the
   worktree's `.claude/agents/planner.md` — but ONLY when that path is
   git-invisible (untracked or ignored) or content-identical: a
   tracked-and-different file is respected with a logged NOTE (never dirty
   the tree into preflight's sweep cycle). No config key set = template
   default, still materialized when absent.
3. **The engine repo un-commits its own planner.md** and gitignores
   `.claude/agents/planner.md` (dogfood the product path); onboard keeps
   scaffolding it as the starting default (now git-invisible in repos that
   take the gitignore line; scaffold is unchanged for others).
4. **Page editors re-homed onto the live shadow**: `live_scalar_write(repo,
   key, value)` in dashboard_control (seed live from committed+overlay-fold
   on first use — reuse slice-1 seeding; then `set_scalar`; validate per
   CONFIG_PAGE_KEYS + the new `agent.planner.model`). `execute_set_model` /
   `execute_config_set` target it; the overlay write path retires for
   default-scope saves (one-shot next-session override stays).
5. **Pair card becomes the editor**: planner model select (thinking-tier
   roster first), coder model select + effort select, wired to
   `config_set`-style control actions; the flow line reads in plain words:
   plan → build (ask the planner when unsure) → PLAN-CHECK against the plan
   → PR gates.
6. **Cron in plain English**: `cronHuman()` on the page renders common
   shapes ("every 2 hours", "daily 09:00", "every 30 min", "weekdays
   09:00") with the raw expression in a tooltip/mono suffix; unknown shapes
   render raw. Display-only this slice (the trigger EDITOR is slice 3b).
7. `build_org` pair.planner reads config first (effective), agent-file
   frontmatter as fallback: `{model, source: config|agent-file|none,
   scaffolded}`.

## CP1 findings folded (+1 self-found)

- **Latent #320 bug**: an UNTRACKED scaffolded planner.md trips preflight's
  `git status --porcelain` dirty check → 3 skips → `stash -u` SWEEPS it.
  Git-invisibility is therefore mandatory: onboard adds
  `.claude/agents/planner.md` to `.gitignore` (same idempotent block as
  `var/`), and the materializer REFUSES to create a file that would be
  git-visible (`check-ignore` gate + NOTE naming the fix). The engine repo
  un-commits its own copy and takes the ignore line.
- Materialization gates on `agent.type == claude` (codex repos: inert skip).
- Model validation: MODEL_RE at the page write; the materializer re-checks
  with the supervisor's own `valid_model_id` (invalid → template default +
  NOTE, prevention-log #6); `build_org` applies the same syntactic check so
  the card never shows a model the materializer would refuse.
- `build_org` pair.planner carries `source`: `config` | `config-invalid`
  (fallback shown) | `agent-file` | `none` — a tracked-and-different agent
  file surfaces as `agent-file` so the UI never implies config won when it
  didn't (lanes: each lane's supervisor materializes its own worktree).
- Materializer path-squat edges (dir/symlink at the path): NOTE + skip.

## Fail-safe

- Materialization refuses over a tracked-and-different file (NOTE, keeps
  committed content authoritative) — never creates preflight dirt.
- Invalid `agent.planner.model` id: write refused at the page (MODEL_RE);
  a hand-edited invalid value is IGNORED at materialization with a NOTE
  (template default used) — prevention-log #6 revalidation at use.
- live_scalar_write keeps slice-1 refusal semantics (parse-validate-compare;
  var/ gitignore precondition).

## Tests (TDD)

- roles/none needed; config_parser untouched.
- test_dashboard_control: live_scalar_write seeds+writes+validates/refuses;
  set_model/config_set plans target the live file (no overlay key in plan).
- test_headless_dispatch or new test_planner_materialize.sh: materializes
  absent file w/ configured model; respects tracked-and-different (NOTE);
  overwrites ignored file; invalid model -> template default + NOTE;
  live-shadow model wins (resolver).
- test_dashboard_state: pair.planner source precedence (config > file >
  none).
- Browser verify: pick planner model on the card -> live shadow gains
  agent.planner.model; coder model/effort saves land in the shadow; cron
  rows read "every 2 hours".
