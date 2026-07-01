### Task 9: `setup_worktree.sh` + launchd plist template

**Files:**
- Create: `bin/setup_worktree.sh`
- Create: `templates/supervisor.plist.tmpl`
- Test: `tests/test_setup_worktree_slug.sh`

**Interfaces:**
- Consumes: `python3 lib/config_parser.py` (Task 2) for `engine.label`.
- Produces: CLI `bin/setup_worktree.sh <target-repo-path> [worktree-path]` — creates/reuses the
  target repo's dedicated worktree and installs its launchd plist. Defines `derive_slug()` as a
  testable function (given `$TARGET_REPO` in scope) — sourceable directly, per this plan's Global
  Constraint that every script's executable body is guarded by
  `[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0`.

- [ ] **Step 1: Write the failing test (sourcing the real script, not a copy)**

```bash
# tests/test_setup_worktree_slug.sh
#!/usr/bin/env bash
# Unit test for setup_worktree.sh's repo-slug derivation (engine.label override
# vs basename-derived default).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "$HERE/../bin/setup_worktree.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/eBull/.autonomy"
TARGET_REPO="$tmp/eBull"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "basename-derived slug, mixed case collapsed" "ebull" "$(derive_slug)"

mkdir -p "$tmp/My Weird Repo!/.autonomy"
TARGET_REPO="$tmp/My Weird Repo!"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "non-alphanumeric collapsed to single dashes" "my-weird-repo" "$(derive_slug)"

mkdir -p "$tmp/eBull2/.autonomy"
TARGET_REPO="$tmp/eBull2"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
engine:
  label: custom-label
YAML
check "engine.label overrides basename" "custom-label" "$(derive_slug)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
```

- [ ] **Step 2: Run to verify it fails**

```bash
chmod +x tests/test_setup_worktree_slug.sh
bash tests/test_setup_worktree_slug.sh
```
Expected: fails (`bin/setup_worktree.sh` doesn't exist yet).

- [ ] **Step 3: Implement `bin/setup_worktree.sh`** — functions defined unconditionally at the top
  (so sourcing exposes them), the executable body guarded exactly like every other script in this
  plan (`board.sh`, `safe_merge.sh`, `unblock_dependents.sh`)

```bash
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
```

- [ ] **Step 4: Create `templates/supervisor.plist.tmpl`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  launchd LaunchAgent for the autonomy SUPERVISOR. KeepAlive + RunAtLoad:
  starts on load and is restarted if it ever exits (crash, reboot, OOM). The
  supervisor itself loops sessions forever with usage-limit backoff, so
  launchd's only job is to keep ONE supervisor alive. Its internal lock
  prevents duplicates if launchd double-starts.

  __ENGINE_HOME__, __REPO__, __LABEL__ substituted by setup_worktree.sh.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.autonomy.__LABEL__.supervisor</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__ENGINE_HOME__/bin/supervisor.sh</string>
    <string>--repo</string>
    <string>__REPO__</string>
  </array>

  <key>WorkingDirectory</key>
  <string>__REPO__</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>__REPO__/var/autonomy-logs/launchd.supervisor.out.log</string>
  <key>StandardErrorPath</key>
  <string>__REPO__/var/autonomy-logs/launchd.supervisor.err.log</string>
</dict>
</plist>
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bash tests/test_setup_worktree_slug.sh
```
Expected: `ALL PASS`.

- [ ] **Step 6: shellcheck**

```bash
shellcheck -S warning bin/setup_worktree.sh
```
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add bin/setup_worktree.sh templates/supervisor.plist.tmpl tests/test_setup_worktree_slug.sh
git commit -m "feat: add generic setup_worktree.sh (label override + collision guard) and plist template"
git push
```

---

