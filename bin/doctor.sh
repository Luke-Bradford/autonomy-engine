#!/usr/bin/env bash
# bin/doctor.sh -- diagnostic readiness check for a target repo. Two entry
# points:
#   doctor_preflight_check <target-repo>  -- fast, local-only, called by
#     supervisor.sh on every loop iteration. Hard-fails only on what would
#     actually break the loop.
#   doctor_full_report <target-repo>      -- the full report (adds network
#     calls: gh auth scopes, review-bot workflow, GH Projects v2 board,
#     branch protection). Diagnostic/read-only -- never provisions anything.
#
# Run standalone:  bin/doctor.sh <target-repo>
set -uo pipefail
DOCTOR_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

doctor_preflight_check() {
  local repo="$1"
  if [ ! -f "$repo/.autonomy/config.yaml" ]; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml not found" >&2
    return 1
  fi
  if ! python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" __validate__ >/dev/null 2>&1; then
    echo "doctor: FAIL -- $repo/.autonomy/config.yaml does not parse" >&2
    return 1
  fi
  local requires_md
  requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
  # Claude Code loads CLAUDE.md from the repo root AND .claude/; accept either.
  if [ "$requires_md" = "true" ] \
     && [ ! -f "$repo/CLAUDE.md" ] && [ ! -f "$repo/.claude/CLAUDE.md" ]; then
    echo "doctor: FAIL -- engine.requires_claude_md is true but neither $repo/CLAUDE.md nor $repo/.claude/CLAUDE.md exists -- scaffold a starter with 'bin/onboard.sh $repo --claude-md' (or run /init in Claude Code)" >&2
    return 1
  fi
  return 0
}

# QA role readiness (#13): enabled-with-actions-substrate needs the
# qa-merge-gate workflow installed in the target repo; a routine substrate
# can't be verified locally. Prints exactly one OK/WARN line, or nothing when
# the QA role is not enabled. Diagnostic-only, never provisions.
doctor_qa_role_check() {
  local repo="$1" cfg="$1/.autonomy/config.yaml" qa_enabled qa_sub
  qa_enabled="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$cfg" roles.qa.enabled 2>/dev/null || echo false)"
  [ "$qa_enabled" = "true" ] || return 0
  qa_sub="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$cfg" roles.qa.substrate 2>/dev/null || echo)"
  case "$qa_sub" in
    actions)
      if grep -rlq "qa-gate" "$repo/.github/workflows" 2>/dev/null; then
        echo "OK   qa role (actions): qa-merge-gate workflow found under .github/workflows"
      else
        echo "WARN qa role enabled with substrate=actions but no qa-gate workflow under .github/workflows -- copy the engine's templates/qa-merge-gate.yml (and set the ANTHROPIC_API_KEY secret) or the role never fires"
      fi ;;
    routine)
      echo "WARN qa role uses substrate=routine -- cannot be verified locally; confirm the routine exists in claude.ai and points at this repo" ;;
    *)
      echo "WARN qa role enabled with substrate='${qa_sub:-unset}' -- the QA merge gate ships for 'actions' (or 'routine'); other substrates are not implemented" ;;
  esac
}

# fail-safe honesty (#149): surface every knob a role sets that the engine does
# not (yet) consume -- one INFO line each, from the SAME roles.py source the
# supervisor logs at dispatch, so config and runtime can't tell different
# stories. Diagnostic-only: never a FAIL/WARN, never provisions, never blocks.
doctor_knob_notes() {
  local repo="$1" notes _kn
  notes="$(python3 "$DOCTOR_HOME/lib/roles.py" knob-notes "$repo" 2>/dev/null)" || return 0
  [ -n "$notes" ] || return 0
  # Quoted here-string: expands $notes once, then inserts the content literally
  # (no second round of $/backtick/word expansion on the message text).
  while IFS= read -r _kn; do
    [ -n "$_kn" ] && echo "INFO $_kn"
  done <<<"$notes"
}

