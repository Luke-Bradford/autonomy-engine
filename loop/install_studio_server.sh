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
# DRIFT (#773). The service is provisioned from a clone pinned to origin/main at
# INSTALL time and nothing moves it forward on its own, so it drifts from main
# indefinitely. Measured 2026-07-30: the live clone was 14 commits and ~20h
# behind. After #410 that stops being cosmetic, because a fix to the quota reader
# would ship to main and never reach the process the spend guard actually asks.
#
# What this file does about it is DELIBERATELY NOT a scheduled updater.
# `studio/docs/2026-07-30-packaging-and-updates.md` (approved 2026-07-30) rejects
# scheduled auto-update for this service by name, and its reasoning is not
# abstract: a scheduled updater must not interrupt a running pipeline, so it
# needs an interlock, which needs starvation handling, which needs a rule about
# the loop's 03:05/21:05 windows. Measured against this repo's own driver log,
# an interlock keyed on "a fire is running" would have starved: the driver run
# beginning 2026-07-26T02:05Z ran for 74.7 HOURS, and roughly 2 of 15 daily slots
# over 07-26..07-30 would have fired at all. Applying an update stays a human
# act, and #792 phase 2 owns making that act a click.
#
# So the job here is to make the human act CHEAP and the drift VISIBLE:
#
#   * `--update` is a no-op when there is nothing to do, so it is safe to run
#     any time rather than being a minutes-long rebuild-and-bounce every time.
#   * `--status` reports what is actually running, so "is the guard on old code"
#     is a command that answers rather than a git incantation you have to think
#     to run.
#   * STALENESS IS MEASURED FROM A BUILD STAMP, not from HEAD. `provision` does
#     `reset --hard origin/main` BEFORE `pnpm build`, so a failed build leaves
#     HEAD already advanced. Comparing HEAD to origin/main would then read
#     "current" forever while the service ran old code -- a visible failure
#     converted into an invisible permanent one. `built.sha` is written only
#     after a build succeeds, so a failed build is retried rather than latched.
#
# Usage:
#   install_studio_server.sh [--port N] [--state-dir P] [--repo-src P] [--node P]
#   install_studio_server.sh --update      # refresh to origin/main IF STALE, rebuild, restart
#   install_studio_server.sh --update --force   # rebuild even if the stamp says current
#   install_studio_server.sh --status      # fetch, then report drift + unit state; change nothing
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

# Timestamped, because these lines are the drift record: an operator reading them
# needs to know WHEN the last check ran, which is the one question a staleness
# log has to answer. `date` is not available under `set -u` surprises here -- it
# is a plain external call and a failure just yields an empty prefix.
say() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ') install_studio_server] $*"; }
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
  FORCE=0
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
      # `--update` used to be a bare alias for a re-run. It is now the UNATTENDED
      # mode (#773): same install path, but gated on a staleness check and on no
      # fire being in flight, because the scheduled updater invokes it several
      # times a day and a plain re-run each time would bounce the spend guard's
      # quota source for nothing. A plain install stays unconditional -- an
      # operator who ran the installer by hand asked for it NOW.
      --update)    MODE="update"; shift ;;
      # The escape hatch from the staleness check, for a human. Deliberately NOT
      # used by the updater plist.
      --force)     FORCE=1; shift ;;
      --status)    MODE="status"; shift ;;
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
  # Written ONLY after `pnpm build` returns 0. See the header: HEAD advances
  # before the build runs, so HEAD is not evidence that anything was built.
  BUILT_SHA_FILE="$STATE_DIR/built.sha"
  LOCK_DIR="$STATE_DIR/.install.lock"
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
    # A directory that exists but is not a git tree is NOT something to clone
    # over: `git clone --local` into a non-empty path fails with a message about
    # the destination rather than about the real problem. Self-heal covers "unit
    # unloaded" and "never built"; it does not cover a corrupt tree, and saying
    # so beats an opaque clone error at 12:30.
    if [ -d "$SERVICE_ROOT" ] && [ -n "$(ls -A "$SERVICE_ROOT" 2>/dev/null)" ]; then
      die "$SERVICE_ROOT exists but is not a git checkout. Refusing to clone over
  it. Inspect it, then remove it and re-run to reprovision from scratch."
      return 1
    fi
    say "cloning the service tree from $REPO_SRC"
    git clone --local --quiet "$REPO_SRC" "$SERVICE_ROOT" || { die "clone failed"; return 1; }
    pr_url="$(git -C "$REPO_SRC" remote get-url origin 2>/dev/null)"
    [ -n "$pr_url" ] && git -C "$SERVICE_ROOT" remote set-url origin "$pr_url"
  fi
  say "pinning the service tree to origin/main"
  fetch_origin || return 1
  git -C "$SERVICE_ROOT" reset --hard --quiet origin/main || { die "reset to origin/main failed"; return 1; }
  say "installing dependencies"
  pnpm -C "$SERVICE_ROOT/studio" install --frozen-lockfile || { die "pnpm install failed"; return 1; }
  say "building (shared -> server -> web)"
  pnpm -C "$SERVICE_ROOT/studio" build || { die "pnpm build failed"; return 1; }
  # ONLY here, and never before the build. `reset --hard` above has already moved
  # HEAD, so if the build had failed HEAD would still say "we are on origin/main"
  # while nothing of that commit had been compiled. Staleness measured from HEAD
  # would then report current forever and the service would run old code with
  # every observable agreeing it was up to date -- strictly worse than the
  # loud-failure-every-time status quo this replaces.
  pv_sha="$(origin_sha)"
  [ -n "$pv_sha" ] || { die "built, but could not read origin/main to stamp it"; return 1; }
  printf '%s\n' "$pv_sha" >"$BUILT_SHA_FILE" || return 1
  say "built and stamped $pv_sha"
}

