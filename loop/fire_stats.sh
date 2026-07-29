#!/bin/bash
# fire_stats.sh -- per-fire telemetry for the studio build loop. ZERO tokens: it
# only parses logs that fires already wrote.
#
# Why this exists: the 2026-07-25 quota incident was diagnosed by hand-parsing
# fire logs, and the finding was counter-intuitive (cost is ROUND-TRIPS x context,
# not model or effort -- output tokens were 0.008% of spend). That analysis should
# not have to be re-derived, so it lives here.
#
#   ./fire_stats.sh              # last 15 fires, table
#   ./fire_stats.sh 40           # last 40 fires
#   ./fire_stats.sh 40 --jsonl   # machine-readable, one record per fire
#
# Columns: cost · wall minutes · tool calls · browser calls (the cost driver) ·
# cache-read tokens (what you actually pay for) · output tokens (nearly free).
set -uo pipefail
INFRA="${INFRA:-$(cd "$(dirname "$0")" && pwd)}"
N="${1:-15}"
case "${2:-}" in --jsonl) MODE=jsonl ;; *) MODE=table ;; esac

cd "$INFRA/logs" 2>/dev/null || { echo "no logs dir at $INFRA/logs" >&2; exit 1; }

# shellcheck disable=SC2012  # ls -t is the intent (newest first); names are fixed-format
FILES="$(ls -t fire.*.log 2>/dev/null | head -"$N" | tr '\n' ' ')"
[ -n "$FILES" ] || { echo "no fire logs found" >&2; exit 1; }

MODE="$MODE" python3 - $FILES <<'EOF'
import json, os, sys

mode = os.environ.get("MODE", "table")
rows = []
for path in sys.argv[1:]:
    tin = tout = cr = cw = 0
    cost = 0.0
    dur = 0
    tools = {}
    with open(path, errors="ignore") as fh:
        for line in fh:
            if '"usage"' in line and '"type":"assistant"' in line:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                u = d.get("message", {}).get("usage", {}) or {}
                tin += u.get("input_tokens", 0) or 0
                tout += u.get("output_tokens", 0) or 0
                cr += u.get("cache_read_input_tokens", 0) or 0
                cw += u.get("cache_creation_input_tokens", 0) or 0
                for c in d.get("message", {}).get("content", []) or []:
                    if isinstance(c, dict) and c.get("type") == "tool_use":
                        n = c.get("name", "?")
                        tools[n] = tools.get(n, 0) + 1
            elif '"type":"result"' in line and '"total_cost_usd"' in line:
                try:
                    d = json.loads(line)
                    cost = d.get("total_cost_usd") or 0.0
                    dur = d.get("duration_ms") or 0
                except Exception:
                    pass
    calls = sum(tools.values())
    browser = sum(v for k, v in tools.items() if "browser" in k or "playwright" in k)
    total = tin + tout + cr + cw
    rows.append({
        "fire": os.path.basename(path)[5:18],
        "cost_usd": round(cost, 2),
        "wall_min": round(dur / 60000.0, 1),
        "tool_calls": calls,
        "browser_calls": browser,
        "cache_read": cr,
        "output_tokens": tout,
        "total_tokens": total,
        "eff_usd_per_mtok": round(cost / total * 1e6, 2) if total else 0,
        "top_tools": sorted(tools.items(), key=lambda x: -x[1])[:3],
    })

rows.reverse()   # oldest first, so a trend reads left-to-right down the page

if mode == "jsonl":
    for r in rows:
        print(json.dumps(r))
    raise SystemExit

print(f"{'fire':<14}{'cost':>8}{'min':>6}{'calls':>7}{'browser':>9}{'cacheR':>13}{'out':>8}  top tools")
print("-" * 96)
for r in rows:
    top = ", ".join(f"{k.replace('mcp__playwright__','pw:')}={v}" for k, v in r["top_tools"])
    print(f"{r['fire']:<14}${r['cost_usd']:>7.2f}{r['wall_min']:>6.0f}"
          f"{r['tool_calls']:>7}{r['browser_calls']:>9}{r['cache_read']:>13,}"
          f"{r['output_tokens']:>8,}  {top}")

if rows:
    n = len(rows)
    tc = sum(r["cost_usd"] for r in rows)
    print("-" * 96)
    print(f"{n} fires  total ${tc:.2f}  avg ${tc/n:.2f}/fire  "
          f"avg {sum(r['tool_calls'] for r in rows)/n:.0f} calls  "
          f"avg {sum(r['browser_calls'] for r in rows)/n:.0f} browser  "
          f"output = {sum(r['output_tokens'] for r in rows)/max(1,sum(r['total_tokens'] for r in rows))*100:.3f}% of tokens")
    worst = max(rows, key=lambda r: r["cost_usd"])
    print(f"most expensive: {worst['fire']} ${worst['cost_usd']:.2f} "
          f"({worst['tool_calls']} calls, {worst['browser_calls']} browser)")
EOF
