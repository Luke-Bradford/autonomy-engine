#!/usr/bin/env bash
# bin/setup_worktree.sh -- create (idempotently) a dedicated git worktree for
# a target repo's autonomy loop, and install its launchd plist pointed at this
# engine + that worktree.
#
# Usage: setup_worktree.sh <target-repo-path> [worktree-path] [--lane <name>]
#
# --lane runs ONE lane of a multi-lane repo as its own launchd service (SD-21:
# one supervisor per lane). The default lane keeps the legacy label + worktree
# byte-identical to today; a non-default lane gets `com.autonomy.<slug>.<lane>.
# supervisor` + a `.<slug>-<lane>-autonomy` worktree + `--lane <name>` in the
# plist. An undeclared/malformed lane is refused (never provision a dead service).
#
# Repo-slug (used for the worktree default path and the launchd Label) =
# .autonomy/config.yaml's engine.label if set, else the target repo's
# directory basename, lowercased, non-alphanumeric runs collapsed to '-'.
set -euo pipefail
ENGINE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_GET() { python3 "$ENGINE_HOME/lib/config_parser.py" "$1" "$2" 2>/dev/null; }

# Derive the repo-slug for $TARGET_REPO -- the caller sets that variable
# first (the guarded main body below sets it after resolving $1; tests set it
# directly to a fixture path before calling this function).
derive_slug() {
  local label; label="$(CONFIG_GET "$TARGET_REPO/.autonomy/config.yaml" engine.label)"
  if [ -n "$label" ]; then printf '%s' "$label"; return; fi
  basename "$TARGET_REPO" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# Resolve the worktree path. Precedence: positional arg ($1) > config
# worktree.default_path > derived default ".${SLUG}-autonomy" beside the target
# repo. Reads TARGET_REPO + SLUG (set by the caller). The config read is guarded
# with `|| printf ''` so an ABSENT worktree.default_path -- config_parser exits
# non-zero -- yields empty and falls through to the default, rather than tripping
# `set -e` and aborting the whole script (a bare `x="$(failing)"` takes the
# command's non-zero status; this bit repos that don't set the key).
resolve_worktree_path() {
  local positional="$1"
  if [ -n "$positional" ]; then printf '%s' "$positional"; return; fi
  local cfg_path; cfg_path="$(CONFIG_GET "$TARGET_REPO/.autonomy/config.yaml" worktree.default_path || printf '')"
  if [ -n "$cfg_path" ]; then
    cfg_path="${cfg_path//\{repo-slug\}/$SLUG}"          # substitute {repo-slug}
    case "$cfg_path" in
      /*) printf '%s' "$cfg_path" ;;                     # absolute: as-is
      *)  printf '%s' "$(cd "$TARGET_REPO/.." && pwd)/$(basename "$cfg_path")" ;;  # relative: vs target's parent
    esac
    return
  fi
  printf '%s' "$(cd "$TARGET_REPO/.." && pwd)/.${SLUG}-autonomy"
}

# --- lanes (#147 Part 2) -----------------------------------------------------
# One repo can run N lanes as N launchd services (SD-21: one supervisor per lane).
# The DEFAULT lane keeps the LEGACY label/worktree byte-identical to today; a
# non-default lane gets a distinct label segment + worktree so nothing collides.

# The __LABEL__ template segment (the template wraps it as
# `com.autonomy.<seg>.supervisor`). Empty lane or lane == the default lane keeps
# the legacy `<slug>` (SD-21 back-compat); a non-default lane -> `<slug>.<lane>`.
lane_label_middle() {
  local slug="$1" lane="$2" default_lane="$3"
  if [ -z "$lane" ] || [ "$lane" = "$default_lane" ]; then printf '%s' "$slug"; return; fi
  printf '%s.%s' "$slug" "$lane"
}

# The derived worktree BASENAME. Default/empty lane keeps `.<slug>-autonomy`
# (unchanged); a non-default lane gets `.<slug>-<lane>-autonomy` so a per-lane
# install never overwrites the default worktree.
lane_worktree_default() {
  local slug="$1" lane="$2" default_lane="$3"
  if [ -z "$lane" ] || [ "$lane" = "$default_lane" ]; then printf '.%s-autonomy' "$slug"; return; fi
  printf '.%s-%s-autonomy' "$slug" "$lane"
}

# Render the plist template with a line-by-line reader (NOT multi-line sed --
# newline-in-replacement is not portable on BSD sed). Substitutes the three
# tokens via bash parameter expansion; when `lane` is non-empty, appends
# `--lane <lane>` immediately after the `--repo` value so the supervisor runs
# that lane. Empty lane inserts nothing -> byte-identical to today's render.
render_plist() {
  local tmpl="$1" engine="$2" repo="$3" label="$4" lane="$5"
  local line out prev=""
  while IFS= read -r line || [ -n "$line" ]; do
    out="$line"
    out="${out//__ENGINE_HOME__/$engine}"
    out="${out//__REPO__/$repo}"
    out="${out//__LABEL__/$label}"
    printf '%s\n' "$out"
    case "$prev" in
      *"<string>--repo</string>")
        if [ -n "$lane" ]; then
          printf '    <string>--lane</string>\n'
          printf '    <string>%s</string>\n' "$lane"
        fi
        ;;
    esac
    prev="$line"
  done < "$tmpl"
}

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

LANE=""
ARG_TARGET=""
ARG_WORKTREE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lane)
      if [ $# -lt 2 ]; then echo "setup_worktree.sh: --lane needs a value" >&2; exit 1; fi
      LANE="$2"; shift 2 ;;
    --lane=*) LANE="${1#--lane=}"; shift ;;
    -*) echo "setup_worktree.sh: unknown flag: $1" >&2; exit 1 ;;
    *)
      if [ -z "$ARG_TARGET" ]; then ARG_TARGET="$1"
      elif [ -z "$ARG_WORKTREE" ]; then ARG_WORKTREE="$1"
      else echo "setup_worktree.sh: too many arguments ($1)" >&2; exit 1
      fi
      shift ;;
  esac
done

TARGET="${ARG_TARGET:?usage: setup_worktree.sh <target-repo-path> [worktree-path] [--lane <name>]}"
case "$TARGET" in
  http://*|https://*|git@*)
    echo "setup_worktree.sh: pass a local path to an existing checkout, not a URL ($TARGET)" >&2
    exit 1
    ;;
esac
TARGET_REPO="$(cd "$TARGET" && pwd)"

SLUG="$(derive_slug)"
[ -n "$SLUG" ] || { echo "setup_worktree.sh: could not derive a repo-slug for $TARGET_REPO" >&2; exit 1; }

# Resolve + validate the lane. No --lane = today's path (empty lane, legacy
# label/worktree). When set: charset/length pre-check (defense-in-depth before
# the value reaches argv/grep), then the authoritative gate -- `roles.py lanes`
# prints the declared lanes one per line and returns non-zero on a malformed
# lanes: block (a non-zero rc is itself a REFUSAL, fail-safe, never guess). The
# FIRST line is the default lane; membership is grep -qxF. One validated source
# for both default-lane detection and the declared-ness check.
DEFAULT_LANE=""
if [ -n "$LANE" ]; then
  case "$LANE" in
    *[!A-Za-z0-9._-]*) echo "setup_worktree.sh: invalid --lane name: $LANE" >&2; exit 1 ;;
  esac
  [ "${#LANE}" -le 64 ] || { echo "setup_worktree.sh: --lane name too long (max 64): $LANE" >&2; exit 1; }
  if ! LANES_OUT="$(python3 "$ENGINE_HOME/lib/roles.py" lanes "$TARGET_REPO")"; then
    echo "setup_worktree.sh: refuse -- could not read lanes for $TARGET_REPO (malformed lanes: block?)" >&2
    exit 1
  fi
  DEFAULT_LANE="$(printf '%s\n' "$LANES_OUT" | head -1)"
  if ! printf '%s\n' "$LANES_OUT" | grep -qxF -- "$LANE"; then
    echo "setup_worktree.sh: refuse -- lane '$LANE' is not declared in $TARGET_REPO/.autonomy/config.yaml (declared: $(printf '%s' "$LANES_OUT" | tr '\n' ' '))" >&2
    exit 1
  fi
fi

# The __LABEL__ segment (legacy <slug> for default/empty lane, else <slug>.<lane>).
LABEL_MIDDLE="$(lane_label_middle "$SLUG" "$LANE" "$DEFAULT_LANE")"
LABEL="com.autonomy.${LABEL_MIDDLE}.supervisor"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# Worktree precedence: positional arg wins; else a NON-default lane uses its
# derived per-lane default (config lanes.<lane>.worktree is a deferred slice);
# else the default-lane resolution (positional/config/derived, unchanged today).
if [ -n "$ARG_WORKTREE" ]; then
  WORKTREE="$ARG_WORKTREE"
elif [ -n "$LANE" ] && [ "$LANE" != "$DEFAULT_LANE" ]; then
  WORKTREE="$(cd "$TARGET_REPO/.." && pwd)/$(lane_worktree_default "$SLUG" "$LANE" "$DEFAULT_LANE")"
else
  WORKTREE="$(resolve_worktree_path "")"
fi

echo "target repo   : $TARGET_REPO"
echo "repo-slug     : $SLUG"
echo "worktree      : $WORKTREE"
echo "launchd label : $LABEL"

if [ -f "$PLIST_DST" ]; then
  existing_repo="$(grep -A1 '<key>WorkingDirectory</key>' "$PLIST_DST" | tail -1 | sed -E 's#.*<string>(.*)</string>.*#\1#')"
  if [ -n "$existing_repo" ] && [ -d "$existing_repo" ] && [ "$existing_repo" != "$WORKTREE" ]; then
    echo "setup_worktree.sh: refuse -- label '$LABEL_MIDDLE' is already registered for a different worktree ($existing_repo). Set engine.label in $TARGET_REPO/.autonomy/config.yaml (or use a distinct --lane) to disambiguate." >&2
    exit 1
  fi
fi

[ "$WORKTREE" = "$TARGET_REPO" ] && { echo "setup_worktree.sh: refuse -- worktree path equals the target repo" >&2; exit 1; }

(cd "$TARGET_REPO" && git fetch origin -q)

if (cd "$TARGET_REPO" && git worktree list --porcelain | grep -Fxq "worktree $WORKTREE"); then
  echo "worktree already registered -- leaving as-is (persistent/loop-specific)."
else
  (cd "$TARGET_REPO" && git worktree add --detach "$WORKTREE" origin/main)
  echo "worktree created (detached @ origin/main)."
fi

mkdir -p "$WORKTREE/var/autonomy-logs"

render_plist "$ENGINE_HOME/templates/supervisor.plist.tmpl" \
  "$ENGINE_HOME" "$WORKTREE" "$LABEL_MIDDLE" "$LANE" > "$PLIST_DST"
echo "installed plist -> $PLIST_DST"

cat <<EOF

Next (operator) -- stop any supervisor bound to an OLD plist for this repo,
load this one (survives reboot via the plist's RunAtLoad):
  launchctl bootout   gui/\$(id -u)/$LABEL 2>/dev/null || true
  launchctl bootstrap gui/\$(id -u) "$PLIST_DST"
  launchctl list | grep "$LABEL_MIDDLE"
  tail -f "$WORKTREE/var/autonomy-logs/supervisor.log"
EOF
