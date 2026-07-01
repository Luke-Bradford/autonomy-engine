#!/usr/bin/env bash
# bin/setup_worktree.sh -- create (idempotently) a dedicated git worktree for
# a target repo's autonomy loop, and install its launchd plist pointed at this
# engine + that worktree.
#
# Usage: setup_worktree.sh <target-repo-path> [worktree-path]
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

[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

TARGET="${1:?usage: setup_worktree.sh <target-repo-path> [worktree-path]}"
case "$TARGET" in
  http://*|https://*|git@*)
    echo "setup_worktree.sh: pass a local path to an existing checkout, not a URL ($TARGET)" >&2
    exit 1
    ;;
esac
TARGET_REPO="$(cd "$TARGET" && pwd)"

SLUG="$(derive_slug)"
[ -n "$SLUG" ] || { echo "setup_worktree.sh: could not derive a repo-slug for $TARGET_REPO" >&2; exit 1; }

WORKTREE="${2:-$(cd "$TARGET_REPO/.." && pwd)/.${SLUG}-autonomy}"
LABEL="com.autonomy.${SLUG}.supervisor"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "target repo   : $TARGET_REPO"
echo "repo-slug     : $SLUG"
echo "worktree      : $WORKTREE"
echo "launchd label : $LABEL"

if [ -f "$PLIST_DST" ]; then
  existing_repo="$(grep -A1 '<key>WorkingDirectory</key>' "$PLIST_DST" | tail -1 | sed -E 's#.*<string>(.*)</string>.*#\1#')"
  if [ -n "$existing_repo" ] && [ -d "$existing_repo" ] && [ "$existing_repo" != "$WORKTREE" ]; then
    echo "setup_worktree.sh: refuse -- label '$SLUG' is already registered for a different worktree ($existing_repo). Set engine.label in $TARGET_REPO/.autonomy/config.yaml to disambiguate." >&2
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

sed -e "s#__ENGINE_HOME__#$ENGINE_HOME#g" -e "s#__REPO__#$WORKTREE#g" -e "s#__LABEL__#$SLUG#g" \
  "$ENGINE_HOME/templates/supervisor.plist.tmpl" > "$PLIST_DST"
echo "installed plist -> $PLIST_DST"

cat <<EOF

Next (operator) -- stop any supervisor bound to an OLD plist for this repo,
load this one (survives reboot via the plist's RunAtLoad):
  launchctl bootout   gui/\$(id -u)/$LABEL 2>/dev/null || true
  launchctl bootstrap gui/\$(id -u) "$PLIST_DST"
  launchctl list | grep "$SLUG"
  tail -f "$WORKTREE/var/autonomy-logs/supervisor.log"
EOF
