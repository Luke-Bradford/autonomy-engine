#!/usr/bin/env bash
# Unit test for doctor.sh's fast, local-only preflight check.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/doctor.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check "missing .autonomy/ -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

mkdir -p "$tmp/.autonomy"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
YAML
check "valid config, requires_claude_md false -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: true
YAML
check "requires_claude_md true, no CLAUDE.md -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
# The FAIL message must point at the scaffold, not dead-end (#152). Capture the
# message first (the function returns 1, which pipefail would otherwise let
# poison a `... | grep` pipeline), then grep the captured text.
claude_fail_msg="$(doctor_preflight_check "$tmp" 2>&1 >/dev/null || true)"
check "requires_claude_md FAIL points at the --claude-md scaffold" "0" \
  "$(printf '%s' "$claude_fail_msg" | grep -q -- '--claude-md' && echo 0 || echo 1)"

mkdir -p "$tmp/.claude"
touch "$tmp/.claude/CLAUDE.md"
check "requires_claude_md true, CLAUDE.md present -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

# Claude Code loads CLAUDE.md from the repo ROOT as well as .claude/ -- doctor
# must accept either location, else a root-CLAUDE.md repo (like autonomy-engine
# itself) fails readiness despite the file being loaded at runtime.
rm -f "$tmp/.claude/CLAUDE.md"
check "requires_claude_md true, neither location -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
touch "$tmp/CLAUDE.md"
check "requires_claude_md true, root CLAUDE.md present -> pass" "0" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"
rm -f "$tmp/CLAUDE.md"
touch "$tmp/.claude/CLAUDE.md"  # restore for subsequent checks

echo "this line has no colon whatsoever" > "$tmp/.autonomy/config.yaml"
check "malformed config.yaml -> hard fail" "1" "$(doctor_preflight_check "$tmp" >/dev/null 2>&1; echo $?)"

# --- roles: block validation via lib/roles.py (#12) ---
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    enabled: true
    substrate: engine
    trigger: { type: loop }
YAML
check "valid roles block -> roles.py passes" "0" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  qa:
    substrate: kubernetes
    trigger: { type: webhook }
YAML
check "invalid roles block -> roles.py fails" "1" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
YAML
check "no roles block -> rc 3 (valid, defaults apply)" "3" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  pm:
    prompt: .autonomy/roles/pm.md
YAML
check "missing prompt file -> roles.py fails" "1" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"
mkdir -p "$tmp/.autonomy/roles"; touch "$tmp/.autonomy/roles/pm.md"
check "prompt file present -> roles.py passes" "0" "$(python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

# --- roles.account -> accounts registry (agent-org increment 2) ---
fake_home="$tmp/fakehome"
mkdir -p "$fake_home/.config/autonomy"
printf '{"accounts": {"claude-sub": {"kind": "claude_subscription"}}}\n' \
  > "$fake_home/.config/autonomy/accounts"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: claude-sub
    trigger: { type: loop }
YAML
check "role account present in registry -> roles.py passes" "0" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
engine:
  requires_claude_md: false
roles:
  coder:
    account: no-such-account
    trigger: { type: loop }
YAML
check "role account missing from registry -> roles.py fails" "1" \
  "$(HOME="$fake_home" python3 "$HERE/../lib/roles.py" "$tmp" >/dev/null 2>&1; echo $?)"

# --- QA role readiness check (#13) ---
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: true
    substrate: actions
    trigger:
      type: event
      on: [pr.opened]
YAML
case "$(doctor_qa_role_check "$tmp")" in
  WARN*qa-gate*) r=warn ;;
  *) r=other ;;
esac
check "qa enabled (actions), no workflow -> WARN" warn "$r"

mkdir -p "$tmp/.github/workflows"
printf 'name: QA merge gate\n# context: qa-gate\n' > "$tmp/.github/workflows/qa-merge-gate.yml"
case "$(doctor_qa_role_check "$tmp")" in
  OK*) r=ok ;;
  *) r=other ;;
