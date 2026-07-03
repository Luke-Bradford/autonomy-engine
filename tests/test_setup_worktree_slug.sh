#!/usr/bin/env bash
# tests/test_setup_worktree_slug.sh
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

# --- WORKTREE path resolution (regression: an absent worktree.default_path must
#     NOT trip set -e and abort -- it should fall through to the derived default)
parent="$(cd "$tmp" && pwd)"

mkdir -p "$tmp/noWT/.autonomy"
TARGET_REPO="$tmp/noWT"; SLUG="nowt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
board:
  owner: someone
YAML
check "no worktree.default_path -> derived default (no crash)" "$parent/.nowt-autonomy" "$(resolve_worktree_path "")"

mkdir -p "$tmp/relWT/.autonomy"
TARGET_REPO="$tmp/relWT"; SLUG="relwt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<'YAML'
worktree:
  default_path: "../.{repo-slug}-autonomy"
YAML
check "relative default_path resolves vs parent, slug substituted" "$parent/.relwt-autonomy" "$(resolve_worktree_path "")"

mkdir -p "$tmp/absWT/.autonomy"
TARGET_REPO="$tmp/absWT"
# shellcheck disable=SC2034  # SLUG is read by the sourced resolve_worktree_path (unused only in the absolute-path branch)
SLUG="abswt"
cat > "$TARGET_REPO/.autonomy/config.yaml" <<YAML
worktree:
  default_path: "$tmp/custom-abs-wt"
YAML
check "absolute default_path used as-is" "$tmp/custom-abs-wt" "$(resolve_worktree_path "")"

check "positional arg wins over config + default" "/explicit/path" "$(resolve_worktree_path "/explicit/path")"

# --- lanes (#147 Part 2 per-lane plist): label segment + derived worktree ------
# lane_label_middle = the __LABEL__ segment; default/empty lane keeps the legacy
# <slug> (byte-identical to today), a non-default lane becomes <slug>.<lane>.
check "label middle: empty lane keeps legacy slug"        "eb" "$(lane_label_middle eb "" main)"
check "label middle: lane == default keeps legacy slug"   "eb" "$(lane_label_middle eb main main)"
check "label middle: non-default lane -> slug.lane"       "eb.fe" "$(lane_label_middle eb fe main)"

# lane_worktree_default: derived basename; default/empty unchanged, non-default
# gets a per-lane suffix so it never collides with the default worktree.
check "worktree default: empty lane unchanged"            ".eb-autonomy" "$(lane_worktree_default eb "" main)"
check "worktree default: lane == default unchanged"       ".eb-autonomy" "$(lane_worktree_default eb main main)"
check "worktree default: non-default lane suffixed"       ".eb-fe-autonomy" "$(lane_worktree_default eb fe main)"

# --- render_plist: line-by-line, byte-identical default, --lane appended -------
TMPL="$HERE/../templates/supervisor.plist.tmpl"

# Default lane (empty): identical to today's sed render (no --lane, legacy Label).
sed_ref="$(sed -e "s#__ENGINE_HOME__#/eng#g" -e "s#__REPO__#/wt#g" -e "s#__LABEL__#eb#g" "$TMPL")"
render_default="$(render_plist "$TMPL" /eng /wt eb "")"
check "render default == today's sed output (byte-identical)" "$sed_ref" "$render_default"
if printf '%s' "$render_default" | grep -q -- '--lane'; then
  echo "FAIL - default render must NOT contain --lane"; fails=$((fails + 1))
else echo "ok   - default render has no --lane"; fi

# Non-default lane: --lane <lane> appended after the repo arg; Label carries lane.
render_fe="$(render_plist "$TMPL" /eng /wt eb.fe fe)"
if printf '%s' "$render_fe" | grep -q '<string>com.autonomy.eb.fe.supervisor</string>'; then
  echo "ok   - non-default render Label is com.autonomy.eb.fe.supervisor"
else echo "FAIL - non-default render Label wrong"; fails=$((fails + 1)); fi
# The --lane arg + value must appear in the exact ProgramArguments order, right
# after the --repo value (and NOT after the WorkingDirectory line, which shares
# the same repo string). Collapse whitespace/newlines and match the sequence.
collapsed="$(printf '%s' "$render_fe" | tr -d ' \n')"
case "$collapsed" in
  *"<string>--repo</string><string>/wt</string><string>--lane</string><string>fe</string>"*)
    echo "ok   - --lane fe inserted directly after the repo arg" ;;
  *) echo "FAIL - --lane not in argv order after --repo"; fails=$((fails + 1)) ;;
esac
# ...and exactly once (WorkingDirectory's /wt must NOT trigger a second insert).
n_lane="$(printf '%s\n' "$render_fe" | grep -c -- '<string>--lane</string>')"
check "exactly one --lane arg emitted" "1" "$n_lane"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
