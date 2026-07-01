#!/usr/bin/env bash
# tests/test_quickstart.sh -- guided single-entry onboarding (issue #38).
# quickstart.sh chains onboard -> guided config -> doctor -> optional
# worktree -> optional dashboard registration -> printed next steps.
# Everything runs inside a sandbox HOME; launchctl and gh are PATH-shimmed
# (launchctl to prove it is NEVER invoked, gh to keep doctor offline).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_HOME="$(cd "$HERE/.." && pwd)"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"   # physical path: keeps computed-vs-expected paths comparable on macOS /var symlink
trap 'rm -rf "$tmp"' EXIT

# Sandbox HOME: plist + ~/.config/autonomy/repos writes stay in the sandbox.
export HOME="$tmp/home"
mkdir -p "$HOME/Library/LaunchAgents"

# PATH shims. launchctl records every invocation (the test asserts NONE
# happen -- going live is a deliberate operator step). gh fails fast so
# doctor's network checks degrade to WARNs deterministically.
shim="$tmp/shim"
mkdir -p "$shim"
export SHIM_LOG="$tmp/launchctl.log"
cat > "$shim/launchctl" <<'SH'
#!/bin/sh
echo "launchctl $*" >> "$SHIM_LOG"
exit 0
SH
cat > "$shim/gh" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$shim/launchctl" "$shim/gh"
export PATH="$shim:$PATH"

cfg_get() { python3 "$ENGINE_HOME/lib/config_parser.py" "$1/.autonomy/config.yaml" "$2" 2>/dev/null; }

# --- sourcing defines functions only (the repo-wide guard convention) -------
# shellcheck source=/dev/null
source "$ENGINE_HOME/bin/quickstart.sh"
set +e   # quickstart's `set -e` leaks in via source; this test runs failing commands on purpose
check "sourcing defines qs_valid_strategy" "0" "$(type qs_valid_strategy >/dev/null 2>&1 && echo 0 || echo 1)"
check "strategy whitelist: manual ok" "0" "$(qs_valid_strategy manual && echo 0 || echo 1)"
check "strategy whitelist: ci_only ok" "0" "$(qs_valid_strategy ci_only && echo 0 || echo 1)"
check "strategy whitelist: bot_comment ok" "0" "$(qs_valid_strategy bot_comment && echo 0 || echo 1)"
check "strategy whitelist: gh_review ok" "0" "$(qs_valid_strategy gh_review && echo 0 || echo 1)"
check "strategy whitelist: bogus rejected" "1" "$(qs_valid_strategy bogus && echo 0 || echo 1)"

# --- usage -------------------------------------------------------------------
bash "$ENGINE_HOME/bin/quickstart.sh" >/dev/null 2>&1
check "no args -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/nonexistent-dir" >/dev/null 2>&1
check "nonexistent target -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

# --- fresh guided run (piped answers) ----------------------------------------
# Prompt order contract: board.owner, board.project_title, agent.model.primary,
# merge_gate.strategy, then worktree y/N, register y/N.
mkdir -p "$tmp/plain"
printf 'my-org\nMy Fancy Board\n\nci_only\nn\nn\n' \
  | bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain" >"$tmp/out1" 2>"$tmp/err1"
rc=$?
check "guided run exits 0" "0" "$rc"
check "pack scaffolded" "0" "$([ -f "$tmp/plain/.autonomy/config.yaml" ] && echo 0 || echo 1)"
check "board.owner written" "my-org" "$(cfg_get "$tmp/plain" board.owner)"
check "title with spaces round-trips" "My Fancy Board" "$(cfg_get "$tmp/plain" board.project_title)"
check "strategy written" "ci_only" "$(cfg_get "$tmp/plain" merge_gate.strategy)"
check "Enter keeps current model" "claude-sonnet-5" "$(cfg_get "$tmp/plain" agent.model.primary)"
check "template comments preserved through writes" "0" "$(grep -q '# claude | codex' "$tmp/plain/.autonomy/config.yaml" && echo 0 || echo 1)"
check "next steps include launchctl bootstrap line" "0" "$(grep -q 'launchctl bootstrap' "$tmp/out1" && echo 0 || echo 1)"
check "next steps include dashboard run line" "0" "$(grep -q 'dashboard.py' "$tmp/out1" && echo 0 || echo 1)"
check "launchctl never invoked" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"
check "repos file not created when register declined" "0" "$([ ! -e "$HOME/.config/autonomy/repos" ] && echo 0 || echo 1)"
check "no worktree created when declined" "0" "$([ ! -d "$tmp/.plain-autonomy" ] && echo 0 || echo 1)"

# --- idempotency: EOF on every prompt keeps the file byte-identical ----------
cp "$tmp/plain/.autonomy/config.yaml" "$tmp/config.before"
bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain" </dev/null >/dev/null 2>&1
rc=$?
check "re-run with EOF answers exits 0" "0" "$rc"
check "re-run with EOF answers is byte-identical" "0" "$(cmp -s "$tmp/config.before" "$tmp/plain/.autonomy/config.yaml" && echo 0 || echo 1)"