esac
check "qa enabled (actions), workflow present -> OK" ok "$r"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: false
YAML
check "qa disabled -> no line" "" "$(doctor_qa_role_check "$tmp")"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  qa:
    enabled: true
    substrate: routine
YAML
case "$(doctor_qa_role_check "$tmp")" in
  WARN*routine*) r=warn ;;
  *) r=other ;;
esac
check "qa on routine substrate -> WARN (unverifiable locally)" warn "$r"

# --- fail-safe honesty: doctor surfaces set-but-unwired role knobs (#149) ------
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    self_test: true
YAML
knob_out="$(doctor_knob_notes "$tmp" 2>&1)"
check "doctor surfaces a set-but-unwired knob (#149)" "0" \
  "$(printf '%s' "$knob_out" | grep -q 'roles.coder.self_test is set but' && echo 0 || echo 1)"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
check "doctor knob-notes stays silent when nothing to say" "" "$(doctor_knob_notes "$tmp" 2>&1)"

# --- lanes: doctor reports declared lanes + non-executable-yet warning (#147) --
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
lanes:
  main: {}
  frontend: {}
roles:
  coder:
    enabled: true
  coder-fe:
    enabled: true
    trigger: { type: loop }
    lane: frontend
YAML
lane_out="$(doctor_lane_report "$tmp" 2>&1)"
check "doctor reports the declared default lane (#147)" "0" \
  "$(printf '%s' "$lane_out" | grep -q 'OK   lanes: 2 declared (default: main)' && echo 0 || echo 1)"
check "doctor WARNs a non-default lane is not executable yet (#147)" "0" \
  "$(printf '%s' "$lane_out" | grep -q "WARN lane 'frontend'.*Part 2" && echo 0 || echo 1)"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
check "doctor lane-report silent with no lanes: block (#147)" "" "$(doctor_lane_report "$tmp" 2>&1)"

# ---- #172: gh token-scope + review-bot-secret checks ----
# grep the captured text via here-string (no `producer | grep -q` pipe, which
# under pipefail can return SIGPIPE(141) on a successful early-exit match --
# prevention-log #7).
has() { grep -q -- "$2" <<<"$1"; }

# doctor_gh_scopes -- extract + merge the Token scopes tokens (pure).
single_status="github.com
  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'"
scopes="$(doctor_gh_scopes "$single_status")"
check "gh_scopes finds repo"    "0" "$(has "$scopes" 'repo' && echo 0 || echo 1)"
check "gh_scopes finds project" "0" "$(has "$scopes" 'project' && echo 0 || echo 1)"
check "gh_scopes finds workflow" "0" "$(has "$scopes" 'workflow' && echo 0 || echo 1)"

multi_status="github.com
  - Token scopes: 'read:org', 'repo'
otherhost.example
  - Token scopes: 'project', 'workflow'"
mscopes="$(doctor_gh_scopes "$multi_status")"
check "gh_scopes merges multi-host union (repo)"    "0" "$(has "$mscopes" 'repo' && echo 0 || echo 1)"
check "gh_scopes merges multi-host union (project)" "0" "$(has "$mscopes" 'project' && echo 0 || echo 1)"
# regression: the union must be ONE line so the report's space-anchored match
# sees a scope that lived on a later host line (else a false 'missing' WARN).
check "gh_scopes collapses to a single line (no embedded newline)" "0" \
  "$(printf '%s' "$mscopes" | wc -l | tr -d ' ')"
rep_multi="$(doctor_gh_scopes_report "$mscopes")"
check "multi-host union -> no false WARN (repo+project across hosts)" "1" \
  "$(has "$rep_multi" 'WARN' && echo 0 || echo 1)"
check "gh_scopes empty when no scopes line" "" "$(doctor_gh_scopes 'github.com
  - Logged in')"

