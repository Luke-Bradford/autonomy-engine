#!/usr/bin/env bash
# loop/prompt.md must name exactly ONE home for the build order.
#
# WHY THIS EXISTS
# ---------------
# PR #921 took SEVEN review rounds. Every finding was the same defect: the build
# order was written in two places, so each repair to one let the other drift.
# Round six said "I stopped fixing instances and fixed the class" — and shipped
# an eighth instance in the same edit, because a document with two candidate
# homes for ordering cannot be patched into consistency, only re-owned.
#
# A review bot caught six of the eight. It is not a gate: it reports, a human
# reads, and the eighth got through anyway. This is the gate.
#
# The rule the file now holds:
#   * "THE QUEUE" under CURRENT PRIORITY is the ONLY ordering.
#   * The CUTOVER block owns WHY and the constraints, and says so.
#   * "## WORK ORDER" is dependency BACKGROUND, not a second queue.
# Every other section points at THE QUEUE rather than restating a sequence.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="$HERE/../loop/prompt.md"

fails=0

if [ ! -f "$PROMPT" ]; then
  echo "FAIL - loop/prompt.md not found at $PROMPT"
  exit 1
fi

# --- banned pointers -------------------------------------------------------
# Each phrase sent the reader somewhere other than THE QUEUE for the order.
# The round that produced it is named so a future editor can see this is a
# recurrence, not a style preference.
banned() {
  local pattern="$1" why="$2" hits
  hits=$(grep -inE "$pattern" "$PROMPT" | head -3)
  if [ -n "$hits" ]; then
    echo "FAIL - $why"
    printf '%s\n' "$hits" | sed 's/^/         /'
    fails=$((fails + 1))
  else
    echo "ok   - no '$why'"
  fi
}

banned 'for the sequence'                'pointer sending the reader elsewhere "for the sequence" (round 7)'
banned 'owns how and when'               'a non-QUEUE section claiming "when" (round 7, unflagged instance)'
banned 'NEXT ITEM *='                    'a second declaration of what is next (rounds 2-5)'
banned 'build it first'                  'an inline ordering assertion outside THE QUEUE (rounds 2-5)'
banned 'see the (CUTOVER|WORK ORDER)[^.]*(sequence|ordering)' \
                                         'a cross-reference pointing at a section for the ordering (round 6)'
# ⚠ Instance NINE, and this test did not catch it — Codex did, on the very
# commit that added the test. The specs paragraph said the overview's ordered
# list "IS your queue", which is a THIRD home for the order and reads as
# authoritative because it sits next to the spec map. A guard written from the
# findings it has seen only covers the phrasings it has seen; this one widens to
# the CLAIM ("X is the/your queue") rather than any particular sentence.
banned '(is|IS) (your|the) queue'        'another section claiming to BE the queue (round 8, found by Codex)'

# --- required ownership statements ------------------------------------------
# The positive half. Deleting the pointers is not enough — the file has to SAY
# which section owns the order, or the next editor re-invents a second one.
require() {
  local pattern="$1" what="$2"
  if grep -qiE "$pattern" "$PROMPT"; then
    echo "ok   - $what"
  else
    echo "FAIL - missing: $what"
    fails=$((fails + 1))
  fi
}

require 'THE QUEUE.*ONLY ORDERING'          'THE QUEUE declares itself the only ordering'
require 'this block owns WHY.*queue owns WHEN' 'the CUTOVER block disclaims WHEN'
require 'WORK ORDER.*(BACKGROUND|not a second queue)' \
                                                 'WORK ORDER is labelled background, not a queue'

if [ "$fails" -eq 0 ]; then
  echo "PASS - loop/prompt.md has exactly one home for the build order"
  exit 0
fi
echo "FAILED - $fails ordering-ownership violation(s) in loop/prompt.md"
exit 1
