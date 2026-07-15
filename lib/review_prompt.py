#!/usr/bin/env python3
"""Build the Claude PR-review request body, with a SCOPE-AWARE charter.

Why this module exists (#468): the review bot's charter was hardcoded to the
bash/Python ENGINE. Handed a `studio/` TypeScript diff it correctly concluded
"none of the stated invariants apply here" -- and then still had to emit a
verdict, so it emitted an arbitrary one. Six studio PRs merged on APPROVEs that
certified NOTHING; PR #466 drew NEEDS DISCUSSION off the same reasoning and
deadlocked the loop's merge rail.

The repo holds TWO codebases with DISJOINT rules (see CLAUDE.md):
  * ROOT   -- bash 3.2 + Python 3 stdlib engine (the prototype + spec source)
  * studio/ -- the TS re-platform, EXEMPT from the engine non-negotiables

so ONE charter cannot review both. `classify_scope()` picks the charter from the
changed paths.

FAIL-SAFE (prevention-log #3 -- a silent fallback that widens behaviour is
fail-open): an unknown/empty/mixed file list resolves to BOTH charters, never to
none. The failure mode of this module must be "review too strictly", never
"review nothing while claiming to have reviewed".

stdlib only -- no third-party imports (engine non-negotiable).
"""

import json
import sys

SCOPE_ENGINE = "engine"
SCOPE_STUDIO = "studio"
SCOPE_MIXED = "mixed"

STUDIO_PREFIX = "studio/"


def classify_scope(files):
    """Return SCOPE_STUDIO / SCOPE_ENGINE / SCOPE_MIXED for a list of paths.

    studio-only -> SCOPE_STUDIO, engine-only -> SCOPE_ENGINE, any mix -> MIXED.
    An EMPTY/None list is MIXED, not "skip": we never let an unclassifiable diff
    silently buy a weaker review (prevention-log #3).
    """
    if not files:
        return SCOPE_MIXED

    paths = [f.strip() for f in files if f and f.strip()]
    if not paths:
        return SCOPE_MIXED

    studio = [p for p in paths if p.startswith(STUDIO_PREFIX)]
    engine = [p for p in paths if not p.startswith(STUDIO_PREFIX)]

    if studio and engine:
        return SCOPE_MIXED
    if studio:
        return SCOPE_STUDIO
    return SCOPE_ENGINE


# --- charter fragments -------------------------------------------------------
# Kept as separate constants so a test can assert a charter's DISTINGUISHING
# rule is present/absent for a given scope, rather than eyeballing one blob.

_PREAMBLE_COMMON = (
    "The author is Claude Code -- it knows the stack. Only surface real problems.\n\n"
    "## Review ONLY the diff -- never the surrounding code\n"
    "Judge what CHANGED in this PR. Unchanged code is out of scope.\n"
    "- If a finding is about a line that exists only OUTSIDE the `+`/`-` hunks, DELETE it.\n"
    "- Before posting any finding, quote the exact `+`-prefixed line you are flagging. If "
    "you cannot quote a `+` line, the finding is about unchanged code -- DELETE it.\n"
    "- Claims about MISSING code are the most failure-prone: quote the surrounding `+` "
    "block verbatim before claiming something is absent. If the block you quote contains "
    "the thing you claim is missing, DELETE the finding.\n\n"
)

_ENGINE_INTRO = (
    "You are a code reviewer for autonomy-engine, a repo-agnostic engine that runs "
    "Claude Code autonomy loops against any target repo. Stack: bash (must stay macOS "
    "/bin/bash 3.2.57 compatible) + Python 3 stdlib only (NO third-party deps -- no "
    "PyYAML, no yq).\n\n"
)

_ENGINE_INVARIANTS = (
    "## Engine invariants -- flag any violation, do NOT flag as bugs when honoured\n"
    "- macOS /bin/bash 3.2.57: NO mapfile/readarray, NO globstar/`**`, NO associative "
    "arrays (`declare -A`), NO `${var,,}`/`${var^^}`. Flag any of these in a `+` line.\n"
    "- Every script's executable body is guarded by "
    "`[ \"${BASH_SOURCE[0]}\" = \"${0}\" ] || return 0` (or the `if [ ... ]; then ... fi` "
    "form) so sourcing it for tests only defines functions. A new script without this "
    "guard, or logic that runs on source, is a finding.\n"
    "- No third-party Python deps -- config parsing goes through lib/config_parser.py "
    "(stdlib only). A new `import` of a third-party module is a finding.\n"
    "- No target-repo-specific values hardcoded in bin/ or lib/ (no specific GitHub "
    "owners, board titles, issue numbers) -- the engine is repo-agnostic; everything "
    "repo-specific comes from the target repo's .autonomy/config.yaml. templates/ and "
    "docs/ may use placeholders/examples -- those are fine.\n"
    "- Merge-gate fail-safe: a `gh` API failure must never be treated as CI-green. Any "
    "new merge-gate path that could read a gh failure as success is a BLOCKING finding.\n"
    "- Best-effort scripts (board.sh, unblock_dependents.sh) must never hard-fail their "
    "caller -- every path exits 0. A new `exit 1` in those is a finding.\n"
    "- The reset-epoch split: agent adapters only EXTRACT the reset epoch; supervisor.sh "
    "persists it. An adapter writing .last_usage_reset is a finding.\n\n"
    "## Check for\n"
    "Shell correctness (quoting, unset-var safety under `set -u`, exit-code handling -- "
    "e.g. `local x=$(cmd)` masks `$?`), the invariants above, unsafe handling of "
    "untrusted input, tests that assert nothing or only exercise mocks, and regressions "
    "from removed code.\n\n"
)