# doctor_gh_scopes_report -- tiered severity (pure).
rep_all="$(doctor_gh_scopes_report 'gist project read:org repo workflow')"
check "all scopes -> an OK line"      "0" "$(has "$rep_all" '^OK' && echo 0 || echo 1)"
check "all scopes -> no WARN"         "1" "$(has "$rep_all" 'WARN' && echo 0 || echo 1)"
rep_no_repo="$(doctor_gh_scopes_report 'project workflow')"
check "missing repo -> WARN"          "0" "$(has "$rep_no_repo" 'WARN' && echo 0 || echo 1)"
check "missing repo -> refresh -s repo hint" "0" "$(has "$rep_no_repo" 'refresh -s repo' && echo 0 || echo 1)"
rep_no_proj="$(doctor_gh_scopes_report 'repo workflow')"
check "missing project -> WARN"       "0" "$(has "$rep_no_proj" 'WARN' && echo 0 || echo 1)"
check "missing project -> refresh -s project hint" "0" "$(has "$rep_no_proj" 'refresh -s project' && echo 0 || echo 1)"
rep_no_wf="$(doctor_gh_scopes_report 'repo project')"
check "missing workflow -> INFO not WARN" "0" "$(has "$rep_no_wf" '^INFO' && ! has "$rep_no_wf" 'WARN' && echo 0 || echo 1)"
rep_empty="$(doctor_gh_scopes_report '')"
check "empty scopes -> a WARN (never silent pass)" "0" "$(has "$rep_empty" 'WARN' && echo 0 || echo 1)"

# doctor_secret_present -- whole-token match (pure).
sec_list="$(printf 'ANTHROPIC_API_KEY\t2026-07-01T16:57:58Z\nOTHER_SECRET\t2026-06-01T00:00:00Z')"
check "secret present"  "0" "$(doctor_secret_present "$sec_list" ANTHROPIC_API_KEY; echo $?)"
check "secret absent"   "1" "$(doctor_secret_present "$sec_list" MISSING_KEY; echo $?)"
check "secret substring does NOT false-match" "1" \
  "$(doctor_secret_present 'ANTHROPIC_API_KEY_OLD	x' ANTHROPIC_API_KEY; echo $?)"

# ---- impure wrappers with a gh PATH stub (subshells inherit the function) ----
gh() {
  case "$1 $2" in
    "auth status") [ -n "${STUB_AUTH_OUT:-}" ] && printf '%s\n' "$STUB_AUTH_OUT"; return "${STUB_AUTH_RC:-0}" ;;
    "secret list") [ -n "${STUB_SECRET_OUT:-}" ] && printf '%s\n' "$STUB_SECRET_OUT"; return "${STUB_SECRET_RC:-0}" ;;
    *) return 0 ;;
  esac
}

STUB_AUTH_RC=0
STUB_AUTH_OUT="github.com
  - Token scopes: 'project', 'repo', 'workflow'"
auth_out="$(doctor_gh_auth_check "$tmp")"
check "auth_check authed -> OK line"          "0" "$(has "$auth_out" '^OK' && echo 0 || echo 1)"
check "auth_check authed+full scopes -> no WARN" "1" "$(has "$auth_out" 'WARN' && echo 0 || echo 1)"

STUB_AUTH_RC=1; STUB_AUTH_OUT=""
auth_fail="$(doctor_gh_auth_check "$tmp")"
check "auth_check not-authed -> WARN"          "0" "$(has "$auth_fail" 'WARN' && echo 0 || echo 1)"
check "auth_check not-authed -> no scope report" "1" "$(has "$auth_fail" 'refresh -s' && echo 0 || echo 1)"

# secret check: authed + secret present -> OK
STUB_AUTH_RC=0; STUB_AUTH_OUT="github.com"
STUB_SECRET_RC=0; STUB_SECRET_OUT="ANTHROPIC_API_KEY	2026-07-01T00:00:00Z"
sec_ok="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+present -> OK" "0" "$(has "$sec_ok" '^OK' && echo 0 || echo 1)"
# authed + secret absent -> WARN
STUB_SECRET_OUT="OTHER	x"
sec_warn="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+absent -> WARN" "0" "$(has "$sec_warn" 'WARN' && echo 0 || echo 1)"
# authed + secret list command fails (admin-only) -> INFO hint, not WARN
STUB_SECRET_RC=1; STUB_SECRET_OUT=""
sec_info="$(doctor_review_secret_check "$tmp")"
check "secret_check authed+list-fails -> INFO not WARN" "0" \
  "$(has "$sec_info" '^INFO' && ! has "$sec_info" 'WARN' && echo 0 || echo 1)"
