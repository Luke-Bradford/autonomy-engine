#!/usr/bin/env bash
# tests/test_fingerprint_gate.sh -- #318 deterministic pre-session fingerprint
# gate + idle backoff. The gate may skip a session ONLY on an earned, exact
# fingerprint match with state a previously COMPLETED session recorded; every
# failure path (gh error, page cap, git error, pending override, bad names)
# refuses the skip so the session runs (pre-#318 behaviour -- costs tokens,
# never correctness).
# shellcheck disable=SC2034  # vars consumed inside the sourced supervisor.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }
heartbeat() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Minimal target repo pack (real files -- their bytes are fingerprint material).
AUTONOMY_TARGET_REPO="$tmp/repo"
mkdir -p "$AUTONOMY_TARGET_REPO/.autonomy/roles"
printf 'do the work\n' > "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
printf 'hard rules\n' > "$AUTONOMY_TARGET_REPO/.autonomy/hard_rules.md"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
  qa:
    enabled: true
    trigger: { type: loop }
    prompt: .autonomy/roles/qa.md
YAML

LOGDIR="$tmp/logs"; mkdir -p "$LOGDIR"
VARDIR="$tmp/var";  mkdir -p "$VARDIR"
AUTONOMY_LANE=""
AGENT_TYPE_OVERRIDE=""; MODEL_OVERRIDE=""; FALLBACK_MODEL_OVERRIDE=""; EFFORT_OVERRIDE=""

# --- gh / git stubs (the established shell-function seam) --------------------
GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T09:00:00Z"
GH_ISSUES_RC=0
GH_PRS_OUT="7 abc123 2026-07-08T08:00:00Z"
GH_PRS_RC=0
gh() {
  case "$1 $2" in
    "issue list") printf '%s\n' "$GH_ISSUES_OUT"; return "$GH_ISSUES_RC" ;;
    "pr list")    printf '%s\n' "$GH_PRS_OUT";    return "$GH_PRS_RC" ;;
    *) return 1 ;;
  esac
}
GIT_LSREMOTE_OUT="ref: refs/heads/main	HEAD
deadbeef	HEAD"
GIT_LSREMOTE_RC=0
git() {
  if [ "$1" = "ls-remote" ]; then
    [ -n "$GIT_LSREMOTE_OUT" ] && printf '%s\n' "$GIT_LSREMOTE_OUT"
    return "$GIT_LSREMOTE_RC"
  fi
  command git "$@"
}

# --- role_fingerprint: determinism + sensitivity ------------------------------
fp1="$(role_fingerprint coder)"; rc1=$?
fp2="$(role_fingerprint coder)"
check "fingerprint computes (rc 0)" "0" "$rc1"
check "fingerprint is non-empty" "1" "$([ -n "$fp1" ] && echo 1 || echo 0)"
check "fingerprint is deterministic" "$fp1" "$fp2"

GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T11:11:11Z"
fp_changed="$(role_fingerprint coder)"
check "issue updatedAt change changes the hash" "1" "$([ "$fp_changed" != "$fp1" ] && echo 1 || echo 0)"
GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T09:00:00Z"

GH_PRS_OUT="7 fff999 2026-07-08T08:00:00Z"
fp_pr="$(role_fingerprint coder)"
check "PR head change changes the hash" "1" "$([ "$fp_pr" != "$fp1" ] && echo 1 || echo 0)"
GH_PRS_OUT="7 abc123 2026-07-08T08:00:00Z"

GIT_LSREMOTE_OUT="ref: refs/heads/main	HEAD
cafef00d	HEAD"
fp_main="$(role_fingerprint coder)"
check "remote default-branch head change changes the hash" "1" "$([ "$fp_main" != "$fp1" ] && echo 1 || echo 0)"
GIT_LSREMOTE_OUT="ref: refs/heads/main	HEAD
deadbeef	HEAD"

