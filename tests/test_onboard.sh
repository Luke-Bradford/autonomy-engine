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

check "roles/qa.md scaffolded (subdirectory, #13)" "0" "$([ -f "$tmp/.autonomy/roles/qa.md" ] && echo 0 || echo 1)"
check "roles/researcher.md scaffolded (W5b, #127)" "0" "$([ -f "$tmp/.autonomy/roles/researcher.md" ] && echo 0 || echo 1)"
check "roles/pm.md scaffolded (W5c, #89)" "0" "$([ -f "$tmp/.autonomy/roles/pm.md" ] && echo 0 || echo 1)"
check "qa/decide.sh scaffolded (subdirectory, #13)" "0" "$([ -f "$tmp/.autonomy/qa/decide.sh" ] && echo 0 || echo 1)"

# SD-31 (#90): the scaffold must NOT ship a plausible-looking board name -- a
# title that references a board nobody created makes board.sh warn-skip for the
# repo's whole life while looking configured. Empty = explicitly unconfigured
# (board.sh + doctor.sh both surface that state).
scaffolded_title="$(python3 "$ENGINE_HOME/lib/config_parser.py" "$tmp/.autonomy/config.yaml" board.project_title 2>/dev/null || printf '')"
check "scaffolded board.project_title is EMPTY (SD-31, #90)" "" "$scaffolded_title"

# #320: planner/coder pair is the default -- the planner agent lands in
# .claude/agents/ (where Claude Code reads subagents), NOT inside .autonomy/.
check "planner agent scaffolded (.claude/agents, #320)" "0" "$([ -f "$tmp/.claude/agents/planner.md" ] && echo 0 || echo 1)"
check "planner agent carries a thinking-tier model override" "0" "$(grep -q '^model: claude-opus' "$tmp/.claude/agents/planner.md" && echo 0 || echo 1)"

echo "MY CUSTOM EDIT" > "$tmp/.autonomy/config.yaml"
echo "MY QA PROMPT" > "$tmp/.autonomy/roles/qa.md"
echo "MY PLANNER" > "$tmp/.claude/agents/planner.md"
"$ENGINE_HOME/bin/onboard.sh" "$tmp" >/dev/null 2>&1
check "idempotent -- does not clobber an existing file" "MY CUSTOM EDIT" "$(cat "$tmp/.autonomy/config.yaml")"
check "idempotent in subdirectories too" "MY QA PROMPT" "$(cat "$tmp/.autonomy/roles/qa.md")"
check "idempotent -- never clobbers an existing planner agent" "MY PLANNER" "$(cat "$tmp/.claude/agents/planner.md")"

# CP2 (#320): a DIRECTORY squatting the planner path must warn, not fake a
# scaffold (cp into the dir would claim success while no agent file exists).
sq="$(mktemp -d)"
mkdir -p "$sq/.claude/agents/planner.md"
sq_out="$("$ENGINE_HOME/bin/onboard.sh" "$sq" 2>&1 || true)"
check "dir squatting planner path warns" "0" "$(grep -q 'not a regular file' <<<"$sq_out" && echo 0 || echo 1)"
check "dir squatting planner path scaffolds nothing inside it" "1" "$([ -f "$sq/.claude/agents/planner.md/planner.md" ] && echo 0 || echo 1)"
rm -rf "$sq"

# --- --claude-md: opt-in starter CLAUDE.md scaffold (#152) -------------------
# Default (no flag): the pack scaffold never touches CLAUDE.md.
noc="$(mktemp -d)"
"$ENGINE_HOME/bin/onboard.sh" "$noc" >/dev/null 2>&1
check "no --claude-md flag -> CLAUDE.md NOT created" "1" "$([ -f "$noc/CLAUDE.md" ] && echo 0 || echo 1)"
rm -rf "$noc"

# --claude-md on a repo with none: scaffolds a marked starter at the repo root.
fresh="$(mktemp -d)"
"$ENGINE_HOME/bin/onboard.sh" "$fresh" --claude-md >/dev/null 2>&1
check "--claude-md -> CLAUDE.md created at repo root" "0" "$([ -f "$fresh/CLAUDE.md" ] && echo 0 || echo 1)"
check "scaffold is clearly marked as a starter" "0" "$(grep -qi 'STARTER SCAFFOLD' "$fresh/CLAUDE.md" && echo 0 || echo 1)"
rm -rf "$fresh"

