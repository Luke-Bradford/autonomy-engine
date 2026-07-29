#!/bin/bash
# install_studio_server.sh -- install/refresh/remove the SUPERVISED studio server
# LaunchAgent (#765 Defect 2).
#
# The build loop's spend guard reads studio's `/api/quota` (`loop/drive.sh`
# quota_pct), and once the old engine is parked (#410) studio is one of only TWO
# sources left (the other is `loop/claude_usage.py`, relocated there by #764).
# Until this unit existed nothing supervised a studio server: the only
# listeners were ad-hoc `pnpm dev` sessions that die with their terminal, so at
# 03:05 the endpoint was connection-refused, not merely rate-limited. A guard
# that cannot read is a guard that spends two blind fires and then halts the
# loop -- and after #410 its only remaining fallback is a direct poll of the same
# rate-limited endpoint, sharing one credential and one macOS-only assumption.
#
# The service is deliberately ISOLATED from the loop's working checkout in three
# ways; each one guards an evidenced failure and each is asserted by
# test_install_studio_server.sh:
#
#   * its own CODE -- a clone pinned to origin/main under the state dir. The loop
#     branch-switches and rebuilds its checkout every fire and `dist/` is
#     gitignored, so a KeepAlive restart mid-fire would otherwise boot the quota
#     source from a foreign branch's half-written build.
#   * its own DB and git workspace root. Two studio servers on one sqlite file
#     corrupt each other's runs (reconcileOnBoot pumps `running` rows without the
#     drive lock; lease.ts judges liveness from in-process state and reclaims the
#     other instance's live runs), so a developer's `pnpm dev` must never share
#     state with the service.
#   * its own PORT (8788), not studio's 8080 dev default, which is contended on
#     this machine. A wrong-but-answering server 404s, which reads as UNREADABLE
#     forever while looking correctly configured -- #765 records exactly that.
#
# Usage:
#   install_studio_server.sh [--port N] [--state-dir P] [--repo-src P] [--node P]
#   install_studio_server.sh --update      # refresh the clone to origin/main, rebuild, restart
#   install_studio_server.sh --uninstall   # remove the unit (KEEPS the state dir)
#   install_studio_server.sh --dry-run     # print the plist that would be installed; touch nothing
set -uo pipefail

LABEL="com.autonomy.studio-server"
# The ONE place the service port is written down alongside `drive.sh`'s
# STUDIO_QUOTA_URL default; a test asserts the two agree. The driver LaunchAgent
# deliberately no longer pins STUDIO_QUOTA_URL -- a third copy is how the stale
# 8080 pin outlived the reason for it.
DEFAULT_PORT=8788
DEFAULT_STATE_DIR="$HOME/.autonomy-studio/service"
LAUNCHD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

TMPL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPL="$TMPL_DIR/$LABEL.plist.tmpl"

say() { echo "[install_studio_server] $*"; }
die() { echo "[install_studio_server] ERROR: $*" >&2; return 1; }

# --- valid_port: total, and deliberately stricter than "looks like a number".
# The value ends up in a URL the guard polls and in arithmetic downstream, and
# `drive.sh` already records the bash 3.2 lesson: digit-only is NOT enough,
# because `[ 10000000000000000000 -ge 80 ]` exceeds signed 64-bit and errors with
# rc=2 -- neither branch. A length bound is what makes the check total.
valid_port() { # $1=candidate
  vp_v="${1-}"
  [ -n "$vp_v" ] || return 1
  case "$vp_v" in *[!0-9]*) return 1 ;; esac
  [ "${#vp_v}" -le 5 ] || return 1
  # A leading zero is not a harmless spelling. Studio parses the port with
  # `Number()`, so `0080` becomes 80: the unit would try to bind a privileged
  # port, fail, and crash-loop on ThrottleInterval forever while this script had
  # already reported success. Reject it here rather than diagnose it there.
  case "$vp_v" in 0*) [ "${#vp_v}" -eq 1 ] || return 1 ;; esac
  [ "$vp_v" -ge 1 ] && [ "$vp_v" -le 65535 ]
}

# --- no_hostile_chars: the plist is built by `sed` substitution into XML, so a
# path containing `&` silently expands to the matched placeholder and `<`/`>`
# produce malformed XML. Neither is attacker-controlled here (values come from
# $HOME, flags and `command -v node`), but both fail at launchd bootstrap rather
# than at render, which is a much worse place to find out. Spaces are fine and
# are deliberately still allowed.
no_hostile_chars() { # $1=label $2=value
  case "${2-}" in
    *[\&\<\>\|\\]*) die "$1 may not contain & < > | or a backslash: '$2'"; return 1 ;;
  esac
}