# --- fetch_origin: a fetch failure is UNKNOWN, never "current".
#
# `origin/main` inside the clone is a cached local ref, so a failed fetch leaves
# a stale one that compares equal to the build stamp and reads as up to date. It
# was five commits behind on 2026-07-30 with nothing in the clone able to tell.
# Silently building (or NOT building) a stale tree is how a service ends up
# running code nobody can point at.
fetch_origin() {
  git -C "$SERVICE_ROOT" fetch --quiet origin main || {
    die "fetch origin main failed: staleness is UNKNOWN, so this run is making no
  changes. It is NOT a report that the service is current. Check connectivity
  and the clone at $SERVICE_ROOT, then re-run."
    return 1
  }
}

origin_sha() { git -C "$SERVICE_ROOT" rev-parse origin/main 2>/dev/null; }
head_sha()   { git -C "$SERVICE_ROOT" rev-parse HEAD 2>/dev/null; }
built_sha()  { cat "$BUILT_SHA_FILE" 2>/dev/null; }

# --- service_is_current: may this run do nothing at all?
#
# Every clause is a reason to ACT, so the function is deliberately conservative:
# anything unknown or missing falls through to a full install. Note the stamp, not
# HEAD (see `provision`), and note that a MISSING stamp -- a tree that has never
# built, or whose last build failed -- is not current.
service_is_current() {
  sic_built="$(built_sha)"
  sic_origin="$(origin_sha)"
  [ -n "$sic_built" ] && [ -n "$sic_origin" ] || return 1
  [ "$sic_built" = "$sic_origin" ] || return 1
  # The stamp says a build succeeded; these say its output is still there and
  # actually being served. Together they make the check self-healing: a wiped
  # dist or an unloaded unit reinstalls rather than reporting "current".
  [ -f "$SERVER_DIR/dist/index.js" ] || return 1
  [ -f "$PLIST_PATH" ] || return 1
  unit_loaded || return 1
  # LIVENESS, and it is load-bearing rather than belt-and-braces. Every clause
  # above is satisfied by a service that built, bootstrapped, and then never
  # answered: `wait_ready` is the only thing that ever asks, it runs once at the
  # end of an install, and its failure leaves the stamp and both plists behind.
  # `unit_loaded` cannot tell the difference either -- launchd prints `-` in the
  # pid column for a job it is respawning every 30s exactly as it does for a
  # healthy idle one. Without this the guard's own quota source can be down
  # permanently while every run reports "already current".
  #
  # Retried, because the remedy is disproportionate to a blip: "not current"
  # means a full `pnpm install` + build + bounce, which is minutes of work and an
  # outage of the very source we are protecting. Three tries makes a transient
  # non-answer cost 4 seconds instead of a rebuild, while a genuinely dead server
  # still gets one.
  sic_i=0
  while [ "$sic_i" -lt 3 ]; do
    server_answers && return 0
    sic_i=$((sic_i + 1))
    [ "$sic_i" -lt 3 ] && sleep 2
  done
  return 1
}