# not authed -> silent (auth WARN already covers it)
STUB_AUTH_RC=1
check "secret_check not-authed -> silent" "" "$(doctor_review_secret_check "$tmp")"
unset -f gh
unset STUB_AUTH_RC STUB_AUTH_OUT STUB_SECRET_RC STUB_SECRET_OUT

# ---- #171: scope-label existence check ----
# doctor_labels_report (pure): exact string equality, no grep -> a '-'-leading or
# space-holding label neither breaks nor false-matches.
lr_missing="$(doctor_labels_report "$(printf 'ready\nbug\n-weird')" "$(printf 'ready\nbug\ngood first issue')")"
check "labels_report: absent label -> WARN naming it" "0" "$(has "$lr_missing" "'-weird'" && echo 0 || echo 1)"
check "labels_report: present label not warned"       "1" "$(has "$lr_missing" "'ready'" && echo 0 || echo 1)"
check "labels_report: all present -> no output" "" \
  "$(doctor_labels_report "$(printf 'ready\nbug')" "$(printf 'ready\nbug\ndocs')")"
check "labels_report: space-in-label whole-line match -> no warn" "" \
  "$(doctor_labels_report 'good first issue' "$(printf 'good first issue\nbug')")"
check "labels_report: no configured -> no output" "" \
  "$(doctor_labels_report '' "$(printf 'bug')")"

# doctor_label_scope_check (impure) with a gh stub + a real roles.py read.
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
    scope: { labels: [ready, ghostlabel] }
YAML
gh_pwd="$tmp/ghpwd"; gh_called="$tmp/ghcalled"
gh() {
  case "$1 $2" in
    "label list") pwd > "$gh_pwd"; touch "$gh_called"; printf 'ready\tReady\t#fff\n'; return 0 ;;
    *) return 0 ;;
  esac
}
lsc="$(doctor_label_scope_check "$tmp")"
check "label_check: missing label -> WARN"        "0" "$(has "$lsc" 'ghostlabel' && echo 0 || echo 1)"
check "label_check: present label not warned"     "1" "$(has "$lsc" "'ready'" && echo 0 || echo 1)"
check "label_check: gh ran in the TARGET repo"    "0" "$(test "$(cat "$gh_pwd")" = "$(cd "$tmp" && pwd)" && echo 0 || echo 1)"

# gh label list fails -> INFO hint, not a false WARN.
gh() { case "$1 $2" in "label list") return 1 ;; *) return 0 ;; esac; }
lsc_fail="$(doctor_label_scope_check "$tmp")"
check "label_check: gh fails -> INFO not WARN" "0" "$(has "$lsc_fail" '^INFO' && ! has "$lsc_fail" 'WARN' && echo 0 || echo 1)"

# saturated list (>=500) is unverifiable -> INFO, never a false missing-WARN.
gh() { case "$1 $2" in "label list") seq 1 500 | sed 's/^/l/;s/$/\t.\t#fff/' ;; *) return 0 ;; esac; }
lsc_sat="$(doctor_label_scope_check "$tmp")"
check "label_check: saturated list -> INFO not WARN" "0" "$(has "$lsc_sat" '^INFO' && ! has "$lsc_sat" 'WARN' && echo 0 || echo 1)"

# no configured labels -> silent AND no gh round-trip.
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
roles:
  coder:
    enabled: true
YAML
rm -f "$gh_called"
gh() { case "$1 $2" in "label list") touch "$gh_called"; return 0 ;; *) return 0 ;; esac; }
check "label_check: no configured labels -> silent" "" "$(doctor_label_scope_check "$tmp")"
check "label_check: no configured labels -> gh NOT called" "1" "$(test -f "$gh_called" && echo 0 || echo 1)"
unset -f gh

