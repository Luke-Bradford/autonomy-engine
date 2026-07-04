# Plan — #172: doctor gh-scopes + review-bot-secret checks; README replication matrix

## Goal
A fresh user/machine can tell whether they have what the engine needs, from
`doctor.sh` (diagnostic-only) + a README prerequisites matrix. Two concrete gaps
today: (1) `doctor.sh` checks `gh auth status` ok but NOT that the token carries
the `project` scope (Projects v2 sync dies silently without it — default
`gh auth login` often omits it); (2) `merge_gate.strategy=bot_comment` needs the
`ANTHROPIC_API_KEY` secret in the target repo, which doctor never checks.

## Deliverables
- (a) doctor.sh: gh token-scope check + review-bot-secret check.
- (b) README "Prerequisites / replicating on a new machine" matrix.
- (c) quickstart already runs `doctor.sh` verbatim (step 3/6), so the new checks
  surface at onboarding for free — no quickstart change; note it in the PR.

## Design (bash 3.2, shellcheck-clean, diagnostic-only)
Factor pure parsers so tests feed canned text (no network); test the impure
wrappers with a `gh` shell-function PATH stub (the sanctioned mock seam).

- `doctor_gh_scopes <status_text>` — pure. Echo the space-separated scope tokens
  MERGED from EVERY `Token scopes: 'a', 'b', …` line of `gh auth status` output
  (strip quotes, commas→spaces). Empty when no such line. Merging all lines
  tolerates multi-host/multi-account output; it is an optimistic union (a
  diagnostic HINT, not a gate — documented), so it never fails a real user over
  a second unrelated account.
- `doctor_gh_scopes_report <scopes>` — pure, TIERED by real runtime need:
  - `repo` missing → WARN (core: branch push + PR + API all need it) +
    `gh auth refresh -s repo`.
  - `project` missing → WARN (Projects v2 board sync dies silently) +
    `gh auth refresh -s project`.
  - `workflow` missing → INFO note only — the loop never pushes `.github/
    workflows/**` (guardrail-barred), so it is needed ONLY to install/update the
    review workflow during setup, not at runtime. INFO avoids a false WARN.
  - all present → one OK. Empty scopes string → a single WARN that scopes
    couldn't be read (never silently pass).
- `doctor_gh_auth_check <repo>` — impure wrapper replacing the inline block
  (doctor.sh:150-154). `out="$(cd "$repo" && gh auth status 2>&1)"` (capture
  BOTH streams — gh prints to either depending on version); rc≠0 → WARN as today
  and return; rc 0 → OK + `doctor_gh_scopes_report "$(doctor_gh_scopes "$out")"`.
- `doctor_secret_present <secret_list_text> <name>` — pure. rc 0 iff `name`
  appears as a whole first-column token (tab/space-delimited); a substring like
  `ANTHROPIC_API_KEY_OLD` must NOT match a bare `ANTHROPIC_API_KEY` query.
- `doctor_review_secret_check <repo>` — best-effort. Called ONLY from the
  existing `bot_comment` branch where the review workflow WAS found (so no noise
  when the earlier "add a workflow" WARN already fired). First `gh auth status`
  quietly in `$repo`: if NOT authed, return silently (the auth WARN already
  covers it — no contradictory hint). If authed: `secrets="$(cd "$repo" && gh
  secret list 2>/dev/null)"`; command failed (admin-only endpoint) → INFO HINT
  ("couldn't verify secrets — needs admin; ensure ANTHROPIC_API_KEY is set"),
  NOT a WARN; present → OK; authed + readable + absent → WARN (real: the bot
  never posts an APPROVE).

## Invariants respected
- **Doctor stays diagnostic-only:** OK/WARN/INFO only, never FAIL, never touch
  `hard_fail`, never provision.
- **Best-effort / fail-safe (settled-decision 6 posture):** a `gh` failure or an
  admin-only endpoint degrades to a hint, never a false WARN; a genuinely missing
  `repo`/`project` scope or an absent secret WARNs (actionable, not fabricated).
  `workflow` (setup-only) is INFO, not WARN — no false alarm at runtime.
- **Target-repo correctness:** every `gh` call runs in `$repo` (`cd "$repo"`), so
  `doctor.sh /path/to/target` inspects the TARGET repo's auth/secrets, not the
  engine repo's.
- **bash 3.2:** `sed`/`tr`/`case`/`for` only — no mapfile/globstar/assoc arrays.
- **Repo-agnostic:** no target-repo owner/board/issue VALUES hardcoded.
  `ANTHROPIC_API_KEY` is a fixed conventional secret NAME the review workflow
  reads (already referenced at doctor.sh:123 + claude-review.yml) — the same name
  for every repo; the CHECK targets the given repo. A name convention, not a
  target-specific value.
- **Source-guard** on doctor.sh already present; untouched.

## Tests (`tests/test_doctor.sh`, sources doctor.sh, real functions)
Pure (canned text):
- `doctor_gh_scopes`: real single-host status text → correct token list;
  multi-host text with two `Token scopes:` lines → merged union; no-scopes text
  → "".
- `doctor_gh_scopes_report`: all present → OK, no WARN, no INFO; `repo` missing →
  WARN + `refresh -s repo`; `project` missing → WARN + `refresh -s project`;
  `workflow` missing → INFO (NOT WARN); empty → the couldn't-read WARN.
- `doctor_secret_present`: present (tab-delimited real `gh secret list` shape) →
  0; absent → 1; substring-only `ANTHROPIC_API_KEY_OLD` does NOT match a bare
  `ANTHROPIC_API_KEY` query, and vice-versa (whole-token).
Impure (PATH `gh` shell-function stub):
- `doctor_gh_auth_check`: stub `gh auth status` → 0 + a scopes line → OK + scope
  report captured via `2>&1`; stub → rc 1 → the auth WARN, no scope report.
- `doctor_review_secret_check`: stub not-authed → silent; authed + secret listed
  → OK; authed + list empty → WARN; authed + `gh secret list` rc≠0 → INFO hint.

## README (b)
A matrix under a new "## Prerequisites / replicating on a new machine": rows =
core loop / board sync / review-gate (bot_comment) / gh_review gate / local-LLM
roles / codex roles; columns = what's required (gh scopes, claude login, secret,
branch protection, CLI, macOS runtime) + how doctor reports it. Plainly state the
macOS + bash-3.2 + Python-3-stdlib host floor.
