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
import re
import sys

SCOPE_ENGINE = "engine"
SCOPE_STUDIO = "studio"
SCOPE_MIXED = "mixed"

# --- verdict extraction (#501) ----------------------------------------------
#
# The bug: `review` is a REQUIRED check, and it went GREEN on a review that
# emitted NO verdict at all. On PR #500 the model spent 6023 output tokens
# reasoning in PLAIN TEXT (thinking_tokens=0 under `thinking: adaptive`), ended
# with "Final answer below." and stopped -- stop_reason `end_turn`, so the
# max_tokens guard correctly never fired. Its own final line of reasoning read
# "final verdict: REQUEST CHANGES", so the gate reported PASS on a review that
# had concluded the opposite. Nothing asserted the verdict was ever rendered.
#
# This is the merge-gate invariant applied to the review gate: a `gh` failure is
# never CI-green, and a MISSING verdict is never an APPROVE. The failure mode
# here must be a loud red check, never a quiet pass.
#
# NOT the merge gate's predicate, and deliberately not unified with it.
# `safe_merge.sh:137/141` greps the whole comment body for `APPROVE` /
# `REQUEST CHANGES|[BLOCKING]` to answer a DIFFERENT question -- "does this
# comment block me?" -- and `board.sh:332` mirrors those regexes bug-for-bug ON
# PURPOSE (its comment at :308 says it must agree with the gate it watches, not
# be independently stricter). This function answers "did the model emit its
# MANDATED verdict section?" and so is deliberately strict where those are
# deliberately loose. Unifying the three would silently loosen the merge gate
# and break board.sh's pinned mirror. Leave them separate.
VERDICTS = ("APPROVE", "REQUEST CHANGES", "NEEDS DISCUSSION")

# Ambiguity resolves toward the NON-approving verdict, never toward APPROVE.
# A verdict line naming two markers ("**REQUEST CHANGES** -- fix a.ts:9, then
# this is an **APPROVE**") is a real shape, and answering None there would RED a
# review that did its job -- a false red is a real cost, not a safe default,
# because `enforce_admins: true` means it clears only by re-running. Precedence
# is blocking-first, which is both the safe direction and the same order
# `safe_merge.sh` already checks in (:137 blocking BEFORE :141 approve).
_VERDICT_PRECEDENCE = ("REQUEST CHANGES", "NEEDS DISCUSSION", "APPROVE")

# A fenced block is QUOTED text, never the rendered section. The model is prone
# to restating its own required format mid-monologue ("Recall the output
# format: ```### Verdict ...```") -- and the charter's own "the `### Verdict`
# section is MANDATORY" line raises the odds of exactly that echo. Stripping
# fences first removes the whole class deterministically. An UNTERMINATED fence
# is stripped to EOF (`(?:```|\Z)`): everything after an unclosed fence is
# code-shaped, and over-stripping only ever yields None -- a red check, which is
# the safe direction.
_FENCE = re.compile(r"```.*?(?:```|\Z)", re.DOTALL)

# A real markdown heading LINE, never an inline mention: the model reasons
# IN-BAND now, so it can name "### Verdict" mid-sentence. `^#{1,6}` excludes
# that shape.
_VERDICT_HEADING = re.compile(r"^#{1,6}[ \t]*Verdict\b[^\n]*$", re.MULTILINE | re.IGNORECASE)

# The marker must be BOLD, as the charter mandates. Bare-word matching would be
# fatally loose: "**REQUEST CHANGES** -- I would APPROVE once a.ts:9 is fixed"
# names both verdicts in one honest sentence, and only the bold one is the
# verdict. Bold-only also rejects "**APPROVED**", which is not the marker.
_MARKERS = {
    v: re.compile(r"\*\*[ \t]*" + v.replace(" ", "[ \t]+") + r"[ \t]*\*\*", re.IGNORECASE)
    for v in VERDICTS
}