# ---- #171: merge_gate marker/author_login verification against the workflow ----
# doctor_marker_report (pure): the bot_comment gate greps review comments for
# author.login==author_login AND body contains marker; if the configured marker
# never appears in the installed workflow's comment, no PR is ever eligible.
wf_text='      - run: |
          { echo "## Claude Code Review"; echo ""; cat review.txt; } > comment_body.txt
          gh pr comment "$PR" --body-file comment_body.txt'
mr_ok="$(doctor_marker_report "Claude Code Review" "github-actions" "$wf_text")"
check "marker_report: marker in workflow -> OK"        "0" "$(has "$mr_ok" '^OK' && echo 0 || echo 1)"
check "marker_report: marker in workflow -> no WARN"   "1" "$(has "$mr_ok" 'WARN' && echo 0 || echo 1)"
check "marker_report: default author -> no INFO"       "1" "$(has "$mr_ok" '^INFO' && echo 0 || echo 1)"

mr_bad="$(doctor_marker_report "Robo Review" "github-actions" "$wf_text")"
check "marker_report: marker absent -> WARN naming it"  "0" "$(has "$mr_bad" "'Robo Review'" && has "$mr_bad" 'WARN' && echo 0 || echo 1)"

mr_auth="$(doctor_marker_report "Claude Code Review" "my-bot" "$wf_text")"
check "marker_report: non-default author -> INFO not WARN" "0" \
  "$(has "$mr_auth" '^INFO' && ! has "$mr_auth" 'WARN' && echo 0 || echo 1)"
check "marker_report: non-default author -> names the author" "0" "$(has "$mr_auth" "'my-bot'" && echo 0 || echo 1)"

# doctor_marker_check (impure): reads config defaults + the workflow files.
mkdir -p "$tmp/.github/workflows"
printf '%s\n' "$wf_text" > "$tmp/.github/workflows/claude-review.yml"
cat > "$tmp/.autonomy/config.yaml" <<'YAML'
merge_gate:
  strategy: bot_comment
YAML
mc_def="$(doctor_marker_check "$tmp")"
check "marker_check: defaults match stock workflow -> OK, no WARN" "0" \
  "$(has "$mc_def" '^OK' && ! has "$mc_def" 'WARN' && echo 0 || echo 1)"

cat > "$tmp/.autonomy/config.yaml" <<'YAML'
merge_gate:
  strategy: bot_comment
  marker: "Nope Not Here"
YAML
mc_bad="$(doctor_marker_check "$tmp")"
check "marker_check: mismatched marker -> WARN naming it" "0" \
  "$(has "$mc_bad" "'Nope Not Here'" && has "$mc_bad" 'WARN' && echo 0 || echo 1)"

# workflow dir unreadable/absent -> silent (best-effort; the outer branch already
# WARNs when no review workflow exists -- don't double-warn).
rm -rf "$tmp/.github"
check "marker_check: no workflow dir -> silent" "" "$(doctor_marker_check "$tmp")"

# ---- #211: tracked+dirty config.yaml is a silent-revert (stash-sweep) hazard ----
# doctor_dirty_config_report (pure): WARN ONLY when the config is git-tracked AND
# dirty; every other combination is silent (tracked+clean and untracked are both
# fine -- no per-run noise).
dc_hazard="$(doctor_dirty_config_report yes yes)"
check "dirty_config_report: tracked+dirty -> WARN" "0" "$(has "$dc_hazard" 'WARN' && echo 0 || echo 1)"
check "dirty_config_report: WARN names config.yaml" "0" "$(has "$dc_hazard" 'config.yaml' && echo 0 || echo 1)"
check "dirty_config_report: WARN names the stash-sweep hazard" "0" "$(has "$dc_hazard" 'stash' && echo 0 || echo 1)"
check "dirty_config_report: tracked+clean -> silent" "" "$(doctor_dirty_config_report yes no)"
check "dirty_config_report: untracked -> silent" "" "$(doctor_dirty_config_report no no)"
check "dirty_config_report: untracked+dirty -> silent" "" "$(doctor_dirty_config_report no yes)"

