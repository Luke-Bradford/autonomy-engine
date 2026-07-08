#!/usr/bin/env bash
# tests/test_planner_materialize.sh -- slice 3a: the pair's planner agent is
# MATERIALIZED from config each session (agent.planner.model, live-shadow
# editable). Fail-safe: never creates git-VISIBLE dirt (preflight would sweep
# it), never overrides a tracked-and-different file, invalid model ids fall
# back to the template default with a NOTE.
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
SUPLOG=/dev/null
LOGMSGS=""
log() { LOGMSGS="$LOGMSGS
$*"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

mkrepo() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/.autonomy"
  printf 'agent:\n  type: claude\n' > "$d/.autonomy/config.yaml"
  git init -q "$d"
  printf 'var/\n.claude/agents/planner.md\n' > "$d/.gitignore"
  ( cd "$d" && git add .gitignore .autonomy/config.yaml >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm init )
  printf '%s' "$d"
}

DST=".claude/agents/planner.md"

# --- absent + ignored: materializes with the template default ---------------
r="$(mkrepo)"; cd "$r" || exit 1
LOGMSGS=""; materialize_planner
check "materializes when absent" "0" "$([ -f "$DST" ] && echo 0 || echo 1)"
check "template default model kept" "0" "$(grep -q '^model: claude-opus-4-8' "$DST" && echo 0 || echo 1)"

# --- config model applied -----------------------------------------------------
printf 'agent:\n  type: claude\n  planner:\n    model: claude-fable-5\n' > .autonomy/config.yaml
LOGMSGS=""; materialize_planner
check "config planner model applied" "0" "$(grep -q '^model: claude-fable-5' "$DST" && echo 0 || echo 1)"

# --- live shadow wins ----------------------------------------------------------
mkdir -p var/autonomy
printf 'agent:\n  type: claude\n  planner:\n    model: claude-sonnet-5\n' > var/autonomy/config.yaml
LOGMSGS=""; materialize_planner
check "live-shadow planner model wins" "0" "$(grep -q '^model: claude-sonnet-5' "$DST" && echo 0 || echo 1)"
rm -rf var/autonomy

# --- invalid model -> template default + NOTE ----------------------------------
printf 'agent:\n  type: claude\n  planner:\n    model: "bad model"\n' > .autonomy/config.yaml
rm -f "$DST"
LOGMSGS=""; materialize_planner
check "invalid model falls back to template default" "0" "$(grep -q '^model: claude-opus-4-8' "$DST" && echo 0 || echo 1)"
check "invalid model NOTE logged" "0" "$(grep -q 'not a valid model id' <<<"$LOGMSGS" && echo 0 || echo 1)"
cd /; rm -rf "$r"

# --- tracked-and-different: respected + NOTE -----------------------------------
r="$(mkrepo)"; cd "$r" || exit 1
printf 'var/\n' > .gitignore   # planner path NOT ignored -> trackable
mkdir -p .claude/agents
printf -- '---\nname: planner\nmodel: my-custom\n---\ncustom body\n' > "$DST"
( git add "$DST" .gitignore >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm planner )
LOGMSGS=""; materialize_planner
check "tracked-and-different kept verbatim" "0" "$(grep -q 'my-custom' "$DST" && echo 0 || echo 1)"
check "tracked-and-different NOTE logged" "0" "$(grep -q 'tracked and differs' <<<"$LOGMSGS" && echo 0 || echo 1)"
cd /; rm -rf "$r"

# --- absent + NOT ignored: refuses to create git-visible dirt ------------------
r="$(mkrepo)"; cd "$r" || exit 1
printf 'var/\n' > .gitignore
( git add .gitignore >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm gi )
LOGMSGS=""; materialize_planner
check "not-ignored path refuses creation" "1" "$([ -f "$DST" ] && echo 0 || echo 1)"
check "not-ignored NOTE names the fix" "0" "$(grep -q 'gitignore' <<<"$LOGMSGS" && echo 0 || echo 1)"
cd /; rm -rf "$r"

# --- codex repos: inert no-op --------------------------------------------------
r="$(mkrepo)"; cd "$r" || exit 1
printf 'agent:\n  type: codex\n' > .autonomy/config.yaml
LOGMSGS=""; materialize_planner
check "codex repo is a no-op" "1" "$([ -f "$DST" ] && echo 0 || echo 1)"
cd /; rm -rf "$r"

# --- dir squatting the path: NOTE + skip ---------------------------------------
r="$(mkrepo)"; cd "$r" || exit 1
mkdir -p "$DST"
LOGMSGS=""; materialize_planner
check "dir at path skipped" "1" "$([ -f "$DST" ] && echo 0 || echo 1)"
check "dir at path NOTE logged" "0" "$(grep -q 'not a regular file' <<<"$LOGMSGS" && echo 0 || echo 1)"
cd /; rm -rf "$r"


# --- untracked + git-VISIBLE existing file that differs: kept + NOTE (CP2) ----
r="$(mkrepo)"; cd "$r" || exit 1
printf 'var/\n' > .gitignore
( git add .gitignore >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm gi )
mkdir -p .claude/agents
printf -- '---\nname: planner\nmodel: my-local-tweak\n---\nbody\n' > "$DST"
LOGMSGS=""; materialize_planner
check "untracked git-visible file kept verbatim" "0" "$(grep -q 'my-local-tweak' "$DST" && echo 0 || echo 1)"
check "untracked git-visible NOTE logged" "0" "$(grep -q 'git-visible' <<<"$LOGMSGS" && echo 0 || echo 1)"
cd /; rm -rf "$r"

# --- wiring: run_session calls it after preflight (grep belt) ------------------
check "materialize_planner wired into run_session" "1" "$(grep -c '^  materialize_planner$' "$ENGINE_HOME/bin/supervisor.sh")"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILURES"; exit 1; fi