# lanes (#147 lanes execution, Part 1): report a declared `lanes:` block, warn
# for each NON-default lane that has roles (Part 1 routes work into lanes but
# per-lane execution -- the supervisor --lane flag + per-lane plist -- lands in
# Part 2, so those roles do NOT run yet), and warn on cross-lane label-scope
# overlap. Single-sourced from `roles.py lane-report` (LEVEL<TAB>message lines),
# so config and runtime tell one story. Diagnostic-only: never FAIL, never block.
doctor_lane_report() {
  local repo="$1" lines _lvl _msg
  lines="$(python3 "$DOCTOR_HOME/lib/roles.py" lane-report "$repo" 2>/dev/null)" || return 0
  [ -n "$lines" ] || return 0
  while IFS="$(printf '\t')" read -r _lvl _msg; do
    [ -n "$_msg" ] || continue
    case "$_lvl" in
      OK)   echo "OK   $_msg" ;;
      WARN) echo "WARN $_msg" ;;
    esac
  done <<EOF
$lines
EOF
}

# gh token-scope + review-bot-secret checks (#172 replication readiness). All
# diagnostic-only + best-effort: OK/WARN/INFO, never FAIL, never provision.

# Pure: merge the scope tokens from EVERY `Token scopes: 'a', 'b', ...` line of
# `gh auth status` output (tolerates multi-host/multi-account -- optimistic union
# is a diagnostic hint, not a gate). Prints ALL tokens on ONE space-separated
# line (the trailing `tr '\n' ' '` collapses multiple matched lines into one, so
# doctor_gh_scopes_report's space-anchored membership test sees the whole union).
doctor_gh_scopes() {
  printf '%s\n' "$1" | sed -n "s/.*Token scopes:[[:space:]]*//p" | tr -d "'" | tr ',\n' '  '
}

# Pure: tiered severity by real runtime need. repo/project missing -> WARN (the
# loop needs them); workflow missing -> INFO (setup-only: the loop never pushes
# .github/workflows, so it is needed only to install the review workflow). All
# present -> OK. Empty -> a WARN (never a silent pass).
doctor_gh_scopes_report() {
  local scopes=" $1 " miss=""
  if [ -z "$1" ]; then
    echo "WARN could not read gh token scopes -- run 'gh auth status'; the engine needs repo + project (board sync)"
    return 0
  fi
  case "$scopes" in *" repo "*) : ;; *) miss="$miss repo" ;; esac
  case "$scopes" in *" project "*) : ;; *) miss="$miss project" ;; esac
  if [ -n "$miss" ]; then
    local s
    for s in $miss; do
      echo "WARN gh token missing '$s' scope -- run 'gh auth refresh -s $s' (repo=core, project=Projects v2 board sync)"
    done
  fi
  case "$scopes" in
    *" workflow "*) : ;;
    *) echo "INFO gh token has no 'workflow' scope -- fine for the running loop; needed only to install/update the review workflow (gh auth refresh -s workflow)" ;;
  esac
  [ -z "$miss" ] && echo "OK   gh token scopes cover repo + project"
  return 0
}

# Impure: replaces the inline auth block. Capture BOTH streams (gh prints to
# either depending on version) from within $repo so the TARGET repo's token is
# read. Not authed -> WARN as before; authed -> OK + scope report.
doctor_gh_auth_check() {
  local repo="$1" out
  if out="$(cd "$repo" && gh auth status 2>&1)"; then
    echo "OK   gh auth status ok"
    doctor_gh_scopes_report "$(doctor_gh_scopes "$out")"
  else
    echo "WARN gh auth status failed -- run 'gh auth login' (need repo + project scopes)"
  fi
}

# Pure: rc 0 iff NAME is a whole first-column token in `gh secret list` output
# (a substring like NAME_OLD must not false-match). No pipe under pipefail.
doctor_secret_present() {
  local line name="$2"
  while IFS= read -r line; do
    case "$line" in
      "$name"[[:space:]]*|"$name") return 0 ;;
    esac
  done <<EOF
$1
EOF
  return 1
}