def extract_verdict(text):
    """The verdict from a review body, or None when none was rendered.

    None is the FAIL-SAFE answer and the caller MUST treat it as "not approved".

    The thing being detected is "the model FINISHED", because the failure this
    guards is a model that trails off mid-thought. So a verdict counts only when
    it TERMINATES the response: last heading, one marker, and nothing but
    whitespace after the marker's own line. Anchoring on the last `### Verdict`
    alone is not enough and is at its weakest exactly when it matters -- in a
    trailed-off monologue the last heading is a DRAFT or a QUOTE, so
    "### Verdict / **APPROVE** / ...hmm, wait, actually a.ts:9 null-derefs...
    Final answer below." would certify as APPROVE. The terminal rule rejects it:
    a verdict the model kept arguing with is not a verdict it rendered.
    """
    if not text:
        return None
    scan = _FENCE.sub("\n", text)
    headings = list(_VERDICT_HEADING.finditer(scan))
    if not headings:
        return None
    # From the heading's START, so a verdict on the heading line itself
    # ("### Verdict: **APPROVE**") still counts -- scanning from its end missed
    # that and returned a false red. Leniency about WHERE the marker sits is
    # safe; leniency about WHAT counts as one would be fail-open, so the marker
    # stays strict and the terminal rule below does the real work.
    body = scan[headings[-1].start() :]
    found = [v for v in VERDICTS if _MARKERS[v].search(body)]
    if not found:
        return None
    verdict = next(v for v in _VERDICT_PRECEDENCE if v in found)
    match = _MARKERS[verdict].search(body)
    # The rest of the marker's LINE is the mandated one-sentence reason; past
    # that, only whitespace. Anything else means the model was still talking.
    after = body[match.end() :]
    newline = after.find("\n")
    if newline != -1 and after[newline + 1 :].strip():
        return None
    return verdict

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
    "Respond with your FINAL ANSWER ONLY. Do not think out loud in the response: no "
    "exploratory reasoning, no intermediate drafts, no meta-commentary about your own "
    "process, no 'let me check...'. Do that work before you start writing. The `### "
    "Verdict` section is MANDATORY and comes last -- a response that ends without it "
    "fails the gate outright (#501), so never trail off before you reach it.\n"
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


def _build_user_prompt(diff, pr_description, comments_raw):
    """The reviewer-facing content (description + comment history + diff).

    Shared by BOTH transports so they review the exact same thing: the metered
    API `build_payload` (message content) and the subscription `claude -p`
    `build_review_prompt` (appended after the charter).
    """
    user_prompt = "## PR title + description\n\n" + pr_description + "\n\n"
    user_prompt += (
        "## PR Comment History (previous review rounds and author responses)\n\n"
        + (comments_raw if comments_raw else "(no comments yet)")
        + "\n\n"
    )
    user_prompt += "## Full diff\n```diff\n" + diff + "\n```"
    return user_prompt


def build_review_prompt(scope, diff, pr_description, comments_raw):
    """The single prompt string for `claude -p` (subscription transport, #505).

    Same scope-aware charter and same reviewer content as the API path -- only
    the transport differs. `claude -p` takes one prompt, so the charter (the
    API path's `system`) and the user content are concatenated; the charter's
    findings-only / verdict-mandatory instructions are unchanged, so the review
    and the verdict `extract_verdict` looks for are identical either way.
    """
    return build_system_rules(scope) + "\n\n" + _build_user_prompt(diff, pr_description, comments_raw)