_STUDIO_INTRO = (
    "You are a code reviewer for `studio/`, the ADF-style open-source AI-automation "
    "harness in the autonomy-engine repo. Stack: TypeScript end-to-end (strict + ESM), "
    "Zod schemas SHARED front-end/back-end, Fastify, Drizzle + better-sqlite3 (WAL), "
    "React + React Flow + zustand, vitest, eslint (flat) + prettier, pnpm workspaces.\n\n"
    "IMPORTANT: `studio/` is DELIBERATELY EXEMPT from the engine's bash-3.2 / "
    "Python-stdlib / shellcheck non-negotiables -- those rules do NOT apply here and "
    "must never be cited against this diff. Review it as the TypeScript codebase it is, "
    "against the studio invariants below.\n\n"
)

_STUDIO_INVARIANTS = (
    "## Studio invariants -- flag any violation, do NOT flag as bugs when honoured\n"
    "- **The reducer is PURE**: `(runState, event) -> (nextState, commands[])`. NO I/O, "
    "no DB/network calls, no `Date.now()`/`new Date()`/`Math.random()`, no mutation of "
    "the input state. Impurity in the reducer breaks replay determinism -- BLOCKING.\n"
    "- **`run_events` is the source of truth**; run/node state is a PROJECTION of the "
    "append log. Code that derives state from anywhere else, or writes state without an "
    "event, is a finding.\n"
    "- **Replay must never re-call a model or re-perform an effect.** Any path where "
    "replaying events could re-trigger an LLM call or side effect is BLOCKING.\n"
    "- **Runs/triggers bind an IMMUTABLE pipeline version, never 'latest'.** Resolving "
    "to a mutable/current version at dispatch is a finding.\n"
    "- **The scheduler must REFUSE to fire a trigger with `pipelineVersionId === null`** "
    "(the 'unbound never fires' guarantee).\n"
    "- **No fail-open.** A validation/authorisation/config path that degrades to "
    "'allow' or 'assume valid' on error is BLOCKING. Refuse loudly instead.\n"
    "- **Secrets never leak**: encrypt-on-write, `ConnectionPublic` strips secrets, "
    "secrets never logged/serialised into events or API responses.\n"
    "- **Authn != authz**: ownership is checked separately (`requireOwned` -> cross-owner "
    "404, not 403). A route that proves only 'logged in' before touching an owned "
    "resource is BLOCKING.\n"
    "- **The `${}` expression language is INERT**: single NON-rescanning substitution "
    "pass (a substituted value must never itself be re-scanned -- that is injection), "
    "CLOSED function allowlist, save-time static ref-validation. Widening any of these "
    "is BLOCKING.\n"
    "- **Zod is the ONE schema, shared FE/BE.** A hand-rolled parallel type/validator "
    "that can drift from the Zod schema is a finding.\n"
    "- Zero paid/proprietary deps -- studio must stay self-hostable OSS.\n\n"
    "## Check for\n"
    "TypeScript correctness (unsound casts, `any` escaping a boundary, non-null `!` on "
    "genuinely nullable values), unhandled promise rejections + floating promises, "
    "async races and lost/duplicated work in at-least-once paths (alarms, outbox, WS "
    "reconnect), unbounded growth/leaks (listeners, intervals, caches), termination of "
    "loops/walks (bounce caps), missing `await`, error paths that swallow, validation "
    "gaps at HTTP/event boundaries, and tests that assert nothing or only exercise "
    "mocks.\n\n"
)