# Impure best-effort: called ONLY where the review workflow was found (no noise
# otherwise). Silent when not authed (the auth WARN already covers it -- no
# contradictory hint). Authed + secret present -> OK; absent -> WARN; the
# admin-only `gh secret list` failing -> INFO hint, never a false WARN.
doctor_review_secret_check() {
  local repo="$1" secrets
  (cd "$repo" && gh auth status >/dev/null 2>&1) || return 0
  if secrets="$(cd "$repo" && gh secret list 2>/dev/null)"; then
    if doctor_secret_present "$secrets" ANTHROPIC_API_KEY; then
      echo "OK   ANTHROPIC_API_KEY secret set (review bot can run)"
    else
      echo "WARN ANTHROPIC_API_KEY secret not found in this repo -- the review workflow will fail and no PR gets an APPROVE. Add it: gh secret set ANTHROPIC_API_KEY"
    fi
  else
    echo "INFO could not verify repo secrets (needs admin) -- ensure ANTHROPIC_API_KEY is set for the review workflow"
  fi
}

# scope-label existence check (#171). A typo'd roles.*.scope.labels entry
# silently empties a role's board; warn when a configured label isn't on the
# repo. Diagnostic-only + best-effort.

# Pure: WARN each configured label (newline list) absent from the repo-labels
# (newline list), by EXACT bash string equality -- no grep, so a '-'-leading or
# regex-metachar or space-holding label neither breaks nor false-matches.
doctor_labels_report() {
  local configured="$1" repo_labels="$2" label rline found
  [ -n "$configured" ] || return 0
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    found=1
    while IFS= read -r rline; do
      if [ "$rline" = "$label" ]; then found=0; break; fi
    done <<EOF
$repo_labels
EOF
    if [ "$found" != 0 ]; then
      echo "WARN scope label '$label' not found on the repo -- roles scoped to it see an EMPTY board (create the label or fix the typo)"
    fi
  done <<EOF
$configured
EOF
}

# Impure best-effort. Caller gates this to a VALID roles block (roles_rc=0), so
# it never WARNs from an untrusted config. Nothing configured -> no gh call.
doctor_label_scope_check() {
  local repo="$1" configured raw repo_labels count
  configured="$(python3 "$DOCTOR_HOME/lib/roles.py" scope-labels "$repo" 2>/dev/null)" || return 0
  [ -n "$configured" ] || return 0
  # Capture gh's rc WITHOUT a pipe (a `... | cut` substitution returns cut's rc
  # unless pipefail is set, silently turning a gh failure into an empty list and
  # false 'missing' WARNs). Only then split the columns.
  if ! raw="$(cd "$repo" && gh label list --limit 500 2>/dev/null)"; then
    echo "INFO could not list repo labels (gh) -- can't verify role scope labels; ensure they exist"
    return 0
  fi
  # Count non-empty lines (each is one label) -- exact regardless of trailing
  # newlines; `|| true` guards grep's rc 1 on a zero (empty) count.
  count="$(printf '%s\n' "$raw" | grep -c . || true)"
  if [ "${count:-0}" -ge 500 ]; then
    echo "INFO repo has >=500 labels -- too many to verify scope labels reliably; skipping"
    return 0
  fi
  repo_labels="$(printf '%s\n' "$raw" | cut -f1)"
  doctor_labels_report "$configured" "$repo_labels"
}

# merge_gate marker/author_login verification (#171). Under strategy=bot_comment
# safe_merge only merges a PR carrying a comment whose author.login==author_login
# AND whose body contains marker (bin/safe_merge.sh:211-212 defaults). A typo in
# either = the gate is never satisfied and every PR stalls (fail-safe but
# baffling). Diagnostic-only + best-effort.