# doctor_dirty_config_check (impure): inspects real git state.
gtmp="$(mktemp -d)"
mkdir -p "$gtmp/.autonomy"
printf 'engine:\n  requires_claude_md: false\n' > "$gtmp/.autonomy/config.yaml"
check "dirty_config_check: non-git dir -> silent" "" "$(doctor_dirty_config_check "$gtmp")"
git -C "$gtmp" init -q
git -C "$gtmp" config user.email t@t; git -C "$gtmp" config user.name t
# tracked but untracked-in-git yet (not added) -> silent
check "dirty_config_check: config not yet tracked -> silent" "" "$(doctor_dirty_config_check "$gtmp")"
git -C "$gtmp" add .autonomy/config.yaml
git -C "$gtmp" commit -qm init
check "dirty_config_check: tracked+clean -> silent" "" "$(doctor_dirty_config_check "$gtmp")"
printf 'engine:\n  requires_claude_md: true\n' > "$gtmp/.autonomy/config.yaml"
dc_live="$(doctor_dirty_config_check "$gtmp")"
check "dirty_config_check: tracked+dirty -> WARN" "0" "$(has "$dc_live" 'WARN' && echo 0 || echo 1)"
# staged-but-uncommitted also gets stash-swept -> still flagged
git -C "$gtmp" add .autonomy/config.yaml
check "dirty_config_check: tracked+staged -> WARN" "0" "$(has "$(doctor_dirty_config_check "$gtmp")" 'WARN' && echo 0 || echo 1)"
rm -rf "$gtmp"

# --- doctor_agents_check (SD-30 / #87 slice 2): agents-registry health.
# Exercises the real `lib/agents.py doctor-report` CLI end-to-end with temp
# index paths (production passes none and hits the real ~/.config registries).
atmp="$(mktemp -d)"
agents_idx="$atmp/agents"
accounts_idx="$atmp/accounts"
printf '%s' '{"accounts": {"main": {"kind": "claude_subscription"}}}' > "$accounts_idx"

check "agents_check: absent registry -> silent" "" "$(doctor_agents_check "$agents_idx" "$accounts_idx")"
check "agents_check: absent registry -> rc 0" "0" "$(doctor_agents_check "$agents_idx" "$accounts_idx" >/dev/null 2>&1; echo $?)"

printf '%s' '{"agents": {"coder": {"account": "main"}}}' > "$agents_idx"
ac_ok="$(doctor_agents_check "$agents_idx" "$accounts_idx")"
check "agents_check: all refs resolve -> OK" "0" "$(has "$ac_ok" 'OK' && echo 0 || echo 1)"

printf '%s' '{"agents": {"coder": {"account": "main"}, "ghost": {"account": "gone"}}}' > "$agents_idx"
ac_dangle="$(doctor_agents_check "$agents_idx" "$accounts_idx")"
check "agents_check: dangling account ref -> WARN" "0" "$(has "$ac_dangle" 'WARN' && echo 0 || echo 1)"
check "agents_check: WARN names the agent" "0" "$(has "$ac_dangle" 'ghost' && echo 0 || echo 1)"
check "agents_check: WARN names the missing account" "0" "$(has "$ac_dangle" 'gone' && echo 0 || echo 1)"

printf '%s' '{ not json' > "$agents_idx"
ac_corrupt="$(doctor_agents_check "$agents_idx" "$accounts_idx")"
check "agents_check: corrupt index -> WARN unreadable" "0" "$(has "$ac_corrupt" 'unreadable' && echo 0 || echo 1)"
check "agents_check: corrupt index -> rc 0 (diagnostic-only)" "0" "$(doctor_agents_check "$agents_idx" "$accounts_idx" >/dev/null 2>&1; echo $?)"

# best-effort: python failing entirely (bogus interpreter path via a broken
# lib) must never block the report -- simulate by pointing DOCTOR_HOME at a
# dir with no lib/agents.py; the check prints nothing and returns 0.
save_home="$DOCTOR_HOME"
DOCTOR_HOME="$atmp"
check "agents_check: python failure -> silent rc 0" "0" "$(doctor_agents_check "$agents_idx" "$accounts_idx" >/dev/null 2>&1; echo $?)"
DOCTOR_HOME="$save_home"
rm -rf "$atmp"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