# --- invalid interactive input: warn + re-prompt ------------------------------
printf 'bogus\ngh_review\nn\nn\n' \
  | bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain" \
      --board-owner o2 --board-title t2 --model claude-sonnet-5 >"$tmp/out2" 2>"$tmp/err2"
rc=$?
check "invalid-then-valid strategy exits 0" "0" "$rc"
check "invalid strategy re-prompted, valid answer written" "gh_review" "$(cfg_get "$tmp/plain" merge_gate.strategy)"
check "invalid strategy mentioned on stderr" "0" "$(grep -qi 'invalid' "$tmp/err2" && echo 0 || echo 1)"

printf 'bad;model\n\n' \
  | bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain" \
      --board-owner o2 --board-title t2 --merge-gate manual --worktree no --register no \
      >"$tmp/out3" 2>"$tmp/err3"
rc=$?
check "invalid model then EOF exits 0" "0" "$rc"
check "invalid model id rejected, current kept" "claude-sonnet-5" "$(cfg_get "$tmp/plain" agent.model.primary)"
check "invalid model mentioned on stderr" "0" "$(grep -qi 'invalid' "$tmp/err3" && echo 0 || echo 1)"

# --- answer on the last line without a trailing newline is still an answer ----
# (`read` exits non-zero at EOF but fills the variable with the partial line)
printf 'trailing-org' \
  | bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain" \
      --board-title t2 --model claude-sonnet-5 --merge-gate manual \
      --worktree no --register no >/dev/null 2>&1
check "answer without trailing newline still written" "trailing-org" "$(cfg_get "$tmp/plain" board.owner)"

# --- fully flagged, non-interactive -------------------------------------------
mkdir -p "$tmp/plain2"
bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain2" \
  --board-owner org3 --board-title "Board Three" --model claude-opus-4-8 \
  --merge-gate bot_comment --worktree no --register no </dev/null >"$tmp/out4" 2>&1
rc=$?
check "flagged run exits 0" "0" "$rc"
check "flagged owner written" "org3" "$(cfg_get "$tmp/plain2" board.owner)"
check "flagged title written" "Board Three" "$(cfg_get "$tmp/plain2" board.project_title)"
check "flagged model written" "claude-opus-4-8" "$(cfg_get "$tmp/plain2" agent.model.primary)"
check "flagged strategy written" "bot_comment" "$(cfg_get "$tmp/plain2" merge_gate.strategy)"

bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain2" --merge-gate bogus </dev/null >/dev/null 2>&1
check "invalid --merge-gate flag -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/plain2" --model 'bad;model' </dev/null >/dev/null 2>&1
check "invalid --model flag -> non-zero exit" "1" "$([ $? -ne 0 ] && echo 1 || echo 0)"

# --- worktree + dashboard registration (real git fixture) ---------------------
git init -q --bare "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/target" 2>/dev/null
(cd "$tmp/target" \
  && git checkout -qb main \
  && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
  && git push -q -u origin main 2>/dev/null)

bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/target" \
  --board-owner org --board-title "T Board" --model claude-sonnet-5 \
  --merge-gate manual --worktree yes --register yes </dev/null >"$tmp/out5" 2>"$tmp/err5"
rc=$?
check "worktree run exits 0" "0" "$rc"
check "worktree created at the config default path" "0" "$([ -d "$tmp/.target-autonomy" ] && echo 0 || echo 1)"
check "plist installed under HOME" "0" "$([ -f "$HOME/Library/LaunchAgents/com.autonomy.target.supervisor.plist" ] && echo 0 || echo 1)"
check "launchctl STILL never invoked" "0" "$([ ! -e "$SHIM_LOG" ] && echo 0 || echo 1)"
check "worktree path registered for the dashboard" "1" "$(grep -cxF "$tmp/.target-autonomy" "$HOME/.config/autonomy/repos" 2>/dev/null)"
check "bootstrap next-step names the label" "0" "$(grep -q 'com.autonomy.target.supervisor' "$tmp/out5" && echo 0 || echo 1)"

bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/target" \
  --worktree yes --register yes </dev/null >/dev/null 2>&1
rc=$?
check "worktree+register re-run exits 0 (idempotent)" "0" "$rc"
check "registration not duplicated" "1" "$(grep -cxF "$tmp/.target-autonomy" "$HOME/.config/autonomy/repos" 2>/dev/null)"

# --- worktree requested but impossible: warn, keep going, exit non-zero -------
mkdir -p "$tmp/notgit"
bash "$ENGINE_HOME/bin/quickstart.sh" "$tmp/notgit" \
  --board-owner o --board-title t --model claude-sonnet-5 --merge-gate manual \
  --worktree yes --register no </dev/null >"$tmp/out6" 2>&1
rc=$?
check "worktree failure -> non-zero exit" "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)"
check "next steps still printed after worktree failure" "0" "$(grep -q 'dashboard.py' "$tmp/out6" && echo 0 || echo 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