def build_payload(scope, diff, pr_description, comments_raw):
    """Build the /v1/messages request payload for a review of `diff`."""
    user_prompt = _build_user_prompt(diff, pr_description, comments_raw)

    return {
        "model": "claude-sonnet-5",
        # Must cover adaptive-thinking tokens PLUS the review text. At 5000 a
        # large diff spent the whole budget on thinking (stop_reason=max_tokens,
        # 0 text) and the job failed. 16000 hit the SAME wall on a ~104k-token
        # diff (studio PR #484: output_tokens=16000, thinking_tokens=16000, zero
        # text blocks) — the cap is a function of DIFF SIZE, and 16000 was only
        # ever sized against the diffs of the day. 32000 restores the headroom.
        #
        # Raising this is safe in the fail-safe direction: the guard cannot
        # mistake a truncated review for an APPROVE (it banners the comment and
        # fails the job). The HOLE this comment used to flag — thinking eating
        # the ENTIRE budget leaves zero text blocks, which died on a raw API
        # dump rather than the actionable message — is CLOSED by extract_review
        # below (#504). Do not raise this without reading #505 first: the call
        # is a non-streaming curl with no --max-time on a job with no
        # timeout-minutes, and ~32000 is already about 2x the documented
        # non-streaming guidance. 128K is Sonnet 5's STREAMING ceiling, not a
        # budget available here.
        "max_tokens": 32000,
        "thinking": {"type": "adaptive"},
        # `high` (operator, 2026-07-17, cost). `high` is the DOCUMENTED FLOOR for
        # intelligence-sensitive work -- a merge gate reading a diff for defects
        # is exactly that -- so it stays above the bar `medium` fell below (#504:
        # `medium` rubber-stamped, bare APPROVE in 27s, missed six real defects).
        #
        # Was `xhigh` (#504). Dropped one notch to cut METERED API spend: the
        # review bills per-token via ANTHROPIC_API_KEY (not the subscription the
        # loop fires use), and `xhigh` reviews were ~17k output tokens each, ~98%
        # of it thinking, times ~15 PRs/day times every re-review round. `high`
        # roughly halves the thinking tokens while keeping a real review. If the
        # gate starts missing defects at `high`, `xhigh` is the knob to turn back.
        #
        # Sonnet 5 "respects effort levels strictly, especially at the low end"
        # -- which is the mechanism, not a footnote: `medium` was not
        # underperforming by accident, it was doing what it was told. On PR #503
        # (~300 lines) it returned a bare APPROVE in 27s with thinking_tokens=0
        # and zero findings, while two thinking-tier reviews of that same diff
        # found six real defects including a BLOCKING one.
        #
        # `thinking: adaptive` decides per REQUEST whether to think at all, so
        # this is a floor on depth, not a guarantee of it -- effort raises the
        # spend the model is willing to make, it does not force it. Do not read
        # thinking_tokens=0 on some future run as this line having failed.
        #
        # A correct answer that costs a little beats a fast rubber stamp -- the
        # right direction for a gate an unattended loop merges on. This API bot
        # is the INDEPENDENT backstop; the loop's two pre-PR subagent lenses
        # (SUBSCRIPTION, no per-token charge) are the primary "review our own
        # homework" pass, so the metered bot need not carry the deepest tier.
        # `max_tokens` stays at its headroom value -- it is a CAP, not a charge
        # (you pay for tokens generated, not the ceiling), so lowering it saves
        # nothing and only risks truncation. See the constant above and #505.
        "output_config": {"effort": "high"},
        "system": [
            {
                "type": "text",
                "text": build_system_rules(scope),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": [{"role": "user", "content": user_prompt}],
    }


# --- response extraction (#504) ---------------------------------------------
#
# Lifted OUT of an inline `python3 -c` heredoc in claude-review.yml, for the
# same reason #501 lifted the verdict extractor and #468 lifted the charter:
# an inline heredoc is untestable, and untestability is how each of those bugs
# survived. The workflow's own comment at the build step says exactly that.
#
# The HOLE this closes -- flagged at the `max_tokens` constant above as "worth
# closing next time this file is open", and this is that time. When adaptive
# thinking spends the ENTIRE budget the response carries thinking blocks and no
# text at all, so the heredoc died at its generic `No text block` check and
# printed a raw API dump, while the actionable "raise max_tokens" message it
# already had sat unreachable behind a stop_reason check further down. Always
# fail-safe (nothing was ever certified), just needlessly hard to diagnose.
# #504 raises `effort`, which raises P(thinking eats the budget) -- so the
# diagnosis has to land BEFORE the effort does.
#
# Every path here fails CLOSED: a response we cannot read is not an approval,
# which is #501's rule applied one layer earlier.


class ReviewExtractionError(Exception):
    """The API response cannot yield a usable review body."""


# ONE source for "which file holds max_tokens", because the answer has already
# drifted once: the heredoc's banner said "Bump max_tokens in
# .github/workflows/claude-review.yml" long after the constant moved into this
# module, so the one message an operator reads at 3am sent them to the wrong
# file. Both the banner and the budget-exhaustion error interpolate this -- a
# second literal is a second thing to forget.
_BUDGET_HINT = "Raise `max_tokens` in lib/review_prompt.py (see #505 first) or split the PR."

_TRUNCATION_BANNER = (
    "> :warning: **Review truncated by the max_tokens cap — findings below may "
    "be incomplete. " + _BUDGET_HINT + "**\n\n"
)


def _usage(response):
    # Callers are downstream of extract_review's own isinstance check.
    return response.get("usage", {})


def extract_review(response):
    """Return (comment_text, stop_reason) from a Messages API response dict.

    Raises ReviewExtractionError -- with a message that names the actual
    failure -- rather than returning anything the gate could mistake for a
    review.
    """
    if not isinstance(response, dict):
        raise ReviewExtractionError("response is not a JSON object: %r" % (response,))

    content = response.get("content")
    if not content or not isinstance(content, list):
        raise ReviewExtractionError(
            "unexpected response shape -- no usable `content`:\n%s"
            % json.dumps(response, indent=2)
        )

    stop_reason = response.get("stop_reason") or ""
    text_blocks = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]

    if not text_blocks:
        if stop_reason == "max_tokens":
            raise ReviewExtractionError(
                "adaptive thinking consumed the ENTIRE max_tokens budget: the "
                "response carries no review text at all "
                "(stop_reason=max_tokens, usage=%s). %s"
                % (json.dumps(_usage(response), sort_keys=True), _BUDGET_HINT)
            )
        raise ReviewExtractionError(
            "no text block in response content (stop_reason=%r):\n%s"
            % (stop_reason, json.dumps(response, indent=2))
        )

    # JOIN every text block, never just the first. A partial comment was merely
    # untidy until #501 made the verdict a required check: a reply split across
    # blocks would post a truncated review AND fail the assert as verdict-less
    # though the model emitted one -- a false red that is near-impossible to
    # diagnose from the error. (PR #500 was a SINGLE block, so it is not
    # evidence for this; interleaved thinking is what splits blocks.)
    #
    # Joined on a BLANK LINE, not the empty string: blocks carry no
    # trailing-newline guarantee, so an empty join can glue a findings line onto
    # the `### Verdict` heading that follows it, killing the start-of-line
    # anchor extract_verdict needs and reding the check for no reason. Separate
    # blocks are separate markdown; a blank line is the faithful seam.
    #
    # The type check is not paranoia about the API: `"\n\n".join` on a non-str
    # raises a bare TypeError, and a raw traceback is the generic-dump failure
    # this whole function exists to delete. Fail closed WITH a diagnosis.
    parts = []
    for block in text_blocks:
        value = block.get("text")
        if not isinstance(value, str):
            raise ReviewExtractionError(
                "a text block carries a non-string `text` (%r) -- malformed "
                "response:\n%s" % (value, json.dumps(response, indent=2))
            )
        parts.append(value)
    text = "\n\n".join(parts)

    if stop_reason == "max_tokens":
        text = _TRUNCATION_BANNER + text

    return text, stop_reason


def _read(path, default=""):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return default


def _verdict_main(path):
    """`--verdict <review.txt>`: print the verdict, or refuse with exit 1.

    An unreadable review is not an approval either -- `_read` yields "" and that
    extracts to None, so the missing-file path fails closed by construction.
    """
    verdict = extract_verdict(_read(path, ""))
    if verdict is None:
        sys.stderr.write(
            "review_prompt: no verdict -- the review body has no unambiguous "
            "'### Verdict' section naming exactly one of: %s.\n"
            "A review that renders no verdict is NOT an approval; failing the "
            "gate rather than passing it (#501). Re-run the review job.\n"
            % ", ".join("**%s**" % v for v in VERDICTS)
        )
        return 1
    sys.stdout.write(verdict + "\n")
    return 0


_USAGE = (
    "usage: review_prompt.py <files.txt> <pr.diff> <pr_description.txt> "
    "<pr_comments.txt> <request.json>\n"
    "       review_prompt.py --verdict <review.txt>\n"
    "       review_prompt.py --extract <response.json> <review.txt> "
    "<stop_reason.txt>\n"
)


def _extract_main(response_path, review_path, stop_reason_path):
    """`--extract <response.json> <review.txt> <stop_reason.txt>` (#504).

    Writes stop_reason.txt only on success: a caller that reads it can trust it
    describes a review that actually exists.
    """
    try:
        with open(response_path, encoding="utf-8") as fh:
            response = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(
            "review_prompt: cannot read the API response %s (%s). An unreadable "
            "response is not an approval; failing the gate.\n" % (response_path, exc)
        )
        return 1

    try:
        text, stop_reason = extract_review(response)
    except ReviewExtractionError as exc:
        sys.stderr.write("review_prompt: %s\n" % exc)
        return 1

    with open(review_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    with open(stop_reason_path, "w", encoding="utf-8") as fh:
        fh.write(stop_reason)

    sys.stdout.write(
        "review extracted (stop_reason=%r, usage=%s)\n"
        % (stop_reason, json.dumps(_usage(response), sort_keys=True))
    )
    return 0


def extract_cli_result(response):
    """Return (review_text, stop_reason) from a `claude -p --output-format json`
    result object (the SUBSCRIPTION transport, #505). Fail-safe like
    extract_review: raises ReviewExtractionError rather than returning anything
    the gate could mistake for a review.

    Shape: {"type":"result","is_error":bool,"result":"<text>","stop_reason":...}.
    """
    if not isinstance(response, dict):
        raise ReviewExtractionError("claude -p output is not a JSON object: %r" % (response,))
    if response.get("is_error"):
        raise ReviewExtractionError(
            "claude -p reported an error (is_error=true): %r -- not a review, failing the gate."
            % (response.get("result"),)
        )
    text = response.get("result")
    if not isinstance(text, str) or not text.strip():
        raise ReviewExtractionError(
            "claude -p returned no usable `result` text:\n%s" % json.dumps(response, indent=2)
        )
    return text, str(response.get("stop_reason") or "")


def _prompt_main(files_path, diff_path, desc_path, comments_path, out_path):
    """`--prompt <files.txt> <diff> <desc> <comments> <out>`: write the single
    `claude -p` review prompt (scope-aware charter + reviewer content) to <out>."""
    files = [ln for ln in _read(files_path).splitlines() if ln.strip()]
    scope = classify_scope(files)
    prompt = build_review_prompt(
        scope,
        _read(diff_path),
        _read(desc_path).strip(),
        _read(comments_path).strip(),
    )
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(prompt)
    sys.stdout.write(
        "review scope=%s (%d changed files); prompt %d chars\n" % (scope, len(files), len(prompt))
    )
    return 0


def _extract_cli_main(response_path, review_path, stop_reason_path):
    """`--extract-cli <response.json> <review.txt> <stop_reason.txt>`: extract a
    review from `claude -p` JSON. Mirrors _extract_main's fail-closed contract."""
    try:
        with open(response_path, encoding="utf-8") as fh:
            response = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(
            "review_prompt: cannot read the claude -p output %s (%s). Unreadable "
            "is not an approval; failing the gate.\n" % (response_path, exc)
        )
        return 1
    try:
        text, stop_reason = extract_cli_result(response)
    except ReviewExtractionError as exc:
        sys.stderr.write("review_prompt: %s\n" % exc)
        return 1
    with open(review_path, "w", encoding="utf-8") as fh:
        fh.write(text)
    with open(stop_reason_path, "w", encoding="utf-8") as fh:
        fh.write(stop_reason)
    sys.stdout.write("review extracted from claude -p (stop_reason=%r)\n" % stop_reason)
    return 0


def main(argv):
    """CLI for the workflow: review_prompt.py <files.txt> <diff> <desc> <comments> <out>

    Also `review_prompt.py --verdict <review.txt>` (#501) and
    `review_prompt.py --extract <response.json> <review.txt> <stop_reason.txt>`
    (#504), so the gate calls these TESTED extractors instead of inline
    heredocs -- untestability is exactly how #468 survived, per the comment in
    claude-review.yml.

    Subscription transport (#505): `--prompt <files> <diff> <desc> <comments>
    <out>` builds the single `claude -p` prompt, and `--extract-cli
    <response.json> <review.txt> <stop_reason.txt>` extracts the review from
    claude -p's JSON output.
    """
    # Dispatch on the FLAG first, then check its arity. Matching arity first
    # and falling through on a mismatch is how `--extract a b c EXTRA` became a
    # silent BUILD: the flag is swallowed as files.txt (unreadable -> "" ->
    # scope MIXED), the caller's last argument is OVERWRITTEN with a request
    # payload, and it exits 0 having done the wrong thing entirely. An exit-0
    # wrong operation is the exact failure shape this module is lifting out of
    # the workflow's heredoc -- it must not be reintroduced by the dispatcher.
    if len(argv) > 1 and argv[1].startswith("--"):
        if argv[1] == "--verdict" and len(argv) == 3:
            return _verdict_main(argv[2])
        if argv[1] == "--extract" and len(argv) == 5:
            return _extract_main(argv[2], argv[3], argv[4])
        if argv[1] == "--prompt" and len(argv) == 7:
            return _prompt_main(argv[2], argv[3], argv[4], argv[5], argv[6])
        if argv[1] == "--extract-cli" and len(argv) == 5:
            return _extract_cli_main(argv[2], argv[3], argv[4])
        sys.stderr.write("review_prompt: bad flag or arity: %s\n\n%s" % (argv[1], _USAGE))
        return 2

    if len(argv) != 6:
        sys.stderr.write(_USAGE)
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