# Idempotent: an existing root CLAUDE.md is never overwritten.
keep="$(mktemp -d)"
printf 'MY REAL CLAUDE MD\n' > "$keep/CLAUDE.md"
"$ENGINE_HOME/bin/onboard.sh" "$keep" --claude-md >/dev/null 2>&1
check "--claude-md never clobbers an existing root CLAUDE.md" "MY REAL CLAUDE MD" "$(cat "$keep/CLAUDE.md")"
rm -rf "$keep"

# Respects the .claude/ location too: a .claude/CLAUDE.md means "has one",
# so no root scaffold is written (doctor accepts either location).
dotc="$(mktemp -d)"
mkdir -p "$dotc/.claude"
printf 'DOT CLAUDE MD\n' > "$dotc/.claude/CLAUDE.md"
"$ENGINE_HOME/bin/onboard.sh" "$dotc" --claude-md >/dev/null 2>&1
check "--claude-md skips when .claude/CLAUDE.md already present" "1" "$([ -f "$dotc/CLAUDE.md" ] && echo 0 || echo 1)"
rm -rf "$dotc"

# --- workstreams slice 1: .gitignore must cover var/ (the live config home;
# preflight's stash -u would sweep an unignored var/) ---
gi="$(mktemp -d)"
"$ENGINE_HOME/bin/onboard.sh" "$gi" >/dev/null 2>&1
check "fresh repo gets a .gitignore with var/" "0" "$(grep -qx 'var/' "$gi/.gitignore" && echo 0 || echo 1)"
"$ENGINE_HOME/bin/onboard.sh" "$gi" >/dev/null 2>&1
check "gitignore var/ never duplicated" "1" "$(grep -cx 'var/' "$gi/.gitignore")"
rm -rf "$gi"

gi2="$(mktemp -d)"
printf 'node_modules/\n' > "$gi2/.gitignore"
"$ENGINE_HOME/bin/onboard.sh" "$gi2" >/dev/null 2>&1
check "existing gitignore preserved" "0" "$(grep -qx 'node_modules/' "$gi2/.gitignore" && echo 0 || echo 1)"
check "var/ appended to existing gitignore" "0" "$(grep -qx 'var/' "$gi2/.gitignore" && echo 0 || echo 1)"
rm -rf "$gi2"

gi3="$(mktemp -d)"
printf 'var\n' > "$gi3/.gitignore"
"$ENGINE_HOME/bin/onboard.sh" "$gi3" >/dev/null 2>&1
check "bare 'var' line counts as covered" "0" "$(grep -cx 'var/' "$gi3/.gitignore")"
rm -rf "$gi3"


# --- slice 3a: planner agent path must be gitignored (materialized file) ----
gp="$(mktemp -d)"
"$ENGINE_HOME/bin/onboard.sh" "$gp" >/dev/null 2>&1
check "planner path gitignored on onboard" "0" "$(grep -qx '.claude/agents/planner.md' "$gp/.gitignore" && echo 0 || echo 1)"
"$ENGINE_HOME/bin/onboard.sh" "$gp" >/dev/null 2>&1
check "planner ignore line never duplicated" "1" "$(grep -cx '.claude/agents/planner.md' "$gp/.gitignore")"
rm -rf "$gp"

echo "---"
# --- pack skills (#362, #361 slice a): starter skills land in .claude/skills/
# (where Claude Code reads them), NOT inside .autonomy/ -- same home logic as
# the planner agent. Additive elaboration only; never overwrite user content.
ps="$(mktemp -d)"
"$ENGINE_HOME/bin/onboard.sh" "$ps" >/dev/null 2>&1
for sk in working-under-the-loop pipeline-sessions; do
  check "pack skill $sk scaffolded (.claude/skills, #362)" "0" \
    "$([ -f "$ps/.claude/skills/$sk/SKILL.md" ] && echo 0 || echo 1)"
  check "pack skill $sk has a 'Use when' description (trigger-scoped)" "0" \
    "$(grep -q '^description: Use when' "$ps/.claude/skills/$sk/SKILL.md" && echo 0 || echo 1)"