server_answers() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# --- report_status: the drift surface (#773 asked for the running commit to be
# readable rather than inferred from a git incantation nobody thinks to run).
# Read-only: it must never write, build, or touch launchd.
report_status() {
  # It FETCHES first, and that is the difference between a drift report and a
  # comforting one. `origin/main` inside the clone is a cached local ref that
  # only advances when something fetches, so a status built on it fails in the
  # same direction as the thing it monitors: the longer nobody updates, the more
  # confidently it reports "current". Fetching touches refs only -- the service,
  # the working tree and the build are untouched -- so this stays read-only in
  # every sense that matters.
  if [ -d "$SERVICE_ROOT/.git" ]; then
    git -C "$SERVICE_ROOT" fetch --quiet origin main 2>/dev/null \
      || say "warning: fetch failed; origin/main below is a CACHED ref and may itself be stale"
  fi
  rs_built="$(built_sha)"
  rs_origin="$(origin_sha)"
  say "state dir:   $STATE_DIR"
  say "built sha:   $rs_built   (the only evidence anything was COMPILED)"
  say "HEAD sha:    $(head_sha)"
  say "origin/main: $rs_origin"
  say "dist built:  $([ -f "$SERVER_DIR/dist/index.js" ] && echo yes || echo no)"
  say "$LABEL: $(unit_loaded && echo "loaded pid $(unit_pid)" || echo "NOT LOADED")"
  say "health:      $(server_answers && echo "answers on $PORT" || echo "NO ANSWER on $PORT")"
  # The verdict, spelled out. A reader should not have to diff two shas by eye to
  # answer "is the guard on old code".
  if [ -n "$rs_built" ] && [ "$rs_built" = "$rs_origin" ]; then
    say "verdict:     CURRENT"
  else
    say "verdict:     STALE -- run '$0 --update' to rebuild onto origin/main"
  fi
  return 0
}

# --- lock: the scheduled updater and an operator can otherwise land in the same
# tree at once -- two `reset --hard` plus two interleaved bootout/bootstrap
# cycles is a corrupt checkout and a possibly-unloaded unit. `mkdir` is the
# atomic primitive available on bash 3.2 macOS (no flock). A lock older than an
# hour is treated as abandoned: a killed install must not wedge the updater
# forever.
# Returns 0 = held it, 1 = someone else holds it (a no-op, not a failure),
# 2 = could not even try. The three must stay distinct: collapsing 2 into 1 told
# the operator "another install is in progress" for an unwritable state dir and
# exited 0, which for the scheduled unit is a silent-success loop forever with a
# false explanation in its log.
acquire_lock() {
  mkdir -p "$STATE_DIR" 2>/dev/null || { die "cannot create the state dir $STATE_DIR"; return 2; }
  take_lock && return 0
  al_age="$(find "$LOCK_DIR" -maxdepth 0 -mmin +60 2>/dev/null)"
  if [ -n "$al_age" ]; then
    say "warning: removing an abandoned lock at $LOCK_DIR (older than 60m)"
    rm -rf "$LOCK_DIR"
    take_lock && return 0
  fi
  say "another install is in progress ($LOCK_DIR); doing nothing."
  return 1
}
# The owner stamp is what makes `release_lock` safe. Two runs that both see a
# lock older than 60m can both steal it, and the second `rm -rf` would otherwise
# delete the first's FRESH lock; without an owner check the loser then also
# deletes the winner's lock on its way out, leaving the tree unprotected while
# both are still working in it.
take_lock() {
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  printf '%s\n' "$$" >"$LOCK_DIR/owner"
}
release_lock() {
  [ "$(cat "$LOCK_DIR/owner" 2>/dev/null)" = "$$" ] || return 0
  rm -rf "$LOCK_DIR"
}