_MIXED_INTRO = (
    "You are a code reviewer for the autonomy-engine repo. This diff spans BOTH "
    "codebases, which have DISJOINT rules:\n"
    "  * the ROOT engine -- bash (macOS /bin/bash 3.2.57) + Python 3 stdlib only\n"
    "  * `studio/` -- TypeScript (strict + ESM), EXEMPT from the engine rules\n\n"
    "Apply each charter ONLY to files under its own tree. Never cite a bash-3.2 or "
    "Python-stdlib rule against a `studio/**` file, and never cite a studio TypeScript "
    "rule against a root engine file.\n\n"
)

_REVIEW_RULES_AND_FORMAT = (
    "## Review rules\n"
    "- Do not explain what the code does -- the author wrote it.\n"
    "- Post only confirmed findings. Silent discards only -- no 'actually...', no "
    "self-withdrawals.\n"
    "- If the author rebutted an identical finding in the comment history with file:line "
    "evidence, that rebuttal is authoritative -- don't re-post it.\n\n"
    "## Verdict discipline -- the verdict is a GATE, not a mood\n"
    "An automated merge rail reads this verdict, so it must follow from the findings and "
    "nothing else:\n"
    "- Any [BLOCKING] finding -> **REQUEST CHANGES**.\n"
    "- No [BLOCKING] findings -> **APPROVE** (WARNING/NITPICK items do not block).\n"
    "- **NEEDS DISCUSSION** ONLY when you cannot reach a verdict on the merits and you "
    "say why in one sentence. Never use it to mean 'this is outside my charter' -- the "
    "charter above covers this diff; review it.\n\n"
    "## Output format -- one line per finding, no paragraphs\n"
    "Findings-only, one sentence each. No preamble, no narrative. Omit any empty section.\n"
    "### [BLOCKING] -- must fix before merge\n"
    "`file:line` -- what is wrong (one sentence).\n\n"
    "### [WARNING] -- should fix\n"
    "`file:line` -- what is wrong (one sentence).\n\n"
    "### [NITPICK] -- optional\n"
    "`file:line` -- suggestion (one sentence).\n\n"
    "### Verdict\n"
    "**APPROVE**, **REQUEST CHANGES**, or **NEEDS DISCUSSION**. One sentence max.\n"
)


def build_system_rules(scope):
    """Assemble the charter for `scope`. Unknown scope -> MIXED (fail-safe)."""
    if scope == SCOPE_STUDIO:
        return _STUDIO_INTRO + _PREAMBLE_COMMON + _STUDIO_INVARIANTS + _REVIEW_RULES_AND_FORMAT
    if scope == SCOPE_ENGINE:
        return _ENGINE_INTRO + _PREAMBLE_COMMON + _ENGINE_INVARIANTS + _REVIEW_RULES_AND_FORMAT
    # MIXED or anything unrecognised: BOTH charters. Never "no charter".
    return (
        _MIXED_INTRO
        + _PREAMBLE_COMMON
        + _ENGINE_INVARIANTS
        + _STUDIO_INVARIANTS
        + _REVIEW_RULES_AND_FORMAT
    )


def build_payload(scope, diff, pr_description, comments_raw):
    """Build the /v1/messages request payload for a review of `diff`."""
    user_prompt = "## PR title + description\n\n" + pr_description + "\n\n"
    user_prompt += (
        "## PR Comment History (previous review rounds and author responses)\n\n"
        + (comments_raw if comments_raw else "(no comments yet)")
        + "\n\n"
    )
    user_prompt += "## Full diff\n```diff\n" + diff + "\n```"

    return {
        "model": "claude-sonnet-5",
        # Must cover adaptive-thinking tokens PLUS the review text. At 5000 a
        # large diff spent the whole budget on thinking (stop_reason=max_tokens,
        # 0 text) and the job failed. 16000 leaves room for both; the workflow's
        # truncation guard still catches genuine overflow.
        "max_tokens": 16000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
        "system": [
            {
                "type": "text",
                "text": build_system_rules(scope),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": [{"role": "user", "content": user_prompt}],
    }


def _read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return default


def main(argv):
    """CLI for the workflow: review_prompt.py <files.txt> <diff> <desc> <comments> <out>"""
    if len(argv) != 6:
        sys.stderr.write(
            "usage: review_prompt.py <files.txt> <pr.diff> <pr_description.txt> "
            "<pr_comments.txt> <request.json>\n"
        )
        return 2

    files_path, diff_path, desc_path, comments_path, out_path = argv[1:]

    files = [ln for ln in _read(files_path).splitlines() if ln.strip()]
    scope = classify_scope(files)

    payload = build_payload(
        scope,
        _read(diff_path),
        _read(desc_path).strip(),
        _read(comments_path).strip(),
    )

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)

    # Printed so the workflow log shows which charter actually gated the PR.
    sys.stdout.write(
        "review scope=%s (%d changed files); system charter %d chars\n"
        % (scope, len(files), len(payload["system"][0]["text"]))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