done
echo "MY SKILL EDIT" > "$ps/.claude/skills/pipeline-sessions/SKILL.md"
"$ENGINE_HOME/bin/onboard.sh" "$ps" >/dev/null 2>&1
check "idempotent -- never clobbers a user-edited pack skill" "MY SKILL EDIT" \
  "$(cat "$ps/.claude/skills/pipeline-sessions/SKILL.md")"
rm -rf "$ps"

# A directory squatting a skill's SKILL.md path must WARN, not fake a scaffold
# (the planner-path rule, same fail-safe reason).
sqs="$(mktemp -d)"
mkdir -p "$sqs/.claude/skills/working-under-the-loop/SKILL.md"
sqs_out="$("$ENGINE_HOME/bin/onboard.sh" "$sqs" 2>&1 || true)"
check "dir squatting a skill path warns" "0" \
  "$(grep -c 'not a regular file' <<<"$sqs_out" | awk '{print ($1>=1)?0:1}')"
check "dir squatting a skill path scaffolds nothing inside it" "1" \
  "$([ -f "$sqs/.claude/skills/working-under-the-loop/SKILL.md/SKILL.md" ] && echo 0 || echo 1)"
rm -rf "$sqs"

# CP2 (#362): a regular FILE squatting the skill's parent DIRECTORY would make
# `mkdir -p` fail under set -e and kill onboard mid-scaffold -- must WARN,
# skip, and keep scaffolding the rest.
fq="$(mktemp -d)"
mkdir -p "$fq/.claude/skills"
echo squat > "$fq/.claude/skills/working-under-the-loop"   # file where dir belongs
fq_out="$("$ENGINE_HOME/bin/onboard.sh" "$fq" 2>&1)"
fq_rc=$?
check "file squatting a skill DIR -> onboard completes (rc 0)" "0" "$fq_rc"
check "file squatting a skill DIR -> warns" "0" \
  "$(grep -q 'working-under-the-loop.*NOT scaffolded' <<<"$fq_out" && echo 0 || echo 1)"
check "file squatting one skill dir -> the OTHER skill still scaffolds" "0" \
  "$([ -f "$fq/.claude/skills/pipeline-sessions/SKILL.md" ] && echo 0 || echo 1)"
rm -rf "$fq"

# CP2 (#362): a DANGLING SYMLINK at SKILL.md is neither -f nor -e -- without a
# -L check the scaffold would cp through/over it. Must WARN + skip.
ds="$(mktemp -d)"
mkdir -p "$ds/.claude/skills/pipeline-sessions"
ln -s /nonexistent-target "$ds/.claude/skills/pipeline-sessions/SKILL.md"
ds_out="$("$ENGINE_HOME/bin/onboard.sh" "$ds" 2>&1)"
check "dangling symlink at SKILL.md -> warns, not scaffolded" "0" \
  "$(grep -q 'pipeline-sessions.*not a regular file' <<<"$ds_out" && echo 0 || echo 1)"
check "dangling symlink remains a symlink (never replaced)" "0" \
  "$([ -L "$ds/.claude/skills/pipeline-sessions/SKILL.md" ] && echo 0 || echo 1)"
rm -rf "$ds"

# Same-class (planner block shares the mkdir hazard): a FILE squatting
# .claude/agents must WARN, not kill the script.
pq="$(mktemp -d)"
mkdir -p "$pq/.claude"
echo squat > "$pq/.claude/agents"
pq_out="$("$ENGINE_HOME/bin/onboard.sh" "$pq" 2>&1)"
pq_rc=$?
check "file squatting .claude/agents -> onboard completes (rc 0)" "0" "$pq_rc"
check "file squatting .claude/agents -> planner warn" "0" \
  "$(grep -q 'planner.*NOT scaffolded' <<<"$pq_out" && echo 0 || echo 1)"
rm -rf "$pq"

if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