# --- unit_pid: the launchd pid for our label, or "" if the job is not loaded.
# NOTE this can legitimately be `-`: launchd prints a dash for a job that is
# LOADED but not currently running. Hence `unit_loaded` as a separate question.
unit_pid() {
  launchctl list 2>/dev/null | awk -v l="$LABEL" '$3 == l { print $1 }'
}

# --- unit_loaded: is the job registered with launchd at all, running or not.
unit_loaded() { [ -n "$(unit_pid)" ]; }

load_unit() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  bo_rc=$?
  case "$bo_rc" in
    0|3|113) : ;;
    *) say "warning: bootout exited $bo_rc (continuing)" ;;
  esac
  lu_i=0
  while [ "$lu_i" -lt 60 ] && unit_loaded "$LABEL"; do
    sleep 1
    lu_i=$((lu_i + 1))
  done
  ! unit_loaded "$LABEL" || say "warning: $LABEL still loaded after ${lu_i}s; bootstrapping anyway"
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
    # Under the lock when there is a state dir to lock. `uninstall_unit` removes
    # the updater first so an uninstall cannot undo itself, but that only holds
    # against a FUTURE slot: a run already in progress would reinstall both units
    # straight after, and booting out a running updater mid-build would leak its
    # lock for the full hour.
    uninstall)
      [ -d "$STATE_DIR" ] || { uninstall_unit; return 0; }
      acquire_lock || { die "not uninstalling while an install is in progress."; return 1; }
      uninstall_unit
      uu_rc=$?
      release_lock
      return "$uu_rc" ;;
    # Read-only, so it deliberately skips every install-only precondition and the
    # node lookup: diagnosing a broken install must not require the install to be
    # workable.
    status)    report_status; return 0 ;;
  esac

  validate_install_target || return 1

  if [ "$DRY_RUN" -eq 1 ]; then
    resolve_node || return 1
    say "--dry-run: the plist below would be written to $PLIST_PATH"
    render_plist || return 1
    return 0
  fi

  acquire_lock
  al_rc=$?
  case "$al_rc" in
    0) : ;;
    # Someone else holds it: a genuine no-op, and not a failure to report.
    1) return 0 ;;
    # Could not even try (an unwritable or uncreatable state dir). That IS a
    # failure, and reporting it as a no-op is how a scheduled job loops forever
    # on a real fault while its log reads like nothing was wrong.
    *) return 1 ;;
  esac
  main_locked
  ml_rc=$?
  release_lock
  return "$ml_rc"
}

# The body that runs under the lock, split out so `main` has exactly one release
# path and no `return` can leak past it.
main_locked() {
  # The unattended path only. `--update` runs several times a day from the
  # scheduled unit, so it asks two questions a hand-run install must not: is
  # there anything to do, and is now a safe moment.
  if [ "$MODE" = "update" ] && [ "$FORCE" -eq 0 ]; then
    # Only when there is a clone to fetch INTO. `git -C <missing dir> fetch`
    # exits 128, which would have made `--update` die at every slot on a wiped
    # or absent tree and never reach the path that recreates it -- while
    # `--force`, which skips this block, provisioned it correctly. `provision`
    # fetches again anyway, and its own "exists but is not a git checkout"
    # refusal gives the accurate message instead of a misleading fetch error.
    if [ -d "$SERVICE_ROOT/.git" ]; then
      fetch_origin || return 1
    else
      say "no clone at $SERVICE_ROOT; provisioning from scratch"
    fi
    if service_is_current; then
      say "already current at $(built_sha); nothing to do."
      return 0
    fi
    say "stale: built $(built_sha) vs origin/main $(origin_sha)"
  fi

  resolve_node || return 1

  # Refuse rather than install a unit that will lose the port race. Checked
  # BEFORE the expensive provision so a misconfiguration fails in a second.
  owner="$(port_owner)"
  if [ -n "$owner" ]; then
    mine="$(unit_pid "$LABEL")"
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