printf 'do the work HARDER\n' > "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"
fp_prompt="$(role_fingerprint coder)"
check "loop_prompt edit changes the hash" "1" "$([ "$fp_prompt" != "$fp1" ] && echo 1 || echo 0)"
printf 'do the work\n' > "$AUTONOMY_TARGET_REPO/.autonomy/loop_prompt.md"

printf 'be careful\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"
fp_rolefile="$(role_fingerprint coder)"
check "role rail edit changes the hash" "1" "$([ "$fp_rolefile" != "$fp1" ] && echo 1 || echo 0)"
printf 'qa prompt\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/qa.md"

# CP2: pack material is EVERY file under .autonomy, not just *.md/config.yaml.
printf 'notes\n' > "$AUTONOMY_TARGET_REPO/.autonomy/roles/notes.txt"
fp_txt="$(role_fingerprint coder)"
check "non-md pack file changes the hash" "1" "$([ "$fp_txt" != "$fp1" ] && echo 1 || echo 0)"
rm -f "$AUTONOMY_TARGET_REPO/.autonomy/roles/notes.txt"

printf 'model=claude-opus-4-8\n' > "$LOGDIR/config-overrides"
fp_overlay="$(role_fingerprint coder)"
check "config-overrides overlay changes the hash" "1" "$([ "$fp_overlay" != "$fp1" ] && echo 1 || echo 0)"
rm -f "$LOGDIR/config-overrides"

MODEL_OVERRIDE="claude-opus-4-8"
fp_cli="$(role_fingerprint coder)"
check "CLI --model override changes the hash" "1" "$([ "$fp_cli" != "$fp1" ] && echo 1 || echo 0)"
MODEL_OVERRIDE=""

fp_role="$(role_fingerprint qa)"
check "different role different hash" "1" "$([ "$fp_role" != "$fp1" ] && echo 1 || echo 0)"

# CP2: a role prompt OUTSIDE .autonomy (any extension) still busts the hash --
# config edits aside, editing only the prompt file's CONTENT must change it.
mkdir -p "$AUTONOMY_TARGET_REPO/prompts"
printf 'external qa prompt v1\n' > "$AUTONOMY_TARGET_REPO/prompts/qa.txt"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
  qa:
    enabled: true
    trigger: { type: loop }
    prompt: prompts/qa.txt
YAML
fp_ext1="$(role_fingerprint qa)"; ext_rc=$?
check "outside-pack prompt fingerprints (rc 0)" "0" "$ext_rc"
printf 'external qa prompt v2\n' > "$AUTONOMY_TARGET_REPO/prompts/qa.txt"
fp_ext2="$(role_fingerprint qa)"
check "outside-pack prompt content change changes the hash" "1" "$([ "$fp_ext2" != "$fp_ext1" ] && echo 1 || echo 0)"

# CP2 round 2: the resolved prompt file is a REQUIRED input -- deleting it
# must refuse (never hash "absent" the same as "empty", never skip past the
# dispatch refusal that a missing prompt deserves).
rm -f "$AUTONOMY_TARGET_REPO/prompts/qa.txt"
role_fingerprint qa >/dev/null 2>&1
check "missing resolved prompt file refuses" "1" "$?"
printf 'external qa prompt v2\n' > "$AUTONOMY_TARGET_REPO/prompts/qa.txt"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
  qa:
    enabled: true
    trigger: { type: loop }
    prompt: .autonomy/roles/qa.md
YAML
rm -rf "$AUTONOMY_TARGET_REPO/prompts"

AUTONOMY_LANE="fast"
fp_lane="$(role_fingerprint coder)"
check "lane changes the hash" "1" "$([ "$fp_lane" != "$fp1" ] && echo 1 || echo 0)"
AUTONOMY_LANE=""

fp_back="$(role_fingerprint coder)"
check "hash returns to baseline after reverts" "$fp1" "$fp_back"

# --- role_fingerprint: every failure path REFUSES (rc 1, no output) ----------
GH_ISSUES_RC=1
out="$(role_fingerprint coder)"; rc=$?
check "gh issue failure refuses" "1" "$rc"
check "gh issue failure prints nothing" "" "$out"
GH_ISSUES_RC=0

