### Task 12: README + full test-suite run + final lint pass

**Files:**
- Create: `README.md` (overwrites Task 1's stub)
- Create: `tests/run_all.sh`

**Interfaces:**
- Consumes: everything from Tasks 2–11.
- Produces: `tests/run_all.sh` — one command to run the full suite; `README.md` — the durable pack
  contract + schema + merge-gate reference for anyone (including a future you) onboarding a new repo.

- [ ] **Step 1: Write `tests/run_all.sh`**

```bash
#!/usr/bin/env bash
# tests/run_all.sh -- run every test in this suite, bash and python.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

fail=0
for t in tests/test_*.sh; do
  echo "=== $t ==="
  bash "$t" || fail=1
done

echo "=== python: test_config_parser ==="
python3 -m unittest tests.test_config_parser -v || fail=1

if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASS"; exit 0; else echo "ONE OR MORE SUITES FAILED"; exit 1; fi
```

- [ ] **Step 2: Run it**

```bash
chmod +x tests/run_all.sh
bash tests/run_all.sh
```
Expected: every suite prints `ALL PASS` (or its unittest equivalent), final line `ALL SUITES PASS`.

- [ ] **Step 3: Write the full `README.md`**

```markdown
# autonomy-engine

Repo-agnostic engine for running Claude Code (and, in future, other CLI agents) autonomy loops
against any target repo, from one operator's account.

## Quickstart

```bash
# 1. Scaffold a new target repo's pack:
bin/onboard.sh /path/to/target-repo
# edit /path/to/target-repo/.autonomy/config.yaml

# 2. Check it's ready:
bin/doctor.sh /path/to/target-repo

# 3. Create its dedicated worktree + launchd plist:
bin/setup_worktree.sh /path/to/target-repo

# 4. Load it (see setup_worktree.sh's own printed next-steps for the exact commands)
```

## The `.autonomy/` pack contract

Every target repo needs a `.autonomy/` directory with exactly these three files:

- **`loop_prompt.md`** — the standing task, passed as the primary prompt (`claude -p`).
- **`hard_rules.md`** — non-negotiable safety rules, appended to the session's system prompt.
- **`config.yaml`** — project policy (see schema below). `bin/onboard.sh` scaffolds all three from
  `templates/autonomy-pack/`.

`.autonomy/config.yaml` existing and parsing is the engine's hard requirement for treating a
directory as a valid target repo — `doctor.sh`/`supervisor.sh` both refuse to proceed without it.

## `config.yaml` schema

```yaml
board:
  owner: <github-user-or-org>
  project_title: "<Projects v2 board title>"

engine:
  label: <slug>                # optional; disambiguates two repos sharing a basename
  requires_claude_md: <bool>    # hard-fail (not just warn) if .claude/CLAUDE.md is missing

agent:
  type: claude                  # claude | codex (only claude has an adapter implemented)
  model:
    primary: <model-id>
    fallback: <model-id>
  config: {}                    # opaque, adapter-owned pass-through (unused by the claude adapter)

merge_gate:
  strategy: manual | ci_only | bot_comment | gh_review
  author_login: <string>        # bot_comment only
  marker: <string>               # bot_comment only
  doc_only_extensions: [<ext>]   # bot_comment only, e.g. [".md"]
  reviewer_login: <string>       # gh_review only

worktree:
  default_path: "../.{repo-slug}-autonomy"
```

Every value is either optional-with-an-engine-default or required-only-for-the-strategy-that-uses-
it. Nothing in the engine hardcodes any one repo's actual values.

`{repo-slug}` = `engine.label` if set, else the target repo's directory basename, lowercased,
non-alphanumeric runs collapsed to `-`.

## Merge-gate strategies

CI-green is checked first (any failing/pending check refuses; a `gh` API failure itself refuses,
never treated as green; `ci_only` additionally refuses on zero configured checks). Then:

| Strategy | What it checks |
|---|---|
| `manual` (default) | Nothing further — never auto-merges. PRs stay open for a human. |
| `ci_only` | Nothing further — CI green is the whole gate. |
| `bot_comment` | Latest matching issue comment (by `author_login` + `marker`) postdates the head commit and reads APPROVE, no BLOCKING/REQUEST CHANGES. Includes a doc-only fast path for PRs where every changed file matches `doc_only_extensions`. |
| `gh_review` | Latest GitHub Review object from `reviewer_login` postdates the head commit and its `state == APPROVED`. |

`bin/safe_merge.sh <pr-number>` is the only sanctioned merge path — the loop must never call
`gh pr merge` directly.

## `bin/` reference

| Script | Purpose |
|---|---|
| `supervisor.sh --repo <path> [--agent-type] [--model] [--fallback-model] [--label]` | The main loop launchd runs |
| `onboard.sh <target-repo>` | Scaffold `.autonomy/` (idempotent) |
| `doctor.sh <target-repo>` | Full readiness report (network calls; diagnostic-only, never provisions) |
| `setup_worktree.sh <target-repo> [worktree-path]` | Create/reuse the dedicated worktree + install the launchd plist |
| `worktree_gc.sh --repo <path>` | Prune stale worktrees + merged branches |
| `safe_merge.sh <pr-number>` | The only sanctioned merge path |
| `board.sh status <issue#> "<status>" \| add <issue#>` | Best-effort GitHub Projects v2 board updates |
| `unblock_dependents.sh <merged-pr-number>` | Post-merge "blocked by #X" notifier |
| `agents/claude.sh` | The Claude Code agent adapter (only one implemented) |

## Agent adapters

`bin/agents/<type>.sh`, dispatched by `agent.type`. Each implements two functions:

- `agent_invoke(prompt_file, safety_file, model, fallback_model, log_file) -> exit code`
- `agent_classify_outcome(log_file, exit_code) -> "success" | "usage_limit [epoch]" | "error"`

Only `claude.sh` exists today. A `codex.sh` is a real future possibility (Codex's CLI differs
structurally — no system-prompt-append flag, its own JSONL schema, no native fallback-model
support) but is not built or tested here.

## Testing

```bash
bash tests/run_all.sh
```
```

- [ ] **Step 4: Run the full suite once more against the finished README (sanity — README changes
  don't affect test behavior, this just confirms nothing regressed while writing it)**

```bash
bash tests/run_all.sh
```
Expected: `ALL SUITES PASS`.

- [ ] **Step 5: shellcheck every script in the repo, one final pass**

```bash
shellcheck -S warning bin/*.sh bin/agents/*.sh tests/*.sh
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add README.md tests/run_all.sh
git commit -m "docs: full README (pack contract, config schema, merge-gate + bin reference)"
git push
```

---