# --- configure: parse flags and derive every path. Separated from `main` so the
# tests can set up state and call `render_plist` directly against real code.
configure() {
  PORT="$DEFAULT_PORT"
  STATE_DIR="$DEFAULT_STATE_DIR"
  REPO_SRC="$(cd "$TMPL_DIR/.." && pwd)"
  NODE_BIN=""
  DRY_RUN=0
  MODE="install"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      # `shift 2` FAILS when the value is missing, and a bare `return 1` then
      # exits silently -- "install_studio_server.sh --port" printed nothing at
      # all. Say which flag was short.
      --port)      PORT="${2-}"; shift 2 || { die "--port needs a value"; return 1; } ;;
      --state-dir) STATE_DIR="${2-}"; shift 2 || { die "--state-dir needs a value"; return 1; } ;;
      --repo-src)  REPO_SRC="${2-}"; shift 2 || { die "--repo-src needs a value"; return 1; } ;;
      --node)      NODE_BIN="${2-}"; shift 2 || { die "--node needs a value"; return 1; } ;;
      --dry-run)   DRY_RUN=1; shift ;;
      # An alias for a plain re-run, not a separate mode: the install path already
      # fetches, resets to origin/main, rebuilds and reloads, so "update" IS
      # "install again". Kept because that is not obvious from `install`.
      --update)    shift ;;
      --uninstall) MODE="uninstall"; shift ;;
      -h|--help)   MODE="help"; shift ;;
      *)           die "unknown argument: $1"; return 1 ;;
    esac
  done

  # Absolute, without `cd` (STATE_DIR need not exist yet). An EMPTY value is
  # left alone rather than turned into "$PWD/", so validate_install_target can
  # still see that it was empty -- rejecting it here would block `--uninstall`
  # on an install-only ground, which is the whole rule this file now follows:
  # `configure` PARSES and DERIVES, `validate_install_target` VALIDATES.
  case "$STATE_DIR" in '' | /*) : ;; *) STATE_DIR="$PWD/$STATE_DIR" ;; esac
  case "$REPO_SRC" in '' | /*) : ;; *) REPO_SRC="$PWD/$REPO_SRC" ;; esac

  SERVICE_ROOT="$STATE_DIR/repo"
  SERVER_DIR="$SERVICE_ROOT/studio/packages/server"
  WEB_ROOT="$SERVICE_ROOT/studio/packages/web/dist"
  DB_PATH="$STATE_DIR/data/app.sqlite"
  WORKSPACE_GIT_ROOT="$STATE_DIR/data/git"
  LOG_DIR="$STATE_DIR/logs"
  PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
}

# --- validate_install_target: preconditions that apply ONLY to installing.
#
# These live here rather than in `configure` for the same reason `resolve_node`
# does: anything `configure` rejects is rejected for EVERY mode, including
# `--uninstall`. A moved template or an awkward `--state-dir` would then block
# you from removing a crash-looping unit -- the precise failure the node lookup
# was pulled out to avoid. Teardown must never depend on the preconditions for
# setup.
validate_install_target() {
  [ -n "$STATE_DIR" ] || { die "--state-dir may not be empty"; return 1; }
  valid_port "$PORT" || { die "invalid --port '$PORT' (want an integer 1-65535, no leading zero)"; return 1; }
  # 8080 is studio's DEV default. Installing a KeepAlive unit there would fight
  # any `pnpm dev` for the port forever, and if it won it would share that
  # server's sqlite DB -- the exact corruption this unit is shaped to avoid
  # (reconcileOnBoot pumps `running` rows without the drive lock; lease.ts
  # reclaims the other instance's live runs). Refuse rather than warn.
  [ "$PORT" != "8080" ] || {
    die "refusing --port 8080: that is studio's dev-server default, and a
  supervised unit there would contend with any 'pnpm dev' and share its
  database. Use the dedicated service port instead (default $DEFAULT_PORT)."
    return 1
  }
  # Only the RENDERED plist is sensitive to these characters, so this is
  # install-only too -- an operator uninstalling with an explicit override must
  # not be turned away on grounds that only matter when writing a plist.
  no_hostile_chars "--state-dir" "$STATE_DIR" || return 1
  no_hostile_chars "--repo-src" "$REPO_SRC" || return 1

  # The service's state must not live inside the source checkout. That checkout
  # is branch-switched and rebuilt every loop fire, and the whole point of a
  # separate DB is that no other studio process can reach it.
  case "$STATE_DIR/" in
    "$REPO_SRC"/*)
      die "refusing a --state-dir inside the source checkout ($REPO_SRC).
  The service keeps its own database there, and that tree is rewritten by every
  build-loop fire."
      return 1 ;;
  esac
  # Checked up front, not at render time: a missing template used to be
  # discovered only AFTER a full clone + pnpm install + build, minutes in.
  [ -f "$TMPL" ] || { die "template missing: $TMPL"; return 1; }
}

# --- resolve_node: deliberately NOT part of `configure`. It used to run before
# the mode dispatch, which meant `--uninstall` and `--help` both required node on
# PATH -- so if node moved you could not remove a crash-looping unit.
resolve_node() {
  [ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null)"
  [ -n "$NODE_BIN" ] || { die "node not found on PATH; pass --node <path>"; return 1; }
  no_hostile_chars "--node" "$NODE_BIN" || return 1
}

# --- render_plist: substitute the template. `|` as the sed delimiter because
# every value is a path. Deterministic: same inputs, byte-identical output.
render_plist() {
  [ -f "$TMPL" ] || { die "template missing: $TMPL"; return 1; }
  sed -e "s|{{LABEL}}|$LABEL|g" \
      -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
      -e "s|{{SERVER_DIR}}|$SERVER_DIR|g" \
      -e "s|{{WEB_ROOT}}|$WEB_ROOT|g" \
      -e "s|{{DB_PATH}}|$DB_PATH|g" \
      -e "s|{{WORKSPACE_GIT_ROOT}}|$WORKSPACE_GIT_ROOT|g" \
      -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
      -e "s|{{PORT}}|$PORT|g" \
      -e "s|{{PATH_VALUE}}|$LAUNCHD_PATH|g" \
      "$TMPL"
}

# --- port_owner: the pid listening on $PORT, or "".
#
# No test-only override lives here any more. There was one, and it made the suite
# non-hermetic in the worst direction: with no override set the real `lsof` ran,
# so every install case FAILED on any machine where the service was actually
# running, and passed on CI only because ubuntu's 8788 is free. A test that goes
# red exactly when the system works is worse than no test. The suite now stubs
# `lsof` on PATH instead, which exercises this function for real.
port_owner() {
  command -v lsof >/dev/null 2>&1 || { echo ""; return 0; }
  lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

# --- provision: an isolated clone of the repo pinned to origin/main, installed
# and built. `--local` so the object store is hardlinked from the checkout rather
# than re-fetched; the remote is then repointed at the real origin so `--update`
# does not depend on the loop's checkout being current.
provision() {
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$(dirname "$DB_PATH")" "$WORKSPACE_GIT_ROOT" || return 1
  if [ ! -d "$SERVICE_ROOT/.git" ]; then
    say "cloning the service tree from $REPO_SRC"
    git clone --local --quiet "$REPO_SRC" "$SERVICE_ROOT" || { die "clone failed"; return 1; }
    pr_url="$(git -C "$REPO_SRC" remote get-url origin 2>/dev/null)"
    [ -n "$pr_url" ] && git -C "$SERVICE_ROOT" remote set-url origin "$pr_url"
  fi
  say "pinning the service tree to origin/main"
  # A fetch failure must NOT be papered over: silently building a stale tree is
  # how a service ends up running code nobody can point at.
  git -C "$SERVICE_ROOT" fetch --quiet origin main || { die "fetch origin main failed"; return 1; }
  git -C "$SERVICE_ROOT" reset --hard --quiet origin/main || { die "reset to origin/main failed"; return 1; }
  say "installing dependencies"
  pnpm -C "$SERVICE_ROOT/studio" install --frozen-lockfile || { die "pnpm install failed"; return 1; }
  say "building (shared -> server -> web)"
  pnpm -C "$SERVICE_ROOT/studio" build || { die "pnpm build failed"; return 1; }
}

# --- unit_pid: the launchd pid for our label, or "" if the job is not loaded.
unit_pid() {
  launchctl list 2>/dev/null | awk -v l="$LABEL" '$3 == l { print $1 }'
}

# --- load_unit: bootout, WAIT for the teardown, then bootstrap.
#
# `bootout` of a job that is not loaded exits 3 (or 113) -- that is the FIRST
# install and must not be an error.
#
# The wait is not belt-and-braces. `bootout` returns as soon as it has SIGNALLED
# the job, and this server handles SIGTERM with a graceful shutdown, so the label
# is still registered for a moment afterwards. A `bootstrap` issued into that
# window fails with `5: Input/output error` -- measured on the second install,
# 2026-07-29 -- which left the NEW plist on disk while the OLD process kept
# running: a half-applied upgrade reporting failure. Poll until the label is
# actually gone.
load_unit() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  bo_rc=$?
  case "$bo_rc" in
    0|3|113) : ;;
    *) say "warning: bootout exited $bo_rc (continuing)" ;;
  esac
  lu_i=0
  while [ "$lu_i" -lt 60 ] && [ -n "$(unit_pid)" ]; do
    sleep 1
    lu_i=$((lu_i + 1))
  done
  [ -z "$(unit_pid)" ] || say "warning: $LABEL still loaded after ${lu_i}s; bootstrapping anyway"
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" || {
    die "bootstrap failed. The plist at $PLIST_PATH is up to date but launchd did
  not accept it; the previously loaded job (if any) is still running, so the
  service may be on OLD code. 'launchctl print gui/\$(id -u)/$LABEL' for detail."
    return 1
  }
}

# --- wait_ready: `/health` first (the server is up), then `/api/quota` (it is
# the right server and the route exists). The quota read can take ~5s on a cold
# call -- keychain plus an upstream request -- so --max-time must clear that or
# the install reports a false failure.
#
# Worst case is 30 x (10s connect timeout + 2s sleep) = 360s, not the "60s" an
# earlier version of this message claimed. The bound only bites when the server
# is hanging rather than refusing; a refused connection returns immediately, so
# the common failure is still ~60s.
wait_ready() {
  wr_i=0
  while [ "$wr_i" -lt 30 ]; do
    if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      say "server is up on 127.0.0.1:$PORT"
      curl -fsS --max-time 15 "http://127.0.0.1:$PORT/api/quota" 2>/dev/null && echo
      return 0
    fi
    sleep 2
    wr_i=$((wr_i + 1))
  done
  # Be explicit that this is NOT "nothing was installed": the unit is written and
  # bootstrapped, and launchd is very likely restarting it every 30s right now.
  die "server did not answer /health on port $PORT (waited up to 360s).
  The unit IS installed and loaded, so launchd is retrying it every 30s.
  Look at $LOG_DIR/server.err.log, then either fix and re-run this script or
  '$0 --uninstall'."
}

uninstall_unit() {
  # Scope the bootout to THIS HOME's installation. The `rm` was already
  # HOME-scoped but the bootout was not, so running with a temp HOME (as a test
  # or a review does) unloaded the operator's live service while reporting a
  # tidy success. Observed exactly that on 2026-07-29.
  if [ ! -f "$PLIST_PATH" ]; then
    say "no unit installed at $PLIST_PATH; nothing to do."
    say "(if a $LABEL job is loaded, it was installed under a different HOME --"
    say " unload it explicitly with: launchctl bootout gui/\$(id -u)/$LABEL)"
    return 0
  fi
  say "unloading $LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  rm -f "$PLIST_PATH"
  # The state dir is NOT removed: it holds the service's database. Uninstalling a
  # supervisor must never be a data-destroying act.
  say "removed $PLIST_PATH (state dir $STATE_DIR kept)"
}

# Print the header comment block. Reads until the first non-comment line rather
# than slicing a hardcoded range, which silently truncated as the header grew.
usage() {
  awk 'NR == 1 { next }
       /^#/    { sub(/^# ?/, ""); print; next }
       { exit }' "${BASH_SOURCE[0]}"
}

main() {
  configure "$@" || return 1
  case "$MODE" in
    help)      usage; return 0 ;;
    uninstall) uninstall_unit; return 0 ;;
  esac

  validate_install_target || return 1
  resolve_node || return 1

  if [ "$DRY_RUN" -eq 1 ]; then
    say "--dry-run: the plist below would be written to $PLIST_PATH"
    render_plist || return 1
    return 0
  fi

  # Refuse rather than install a unit that will lose the port race. Checked
  # BEFORE the expensive provision so a misconfiguration fails in a second.
  owner="$(port_owner)"
  if [ -n "$owner" ]; then
    mine="$(unit_pid)"
    if [ "$owner" != "$mine" ]; then
      die "port $PORT is already held by pid $owner, which is not $LABEL.
  Stop that process (or choose another port with --port) and re-run. Installing
  anyway would leave the quota guard pointed at a server that is not ours -- a
  wrong-but-answering server reads as UNREADABLE forever while looking fine."
      return 1
    fi
  fi

  provision || return 1
  mkdir -p "$HOME/Library/LaunchAgents" || return 1
  # Render to a sibling temp then rename, so a failed render can never leave a
  # truncated plist where launchd would find one. Clean the temp up on failure
  # rather than leaving a 0-byte `.plist.tmp` behind.
  render_plist >"$PLIST_PATH.tmp" || { rm -f "$PLIST_PATH.tmp"; return 1; }
  mv "$PLIST_PATH.tmp" "$PLIST_PATH" || { rm -f "$PLIST_PATH.tmp"; return 1; }
  say "wrote $PLIST_PATH"
  load_unit || return 1
  wait_ready
}

# --- executable body (repo convention: sourcing this file must only define,
# never run) ------------------------------------------------------------
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

main "$@"