# Pure: given the configured marker + author_login + the installed workflow text,
# HEURISTICALLY check the bot_comment gate's selectors against the workflow. The
# marker test is a plain substring of the workflow SOURCE, not the posted comment
# body -- so it's deliberately a WARN-only signal: a genuinely typo'd marker never
# appears anywhere in the workflow -> WARN (the case #171 targets); the OK is only
# "the marker text is present", NOT a promise the gate will match (a marker that
# coincidentally appears in an unrelated line still reads OK -- diagnostic, not a
# guarantee). author_login can't be derived from the workflow at all, so the stock
# identity ('github-actions' -- safe_merge's default AND the empirically-observed
# author.login of the review comment, verified against this repo's own merged PRs)
# is confirmed and any other value is only flagged INFO (doctor can't see a custom
# CI identity).
doctor_marker_report() {
  local marker="$1" author="$2" wf="$3"
  case "$wf" in
    *"$marker"*)
      echo "OK   merge_gate.marker '$marker' text is present in the installed review workflow (best-effort source match)" ;;
    *)
      echo "WARN merge_gate.marker '$marker' not found in the installed review workflow -- the bot_comment gate greps review comments for this marker, so it never matches and every PR stalls. Align it with the workflow's comment header (default 'Claude Code Review')." ;;
  esac
  if [ "$author" = "github-actions" ]; then
    echo "OK   merge_gate.author_login '$author' matches the workflow's commenting identity (GITHUB_TOKEN)"
  else
    echo "INFO merge_gate.author_login '$author' is non-default -- doctor can't verify a custom CI identity against the workflow; ensure it EXACTLY matches the login that posts the review comment (the stock workflow posts as 'github-actions')."
  fi
}

# Impure best-effort. Resolves the SAME defaults safe_merge uses, reads the
# installed workflow files, and delegates to the pure reporter. Silent when the
# workflow dir is absent (the caller's branch already WARNs on a missing review
# workflow -- no double-warn).
doctor_marker_check() {
  local repo="$1" marker author wf
  [ -d "$repo/.github/workflows" ] || return 0
  marker="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" merge_gate.marker 2>/dev/null || echo)"
  marker="${marker:-Claude Code Review}"
  author="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" merge_gate.author_login 2>/dev/null || echo)"
  author="${author:-github-actions}"
  # Concatenate every workflow file (bash 3.2: find -print0 + read -d '', no
  # globstar). A gh/read hiccup leaves wf empty -> the marker WARN fires, which is
  # the safe direction (an unverifiable marker is worth a look).
  wf=""
  while IFS= read -r -d '' f; do
    wf="$wf$(cat "$f" 2>/dev/null)"$'\n'
  done < <(find "$repo/.github/workflows" -type f -print0 2>/dev/null)
  doctor_marker_report "$marker" "$author" "$wf"
}

# #211: a git-TRACKED .autonomy/config.yaml that is DIRTY in a loop worktree is a
# silent-revert hazard. The supervisor's preflight stash-recovery sweeps
# uncommitted changes, so a config-page 'save default' that writes a tracked key
# (board.*/merge_gate.*) reverts on the next tick -- worse, silently. This
# consumer-agnostic guard surfaces the whole class early (the model/effort keys
# already dodge it via the #202 untracked overlay). Pure reporter: WARN only on
# the hazard, silent otherwise (tracked+clean or an untracked config is fine --
# no per-run noise).
doctor_dirty_config_report() {
  local tracked="$1" dirty="$2"
  if [ "$tracked" = yes ] && [ "$dirty" = yes ]; then
    echo "WARN .autonomy/config.yaml is git-tracked AND has uncommitted changes -- in a loop worktree the supervisor's preflight stash-recovery sweeps this, so a config-page save to a tracked key (board.*/merge_gate.*) silently reverts on the next tick. Commit or discard the change, or route the key through the untracked overlay (#202/#211)."
  fi
}

# Impure best-effort. Inspects the target repo's real git state and delegates to
# the pure reporter. Silent when the repo is not a git checkout or git can't read
# it (can't inspect -> no false alarm). Staged-but-uncommitted counts as dirty:
# `git stash` sweeps the index too, so it reverts just the same.
doctor_dirty_config_check() {
  local repo="$1" tracked=no dirty=no
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  if git -C "$repo" ls-files --error-unmatch .autonomy/config.yaml >/dev/null 2>&1; then
    tracked=yes
    [ -n "$(git -C "$repo" status --porcelain -- .autonomy/config.yaml 2>/dev/null)" ] && dirty=yes
  fi
  doctor_dirty_config_report "$tracked" "$dirty"
}

