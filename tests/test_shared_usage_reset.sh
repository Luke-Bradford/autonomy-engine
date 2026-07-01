#!/usr/bin/env bash
# tests/test_shared_usage_reset.sh -- account-level shared usage-limit state
# (issue #3). One Anthropic account serves N parallel supervisors: a reset
# epoch discovered by any one of them must be visible to all, so they back
# off together instead of each rediscovering the same wall. The supervisor
# stays the SOLE writer (reset-epoch split invariant); the shared marker is
# best-effort and every read is validated per-file (fail-safe).
# shellcheck disable=SC2034  # CFG / AUTONOMY_SHARED_STATE_DIR / RESET_STATE /
#                            # SHARED_RESET_STATE are consumed by the sourced
#                            # supervisor.sh functions, not read in this file
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/supervisor.sh"
# shellcheck disable=SC2034  # consumed by log() in the sourced supervisor.sh
SUPLOG=/dev/null
warns=0
log() { case "$1" in WARN*) warns=$((warns + 1)) ;; esac; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}
between() {
  if [ -n "$4" ] && [ "$4" -ge "$2" ] && [ "$4" -le "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (want [$2,$3], got '$4')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
now="$(date +%s)"

# --- resolve_account_key: config value, sanitized, 'default' fallback --------
mkdir -p "$tmp/repoA/.autonomy" "$tmp/repoB/.autonomy"
cat > "$tmp/repoA/.autonomy/config.yaml" <<'YAML'
engine:
  account_key: work-account
YAML
cat > "$tmp/repoB/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
CFG="$tmp/repoA/.autonomy/config.yaml"
check "account_key read from config" "work-account" "$(resolve_account_key)"
CFG="$tmp/repoB/.autonomy/config.yaml"
check "absent account_key -> default" "default" "$(resolve_account_key)"
cat > "$tmp/repoA/.autonomy/config.yaml" <<'YAML'
engine:
  account_key: "../escape/attempt"
YAML
CFG="$tmp/repoA/.autonomy/config.yaml"
check "path-hostile account_key -> default" "default" "$(resolve_account_key)"

# --- resolve_shared_reset_state: env override > HOME default > '' ------------
AUTONOMY_SHARED_STATE_DIR="$tmp/shared"
check "env override wins" "$tmp/shared/usage-reset.k1" "$(resolve_shared_reset_state k1)"
AUTONOMY_SHARED_STATE_DIR=""
HOME="$tmp/home"
check "HOME default" "$tmp/home/.config/autonomy/usage-reset.k1" "$(resolve_shared_reset_state k1)"
HOME=""
check "no env, no HOME -> empty (repo-local only)" "" "$(resolve_shared_reset_state k1)"
HOME="$tmp/home"

# --- persist_reset_epoch writes both files ------------------------------------
RESET_STATE="$tmp/repoA/.last_usage_reset"
SHARED_RESET_STATE="$tmp/shared/usage-reset.default"
epoch=$((now + 3600))
persist_reset_epoch "$epoch"
check "persist exits 0" "0" "$?"
check "repo-local file written" "$epoch" "$(cat "$RESET_STATE" 2>/dev/null)"
check "shared file written (dir auto-created)" "$epoch" "$(cat "$SHARED_RESET_STATE" 2>/dev/null)"

# --- persist with no shared path configured -----------------------------------
rm -f "$RESET_STATE"
SHARED_RESET_STATE=""
persist_reset_epoch "$epoch"
check "repo-local still written without shared path" "$epoch" "$(cat "$RESET_STATE" 2>/dev/null)"

# --- persist is best-effort when the shared dir is uncreatable ----------------
: > "$tmp/blocked"                       # a FILE where the dir must go
SHARED_RESET_STATE="$tmp/blocked/usage-reset.default"
warns=0
persist_reset_epoch "$epoch"
rc=$?
check "uncreatable shared dir: still exits 0" "0" "$rc"
check "uncreatable shared dir: warns" "1" "$warns"
check "uncreatable shared dir: repo-local intact" "$epoch" "$(cat "$RESET_STATE" 2>/dev/null)"

# --- compute_limit_wait: repo-local only (back-compat) -------------------------
SHARED_RESET_STATE="$tmp/shared/usage-reset.default"
rm -f "$SHARED_RESET_STATE" "$RESET_STATE"
printf '%s\n' "$((now + 600))" > "$RESET_STATE"
between "repo-local only honored" 540 600 "$(compute_limit_wait)"

# --- shared only: another supervisor's discovery is honored --------------------
rm -f "$RESET_STATE"
printf '%s\n' "$((now + 1200))" > "$SHARED_RESET_STATE"
between "shared only honored" 1140 1200 "$(compute_limit_wait)"

# --- both present: the LATER epoch wins (most conservative) --------------------
printf '%s\n' "$((now + 600))" > "$RESET_STATE"
printf '%s\n' "$((now + 1800))" > "$SHARED_RESET_STATE"
between "max wins (shared later)" 1740 1800 "$(compute_limit_wait)"
printf '%s\n' "$((now + 2400))" > "$RESET_STATE"
between "max wins (repo later)" 2340 2400 "$(compute_limit_wait)"

# --- per-file validation: garbage in one never poisons the other ---------------
printf 'garbage\n' > "$SHARED_RESET_STATE"
printf '%s\n' "$((now + 600))" > "$RESET_STATE"
between "garbage shared ignored, repo honored" 540 600 "$(compute_limit_wait)"
printf 'garbage\n' > "$RESET_STATE"
printf '%s\n' "$((now + 600))" > "$SHARED_RESET_STATE"
between "garbage repo ignored, shared honored" 540 600 "$(compute_limit_wait)"

# --- horizon + staleness still enforced per file --------------------------------
printf '%s\n' "$((now + LIMIT_RESET_MAX_HORIZON + 3600))" > "$SHARED_RESET_STATE"
rm -f "$RESET_STATE"
compute_limit_wait >/dev/null 2>&1
check "beyond-horizon shared rejected" "1" "$?"
printf '%s\n' "$((now - 60))" > "$SHARED_RESET_STATE"
compute_limit_wait >/dev/null 2>&1
check "past shared rejected" "1" "$?"
rm -f "$SHARED_RESET_STATE"
compute_limit_wait >/dev/null 2>&1
check "both absent -> no wait" "1" "$?"

# --- cross-supervisor scenario: A discovers, B (no local state) backs off ------
RESET_STATE="$tmp/repoA/.last_usage_reset"
persist_reset_epoch "$((now + 900))"
RESET_STATE="$tmp/repoB/.last_usage_reset"     # supervisor B: nothing local
between "repo B sees repo A's wall via the shared marker" 840 900 "$(compute_limit_wait)"

# --- clean session clears both -------------------------------------------------
RESET_STATE="$tmp/repoA/.last_usage_reset"
persist_reset_epoch "$((now + 900))"
clear_reset_state
check "clear: repo-local gone" "0" "$([ ! -e "$RESET_STATE" ] && echo 0 || echo 1)"
check "clear: shared gone" "0" "$([ ! -e "$SHARED_RESET_STATE" ] && echo 0 || echo 1)"
compute_limit_wait >/dev/null 2>&1
check "clear: no wait remains" "1" "$?"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
