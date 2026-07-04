# Plan — #189 UI-6: needs-you triaged question render

Slice: parse + render the PM-triaged escalation question. Degraded untriaged
card already shipped (#235). Schema PINNED by SD-32 §8 (design-blockers doc).

## Contract (SD-32 §8, verbatim keys)

An escalating role posts ONE issue comment with a fenced ```` ```autonomy-question ````
JSON block containing exactly: `question` (str) · `recommendation` (str) ·
`reasoning_quote` (str) · `effort_sunk` (str) · `default_if_ignored` (str) ·
`answers` (array ≤3 of chip strings). Absence/garbage → shipped untriaged card.

## Tasks

1. **`lib/dashboard_state.py` — `parse_autonomy_question(comments)`** (pure, total).
   - Input: the issue's `comments` list (dicts with `body`, `createdAt`).
   - **The newest comment CONTAINING an `autonomy-question` fence is authoritative**
     (scan newest-first by `createdAt`; a later prose-only comment does NOT mask
     an earlier question). Validate ONLY that block — if it is garbage, return
     `None`; NEVER fall back to an older valid block (fail-safe: the latest
     escalation stands or degrades, per SD-32 "absence/garbage → untriaged").
   - Strict schema: `json.loads` the block, require an object with **EXACTLY**
     the six pinned keys — no more, no fewer. Five strings (`question`,
     `recommendation`, `reasoning_quote`, `effort_sunk`, `default_if_ignored`);
     `answers` a list whose length is 1–3 and every element a string. ANY
     deviation (extra/missing key, wrong type, `len(answers) > 3` or a non-string
     answer) → `None`. No truncation, no dropping (that would be fail-open).
   - Fail-safe: any bad input (None / non-list / no fence / bad json / non-object
     / schema mismatch) → `None`. Never raises.
   - Fence match: stdlib `re`, tolerant of CRLF, trailing whitespace after the
     ` ```autonomy-question ` info string, and leading prose garnish. If a single
     comment holds multiple such fences, the FIRST in that (newest) comment wins.

2. **`parse_needs_you`** — attach `question`: for each kept issue, set
   `entry["question"] = parse_autonomy_question(it.get("comments"))` (dict or None).
   Existing untriaged fields unchanged (backward-compatible).

3. **`bin/dashboard.py` `_needs_you_raw`** — add `comments` to the `--json`
   field list. One gh call, no N+1. Timeout unchanged.

4. **`lib/dashboard_page.html` `renderNeedsYou`** — when `i.question` present,
   render the TRIAGED card: question headline · recommendation (with
   `reasoning_quote` quoted) · effort sunk · default-if-ignored · answer chips
   (non-interactive labels — post-back is a follow-on, no fake buttons) ·
   `discuss ↗` real link to the issue. Card tagged `triaged`. Absent → current
   untriaged row unchanged.

## Non-goals (this slice)

- Answer post-back as an issue comment + merge-affecting confirm dialogs
  (interactive; needs a new control endpoint) — a follow-on, noted on #189.
  Chips render as honest option display + a real discuss link, NOT live buttons
  (respects the #177 "no fake motion" non-goal).

## Tests (TDD, real functions sourced)

- `parse_autonomy_question`: valid block → dict; newest-question-of-two wins;
  newest block malformed + older valid → None (no fall-back); missing key → None;
  EXTRA key → None; bad json → None; `len(answers) > 3` → None; non-str answer
  → None; no fence → None; None/[]/non-list → None; prose-garnish-around-fence
  → dict; CRLF / trailing-space info-string → dict; later prose-only comment
  does not mask an earlier valid question.
- `parse_needs_you`: issue with valid block → entry has `question` dict; issue
  without → `question` is None; malformed comments → None (no raise).

## Invariants respected

Repo-agnostic (labels stay `NEEDS_YOU_LABELS`, no owner interp). Display-only,
best-effort — never gates a merge, degrades to [] / untriaged on any gh failure.
Fail-safe filter unchanged (int number + needs-design label still required).