doctor_full_report() {
  local repo="$1" hard_fail=0
  echo "== doctor.sh report: $repo =="

  if doctor_preflight_check "$repo" 2>/tmp/doctor_preflight_err.$$; then
    echo "OK   .autonomy/ present, config.yaml valid"
  else
    cat /tmp/doctor_preflight_err.$$
    hard_fail=1
  fi
  rm -f /tmp/doctor_preflight_err.$$

  doctor_dirty_config_check "$repo"

  if [ -f "$repo/CLAUDE.md" ]; then
    echo "OK   CLAUDE.md present (repo root)"
  elif [ -f "$repo/.claude/CLAUDE.md" ]; then
    echo "OK   .claude/CLAUDE.md present"
  else
    local requires_md
    requires_md="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" engine.requires_claude_md 2>/dev/null || echo false)"
    if [ "$requires_md" != "true" ]; then
      echo "WARN no CLAUDE.md found (repo root or .claude/) -- scaffold a starter with 'bin/onboard.sh $repo --claude-md', run /init in Claude Code, or use the claude-md-management:claude-md-improver skill"
    fi
  fi

  local strategy
  strategy="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" merge_gate.strategy 2>/dev/null || echo manual)"
  strategy="${strategy:-manual}"
  if [ "$strategy" = "bot_comment" ]; then
    if [ -d "$repo/.github/workflows" ] && grep -rlE 'anthropic\.com/v1/messages|ANTHROPIC_API_KEY' "$repo/.github/workflows" >/dev/null 2>&1; then
      echo "OK   review-bot workflow found under .github/workflows (merge_gate.strategy=bot_comment)"
      doctor_review_secret_check "$repo"
      doctor_marker_check "$repo"
    else
      echo "WARN no review-bot workflow found under .github/workflows -- merge_gate.strategy=bot_comment will never see an APPROVE and every PR will stall. Add a workflow, or switch to manual/ci_only."
    fi
  fi

  # roles: block (multi-role org, #12) -- absent is fine (defaults: coder
  # only); present-but-invalid is a hard misconfig worth failing the report.
  # roles.py's exit code carries the whole verdict (0 valid / 3 valid-absent /
  # else invalid) and 2>&1 keeps its parse errors in the FAIL detail.
  local roles_out roles_rc
  roles_out="$(python3 "$DOCTOR_HOME/lib/roles.py" "$repo" 2>&1)"; roles_rc=$?
  case "$roles_rc" in
    0) echo "OK   roles: block valid"
       doctor_label_scope_check "$repo" ;;
    3) echo "OK   no roles: block -- defaults apply (coder loop only)" ;;
    2) echo "FAIL roles: cannot read config.yaml:"
       echo "$roles_out" | sed 's/^/     /'
       hard_fail=1 ;;
    *) echo "FAIL roles: block invalid:"
       echo "$roles_out" | sed 's/^/     /'
       hard_fail=1 ;;
  esac
  doctor_qa_role_check "$repo"
  doctor_knob_notes "$repo"
  doctor_lane_report "$repo"

  doctor_gh_auth_check "$repo"

  local owner project_title
  owner="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.owner 2>/dev/null || echo)"
  project_title="$(python3 "$DOCTOR_HOME/lib/config_parser.py" "$repo/.autonomy/config.yaml" board.project_title 2>/dev/null || echo)"
  if [ -n "$owner" ] && [ -n "$project_title" ]; then
    # shellcheck source=/dev/null
    source "$DOCTOR_HOME/bin/board.sh"
    ids="$(board_resolve_project "$owner" "$project_title")"
    read -r pid _ _ <<<"$ids"
    if [ -n "$pid" ]; then
      echo "OK   board '$project_title' found under '$owner'"
    else
      echo "WARN GitHub Projects v2 board '$project_title' not found under '$owner' -- board.sh will silently skip status updates"
    fi
  else
    echo "WARN board.owner/board.project_title not set in config.yaml -- board status updates will be skipped"
  fi

  if (cd "$repo" && gh api "repos/{owner}/{repo}/branches/main/protection" >/dev/null 2>&1); then
    echo "OK   branch protection configured on main"
  else
    echo "WARN no branch protection detected on main -- safe_merge.sh is the *local* gate only; consider adding required status checks"
  fi

  return "$hard_fail"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  TARGET="${1:?usage: doctor.sh <target-repo>}"
  doctor_full_report "$(cd "$TARGET" && pwd)"
  exit $?
fi
