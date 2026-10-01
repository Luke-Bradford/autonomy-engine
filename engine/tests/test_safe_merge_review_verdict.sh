#!/usr/bin/env bash
# review_verdict classifies a bot review by STRUCTURE (a [BLOCKING] header, the Verdict
# section's bold token), never by words quoted elsewhere. eBull PR #3554 (2026-10-01): a
# round-2 APPROVE whose "Prior findings" note quoted the old grep pattern was refused.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2', got '$3')"; fails=$((fails + 1)); fi
}
v() { printf '%b' "$1" | review_verdict; }

check "real #3554 round-2: quotes REQUEST CHANGES|[BLOCKING] in Prior findings, Verdict APPROVE -> approve" \
  "approve" "$(review_verdict < "$HERE/fixtures/review_prior_findings_quotes_gate.md")"
check "[BLOCKING] header -> block" "block" \
  "$(v '## Claude Code Review\n\n### [BLOCKING] — must fix before merge\n`a.py:1` — x.\n\n### Verdict\n**REQUEST CHANGES** — fix it.')"
check "[BLOCKING] header beats an APPROVE verdict (contradiction fails closed)" "block" \
  "$(v '### [BLOCKING]\n`a.py:1` — x.\n### Verdict\n**APPROVE**')"
check "Verdict REQUEST CHANGES without a blocking header -> block" "block" \
  "$(v '### [WARNING]\n`a.py:1` — x.\n### Verdict\n**REQUEST CHANGES** — warnings must be fixed.')"
check "APPROVE verdict whose sentence mentions an earlier REQUEST CHANGES -> approve" "approve" \
  "$(v '### [WARNING] — should fix\n`a.py:1` — x.\n### Verdict\n**APPROVE** — the earlier REQUEST CHANGES items are resolved.')"
check "NEEDS DISCUSSION -> none (not mergeable)" "none" \
  "$(v '### Verdict\n**NEEDS DISCUSSION** — design question.')"
check "no Verdict section -> none" "none" "$(v '### [WARNING]\n`a.py:1` — x.')"
check "doc-only skip notice -> none (doc path treats as non-blocking)" "none" \
  "$(v '## Claude Code Review\n\nDoc-only diff — engineering review skipped to save tokens.')"
check "inline 'Verdict: **APPROVE**' with no header (eBull #3342 form) -> approve" "approve" \
  "$(v '## Claude Code Review\n\nVerdict: **APPROVE**')"
check "inline 'Verdict: **REQUEST CHANGES**' -> block" "block" "$(v 'Verdict: **REQUEST CHANGES** — x.')"
check "prose starting 'Verdict only —' is not the marker; the later heading is (eBull #3345)" "approve" \
  "$(v 'Verdict only — the incremental change is fine.\n\n### Verdict\n**APPROVE**')"
check "the LAST marker wins over an earlier one" "block" \
  "$(v '### Verdict\n**APPROVE**\n\n### Verdict\n**REQUEST CHANGES**')"
check "unbolded APPROVE in Verdict -> approve" "approve" "$(v '### Verdict\nAPPROVE — fine.')"
check "'not APPROVE' prose outside Verdict, Verdict REQUEST CHANGES -> block" "block" \
  "$(v 'This is not APPROVE material.\n### Verdict\n**REQUEST CHANGES**')"
check "APPROVE mentioned only outside the Verdict section -> none" "none" \
  "$(v 'Would APPROVE once fixed.\n### Verdict\nPending author reply.')"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
