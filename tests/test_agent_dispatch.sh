#!/usr/bin/env bash
# Unit test for supervisor.sh's config precedence (CLI override > config.yaml
# > hardcoded default) and that the correct adapter file exists per agent.type.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../bin/supervisor.sh"
SUPLOG=/dev/null
log() { :; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cfg="$tmp/config.yaml"
cat > "$cfg" <<'YAML'
agent:
  type: claude
  model:
    primary: claude-sonnet-5
    fallback: claude-sonnet-4-6
YAML

check "CLI override wins over config" "codex" "$(resolve_config_value "$cfg" agent.type "codex" claude)"
check "config wins over hardcoded default" "claude" "$(resolve_config_value "$cfg" agent.type "" opus)"
check "hardcoded default wins when key absent" "claude-opus-4-8" "$(resolve_config_value "$cfg" agent.model.does_not_exist "" claude-opus-4-8)"
check "claude adapter file exists" "0" "$([ -f "$HERE/../bin/agents/claude.sh" ] && echo 0 || echo 1)"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails CHECK(S) FAILED"; exit 1; fi