GH_PRS_RC=1
role_fingerprint coder >/dev/null 2>&1
check "gh pr failure refuses" "1" "$?"
GH_PRS_RC=0

GIT_LSREMOTE_RC=1
role_fingerprint coder >/dev/null 2>&1
check "git ls-remote failure refuses" "1" "$?"
GIT_LSREMOTE_RC=0

# Review-bot finding: ls-remote of a missing ref exits 0 with EMPTY output --
# an empty default-branch observation must refuse, never hash as a constant.
GIT_LSREMOTE_OUT=""
role_fingerprint coder >/dev/null 2>&1
check "empty ls-remote output refuses" "1" "$?"
GIT_LSREMOTE_OUT="ref: refs/heads/main	HEAD
deadbeef	HEAD"

# Page-cap: exactly the limit means "maybe truncated" -> unfingerprintable.
GH_ISSUES_OUT="$(i=1; while [ $i -le 200 ]; do echo "$i 2026-07-08T00:00:00Z"; i=$((i+1)); done)"
role_fingerprint coder >/dev/null 2>&1
check "issue page cap (200) refuses" "1" "$?"
GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T09:00:00Z"

GH_PRS_OUT="$(i=1; while [ $i -le 100 ]; do echo "$i sha$i 2026-07-08T00:00:00Z"; i=$((i+1)); done)"
role_fingerprint coder >/dev/null 2>&1
check "pr page cap (100) refuses" "1" "$?"
GH_PRS_OUT="7 abc123 2026-07-08T08:00:00Z"

touch "$LOGDIR/model-override"
role_fingerprint coder >/dev/null 2>&1
check "pending one-shot model-override refuses (session must run)" "1" "$?"
rm -f "$LOGDIR/model-override"

# CP2: a pack-less repo is unfingerprintable, never hashed as "empty".
mv "$AUTONOMY_TARGET_REPO/.autonomy" "$AUTONOMY_TARGET_REPO/.autonomy-parked"
role_fingerprint coder >/dev/null 2>&1
check "missing .autonomy pack refuses" "1" "$?"
mv "$AUTONOMY_TARGET_REPO/.autonomy-parked" "$AUTONOMY_TARGET_REPO/.autonomy"

# CP2: an unresolvable role (roles.py dispatch failure) refuses.
role_fingerprint ghost >/dev/null 2>&1
check "unknown role refuses (dispatch contract unresolvable)" "1" "$?"

role_fingerprint "bad/role" >/dev/null 2>&1
check "path-unsafe role name refuses" "1" "$?"
AUTONOMY_LANE="bad lane"
role_fingerprint coder >/dev/null 2>&1
check "path-unsafe lane refuses" "1" "$?"
AUTONOMY_LANE=""

# --- fingerprint_state_file: the ONLY path constructor -----------------------
check "state path (no lane)" "$LOGDIR/.fingerprint-coder" "$(fingerprint_state_file coder "")"
check "state path (lane)" "$LOGDIR/.fingerprint-coder--fast" "$(fingerprint_state_file coder fast)"
fingerprint_state_file "bad/role" "" >/dev/null 2>&1
check "state path refuses bad role" "1" "$?"
fingerprint_state_file coder "bad lane" >/dev/null 2>&1
check "state path refuses bad lane" "1" "$?"

# --- record_fingerprint / fingerprint_gate ------------------------------------
fingerprint_gate coder
check "gate refuses skip with no recorded state" "1" "$?"
check "gate leaves FP_CURRENT set for the post-session record" "$fp1" "$FP_CURRENT"

record_fingerprint coder "" "$fp1"
check "record writes the state file" "$fp1" "$(cat "$LOGDIR/.fingerprint-coder")"

fingerprint_gate coder
check "gate approves skip on exact recorded match" "0" "$?"

GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T12:00:00Z"
fingerprint_gate coder
check "gate refuses skip when the board moved" "1" "$?"
GH_ISSUES_OUT="12 2026-07-08T10:00:00Z
14 2026-07-08T09:00:00Z"

GH_ISSUES_RC=1
fingerprint_gate coder; rc=$?
check "gate refuses skip when fingerprint uncomputable" "1" "$rc"
check "uncomputable fingerprint clears FP_CURRENT (nothing to record)" "" "$FP_CURRENT"
GH_ISSUES_RC=0

# Cross-role isolation: coder's recorded state must not gate qa.
fingerprint_gate qa
check "recorded coder state never skips qa" "1" "$?"

# --- fingerprint_backoff ------------------------------------------------------
check "backoff step 1" "120"  "$(fingerprint_backoff 1)"
check "backoff step 2" "300"  "$(fingerprint_backoff 2)"
check "backoff step 3" "900"  "$(fingerprint_backoff 3)"
check "backoff step 4" "1800" "$(fingerprint_backoff 4)"
check "backoff caps at 1800" "1800" "$(fingerprint_backoff 9)"

# --- has_scheduled_triggers (real triggers.py against the real config;
#     Phase C renamed has_scheduled_roles onto the trigger enumeration) ------
has_scheduled_triggers
check "loop-only config has no scheduled roles" "1" "$?"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
  researcher:
    enabled: true
    trigger: { type: cron, schedule: "0 9 * * *" }
    prompt: .autonomy/roles/qa.md
YAML
has_scheduled_triggers
check "cron role config has scheduled roles" "0" "$?"
cat > "$AUTONOMY_TARGET_REPO/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML

# --- idle_sleep: pause-aware slices (stubbed sleep -- deterministic) ----------
PAUSE_POLL=30
PAUSE_SENTINEL="$tmp/PAUSE"
slept=0
sleep() { slept=$((slept + $1)); }
idle_sleep 90
check "idle_sleep sleeps the full window in slices" "90" "$slept"
slept=0
idle_sleep 45
check "idle_sleep handles a non-multiple window" "45" "$slept"
touch "$PAUSE_SENTINEL"
slept=0
idle_sleep 900
check "pause sentinel stops the idle immediately" "0" "$slept"
rm -f "$PAUSE_SENTINEL"
unset -f sleep

# --- sole-writer + wiring invariants (grep belt, reset-epoch style) ----------
calls="$(grep -c '^ *record_fingerprint ' "$ENGINE_HOME/bin/supervisor.sh")"
check "record_fingerprint has exactly one call site (the outcome-0 arm)" "1" "$calls"
wired="$(grep -c '^ *if fingerprint_gate ' "$ENGINE_HOME/bin/supervisor.sh")"
check "fingerprint_gate is wired into the loop exactly once" "1" "$wired"


# --- workstreams slice 1: the var-live config shadow joins the material ------
# fresh baseline: earlier cases leave the config in a different (valid) state
fp_base="$(role_fingerprint coder)"
mkdir -p "$AUTONOMY_TARGET_REPO/var/autonomy"
printf 'agent:\n  model:\n    primary: live-model\n' > "$AUTONOMY_TARGET_REPO/var/autonomy/config.yaml"
fp_live="$(role_fingerprint coder)"
check "var-live shadow appearing changes the hash" "1" "$([ "$fp_live" != "$fp_base" ] && echo 1 || echo 0)"
printf 'agent:\n  model:\n    primary: live-model-2\n' > "$AUTONOMY_TARGET_REPO/var/autonomy/config.yaml"
fp_live2="$(role_fingerprint coder)"
check "var-live edit changes the hash" "1" "$([ "$fp_live2" != "$fp_live" ] && echo 1 || echo 0)"
rm -rf "$AUTONOMY_TARGET_REPO/var/autonomy"
fp_live_gone="$(role_fingerprint coder)"
check "hash returns to baseline when the shadow is removed" "$fp_base" "$fp_live_gone"
echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILURES"; exit 1; fi
