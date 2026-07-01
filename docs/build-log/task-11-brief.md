### Task 11: `onboard.sh` + pack templates

**Files:**
- Create: `bin/onboard.sh`
- Create: `templates/autonomy-pack/config.yaml`
- Create: `templates/autonomy-pack/loop_prompt.md`
- Create: `templates/autonomy-pack/hard_rules.md`
- Test: `tests/test_onboard.sh`

**Interfaces:**
- Consumes: nothing at runtime (pure file-copy).
- Produces: CLI `bin/onboard.sh <target-repo>` — scaffolds `.autonomy/` idempotently.

- [ ] **Step 1: Write the failing test**

```bash
# tests/test_onboard.sh
#!/usr/bin/env bash
# Unit test for onboard.sh's scaffolding idempotency.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "config.yaml scaffolded" "0" "$([ -f "$tmp/.autonomy/config.yaml" ] && echo 0 || echo 1)"
check "loop_prompt.md scaffolded" "0" "$([ -f "$tmp/.autonomy/loop_prompt.md" ] && echo 0 || echo 1)"
check "hard_rules.md scaffolded" "0" "$([ -f "$tmp/.autonomy/hard_rules.md" ] && echo 0 || echo 1)"

echo "MY CUSTOM EDIT" > "$tmp/.autonomy/config.yaml"
"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "idempotent -- does not clobber an existing file" "MY CUSTOM EDIT" "$(cat "$tmp/.autonomy/config.yaml")"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_onboard.sh
bash tests/test_onboard.sh
```
Expected: fails (`bin/onboard.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/onboard.sh`**

```bash
#!/usr/bin/env bash
# bin/onboard.sh -- scaffold .autonomy/ in a target repo from
# templates/autonomy-pack/. Idempotent: never overwrites an existing file.
#
# Usage: onboard.sh <target-repo>
set -euo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:?usage: onboard.sh <target-repo>}"
TARGET_REPO="$(cd "$TARGET" && pwd)"
PACK_DIR="$TARGET_REPO/.autonomy"
TEMPLATE_DIR="$ENGINE_HOME/templates/autonomy-pack"

mkdir -p "$PACK_DIR"

copied=0
skipped=0
for f in "$TEMPLATE_DIR"/*; do
  name="$(basename "$f")"
  dest="$PACK_DIR/$name"
  if [ -f "$dest" ]; then
    echo "onboard.sh: SKIP $name (already exists)"
    skipped=$((skipped + 1))
  else
    cp "$f" "$dest"
    echo "onboard.sh: created $name"
    copied=$((copied + 1))
  fi
done

echo "onboard.sh: $copied file(s) created, $skipped already present. Edit $PACK_DIR/config.yaml before running the loop."
```

- [ ] **Step 4: Create `templates/autonomy-pack/config.yaml`**

```yaml
# .autonomy/config.yaml -- per-repo policy for the autonomy engine.
# See autonomy-engine/README.md for the full schema reference.

board:
  owner: CHANGE-ME          # GitHub user or org that owns the Projects v2 board
  project_title: "CHANGE-ME engineering board"

engine:
  # label: my-repo          # uncomment + set only if this repo's basename collides
  #                         # with another target repo on the same machine
  requires_claude_md: false  # set true if this repo's workflow assumes CLAUDE.md exists

agent:
  type: claude               # claude | codex (only claude has an adapter implemented)
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6

merge_gate:
  strategy: manual           # manual | ci_only | bot_comment | gh_review
  # bot_comment-specific:
  # author_login: github-actions
  # marker: "Claude Code Review"
  # doc_only_extensions: [".md"]
  # gh_review-specific:
  # reviewer_login: some-reviewer-bot[bot]

worktree:
  default_path: "../.{repo-slug}-autonomy"
```

- [ ] **Step 5: Create `templates/autonomy-pack/hard_rules.md`**

```markdown
# Hard safety rules -- NEVER violate, even unattended

- Never `git push --no-verify` (emergencies only).
- Merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>` -- never `gh pr merge` directly.
- Follow `.claude/CLAUDE.md` (if present) and `.autonomy/loop_prompt.md` exactly.

<!-- Edit this file for your repo's own non-negotiables (trading/finance/
     destructive-ops rules, whatever applies). This is a starter, not a
     complete policy. -->
```

- [ ] **Step 6: Create `templates/autonomy-pack/loop_prompt.md`**

```markdown
# Autonomy loop -- standing task

You are running headless and unattended to drain this repo's engineering
board. Work through open tickets back-to-back. Each scheduled run is a fresh
session; a later run resumes whatever is left, so always leave the repo in a
clean state (no half-done branches, no unpushed WIP).

## Each iteration
1. Triage the board: `gh issue list --state open --limit 100`. Pick the
   highest-value actionable ticket. Decide the order yourself.
2. Execute the ticket's full workflow (read -> plan -> implement -> test ->
   PR). Merge ONLY via `"$AUTONOMY_ENGINE_HOME/bin/safe_merge.sh" <pr>` --
   it mechanically verifies the configured merge gate; never merge around it.
   If it reports manual-mode, leave the PR open and move to the next ticket.
3. Update the board via `"$AUTONOMY_ENGINE_HOME/bin/board.sh" status <n>
   "<status>"` at each lifecycle transition (best-effort -- a board hiccup
   never blocks real work).
4. Next ticket.

<!-- Edit this file for your repo's own triage rules, QA steps, and anything
     else specific to how this project wants its board drained. This is a
     starter, not a complete policy. -->
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
bash tests/test_onboard.sh
```
Expected: `ALL PASS`.

- [ ] **Step 8: shellcheck**

```bash
shellcheck -S warning bin/onboard.sh
```
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add bin/onboard.sh templates/autonomy-pack/ tests/test_onboard.sh
git commit -m "feat: add onboard.sh + autonomy-pack templates"
git push
```

---

