"""Tests for lib/review_prompt.py -- the scope-aware review charter (#468).

The bug these lock down: the review bot's charter was hardcoded to the bash/
Python engine, so a `studio/` TypeScript diff got reviewed by a bot told it
reviews bash. It answered "none of the stated invariants apply here" and then
emitted an ARBITRARY verdict -- six studio PRs merged on APPROVEs that certified
nothing, and PR #466 drew NEEDS DISCUSSION off identical reasoning.

These call the real functions with real path lists -- no mocks.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parent.parent
CLI = ENGINE_ROOT / "lib" / "review_prompt.py"

sys.path.insert(0, str(ENGINE_ROOT / "lib"))
import review_prompt  # noqa: E402

# Distinguishing markers: a rule that appears in exactly one charter.
ENGINE_MARKER = "3.2.57"          # bash-3.2 rule -- engine only
STUDIO_MARKER = "reducer is PURE"  # reducer purity -- studio only

STUDIO_FILES = [
    "studio/packages/server/src/scheduler/alarms.ts",
    "studio/packages/shared/src/schemas/wakeup.ts",
]
ENGINE_FILES = ["bin/supervisor.sh", "lib/config_parser.py"]


class TestClassifyScope(unittest.TestCase):
    def test_studio_only_diff_is_studio(self):
        self.assertEqual(review_prompt.classify_scope(STUDIO_FILES), review_prompt.SCOPE_STUDIO)

    def test_engine_only_diff_is_engine(self):
        self.assertEqual(review_prompt.classify_scope(ENGINE_FILES), review_prompt.SCOPE_ENGINE)

    def test_mixed_diff_is_mixed(self):
        self.assertEqual(
            review_prompt.classify_scope(STUDIO_FILES + ENGINE_FILES),
            review_prompt.SCOPE_MIXED,
        )

    def test_studio_docs_still_count_as_studio(self):
        self.assertEqual(
            review_prompt.classify_scope(["studio/docs/2026-07-14-foundation-overview.md"]),
            review_prompt.SCOPE_STUDIO,
        )

    def test_a_path_merely_containing_studio_is_not_studio(self):
        # `docs/studio-notes.md` is an ENGINE path -- only the `studio/` PREFIX counts.
        self.assertEqual(
            review_prompt.classify_scope(["docs/studio-notes.md", "bin/studio_helper.sh"]),
            review_prompt.SCOPE_ENGINE,
        )

    # --- fail-safe: prevention-log #3, a silent fallback that widens = fail-open ---

    def test_empty_file_list_is_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope([]), review_prompt.SCOPE_MIXED)

    def test_none_file_list_is_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope(None), review_prompt.SCOPE_MIXED)

    def test_blank_entries_are_mixed_not_skip(self):
        self.assertEqual(review_prompt.classify_scope(["", "   "]), review_prompt.SCOPE_MIXED)


class TestBuildSystemRules(unittest.TestCase):
    def test_studio_charter_omits_engine_bash_rules(self):
        """THE #468 REGRESSION: a studio diff must never be judged by bash-3.2 rules."""
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertNotIn(ENGINE_MARKER, rules)
        self.assertNotIn("mapfile", rules)
        self.assertNotIn("PyYAML", rules)

    def test_studio_charter_carries_studio_invariants(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertIn(STUDIO_MARKER, rules)
        self.assertIn("run_events", rules)
        self.assertIn("IMMUTABLE pipeline version", rules)
        self.assertIn("No fail-open", rules)
        self.assertIn("TypeScript", rules)

    def test_studio_charter_states_the_engine_rules_do_not_apply(self):
        """The bot must be told EXPLICITLY, or it re-derives 'out of scope'."""
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_STUDIO)
        self.assertIn("EXEMPT", rules)

    def test_engine_charter_unchanged_in_substance(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_ENGINE)
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn("repo-agnostic", rules)
        self.assertIn("Merge-gate fail-safe", rules)
        self.assertNotIn(STUDIO_MARKER, rules)

    def test_mixed_charter_carries_both(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_MIXED)
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn(STUDIO_MARKER, rules)

    def test_mixed_charter_scopes_each_ruleset_to_its_own_tree(self):
        rules = review_prompt.build_system_rules(review_prompt.SCOPE_MIXED)
        self.assertIn("ONLY to files under its own tree", rules)

    def test_unknown_scope_falls_back_to_both_never_none(self):
        """Fail-safe: an unrecognised scope reviews MORE strictly, never less."""
        rules = review_prompt.build_system_rules("wat")
        self.assertIn(ENGINE_MARKER, rules)
        self.assertIn(STUDIO_MARKER, rules)

    def test_every_charter_binds_the_verdict_to_the_findings(self):
        """#468 root cause: an unbound verdict is a coin-flip an automated rail reads."""
        for scope in (
            review_prompt.SCOPE_STUDIO,
            review_prompt.SCOPE_ENGINE,
            review_prompt.SCOPE_MIXED,
        ):
            rules = review_prompt.build_system_rules(scope)
            self.assertIn("Verdict discipline", rules, scope)
            self.assertIn("Any [BLOCKING] finding -> **REQUEST CHANGES**", rules, scope)
            self.assertIn("No [BLOCKING] findings -> **APPROVE**", rules, scope)
            # NEEDS DISCUSSION must be barred as an "out of charter" escape hatch.
            self.assertIn("Never use it to mean 'this is outside my charter'", rules, scope)

    def test_every_charter_keeps_the_diff_only_discipline(self):
        for scope in (
            review_prompt.SCOPE_STUDIO,
            review_prompt.SCOPE_ENGINE,
            review_prompt.SCOPE_MIXED,
        ):
            rules = review_prompt.build_system_rules(scope)
            self.assertIn("Review ONLY the diff", rules, scope)


class TestBuildPayload(unittest.TestCase):
    def test_payload_shape_and_cache_control(self):
        p = review_prompt.build_payload(review_prompt.SCOPE_STUDIO, "diff", "desc", "comments")
        self.assertEqual(p["model"], "claude-sonnet-5")
        # Sized to cover adaptive thinking PLUS the review text on a large diff —
        # see the comment at the constant. Raised 5000 → 16000 → 32000, each time
        # after a real diff spent the whole budget on thinking and emitted none.
        self.assertEqual(p["max_tokens"], 32000)
        self.assertEqual(p["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn(STUDIO_MARKER, p["system"][0]["text"])

    def test_payload_embeds_diff_description_and_comments(self):
        p = review_prompt.build_payload(
            review_prompt.SCOPE_ENGINE, "THEDIFF", "THEDESC", "THECOMMENTS"
        )
        content = p["messages"][0]["content"]
        self.assertIn("THEDIFF", content)
        self.assertIn("THEDESC", content)
        self.assertIn("THECOMMENTS", content)

    def test_empty_comments_render_a_placeholder(self):
        p = review_prompt.build_payload(review_prompt.SCOPE_ENGINE, "d", "desc", "")
        self.assertIn("(no comments yet)", p["messages"][0]["content"])


class TestCli(unittest.TestCase):
    """Drive the real CLI the workflow calls -- end to end, no mocks."""

    def _run(self, files_text):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "files.txt").write_text(files_text)
            (d / "pr.diff").write_text("+ some diff")
            (d / "desc.txt").write_text("# title")
            (d / "comments.txt").write_text("")
            out = d / "request.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    str(d / "files.txt"),
                    str(d / "pr.diff"),
                    str(d / "desc.txt"),
                    str(d / "comments.txt"),
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(out.read_text()), proc.stdout

    def test_cli_studio_diff_writes_studio_charter(self):
        payload, stdout = self._run("studio/packages/server/src/scheduler/alarms.ts\n")
        self.assertIn("scope=studio", stdout)
        self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])
        self.assertNotIn(ENGINE_MARKER, payload["system"][0]["text"])

    def test_cli_engine_diff_writes_engine_charter(self):
        payload, stdout = self._run("bin/supervisor.sh\n")
        self.assertIn("scope=engine", stdout)
        self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])

    def test_cli_mixed_diff_writes_both(self):
        payload, stdout = self._run("bin/supervisor.sh\nstudio/packages/shared/src/x.ts\n")
        self.assertIn("scope=mixed", stdout)
        self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])
        self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])

    def test_cli_missing_files_list_still_produces_a_charter(self):
        """A read failure must not silently produce a charter-less review."""
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            (d / "pr.diff").write_text("+ diff")
            (d / "desc.txt").write_text("t")
            (d / "comments.txt").write_text("")
            out = d / "request.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    str(d / "does-not-exist.txt"),
                    str(d / "pr.diff"),
                    str(d / "desc.txt"),
                    str(d / "comments.txt"),
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(out.read_text())
            # unreadable -> MIXED -> BOTH charters, never none
            self.assertIn(ENGINE_MARKER, payload["system"][0]["text"])
            self.assertIn(STUDIO_MARKER, payload["system"][0]["text"])

    def test_cli_rejects_wrong_arg_count(self):
        proc = subprocess.run([sys.executable, str(CLI), "only-one"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


# The real PR #500 review, abridged to its shape: 6k tokens of plain-text
# reasoning (thinking_tokens=0), ending mid-thought with no verdict section.
# stop_reason was `end_turn`, so the max_tokens guard never fired and the
# required `review` check went GREEN. Its own last line concluded the OPPOSITE
# of what the gate reported.
PR500_MONOLOGUE = """Let me review this diff carefully against the studio invariants.

Checking `stalledEntitiesLabel` -- uses `Array.slice`, `join`. Pure.
Now writing verdict: given the potential crash risk (BLOCKING candidate).
I'll flag it as BLOCKING given the domain.

Given all, final verdict: REQUEST CHANGES due to BLOCKING finding.

Let's write it up.

Final answer below.
"""


class TestExtractVerdict(unittest.TestCase):
    """#501 -- a review with no verdict must never read as an approval."""

    def test_the_pr500_monologue_yields_no_verdict(self):
        # The regression. Prose SAYING "REQUEST CHANGES" is not a verdict
        # section; the model never emitted one, so the honest answer is None
        # (-> the gate fails), not the verdict its reasoning happened to name.
        self.assertIsNone(review_prompt.extract_verdict(PR500_MONOLOGUE))

    def test_a_real_approve_is_extracted(self):
        text = (
            "### [NITPICK] -- optional\n`a.ts:1` -- rename this.\n\n"
            "### Verdict\n**APPROVE** -- no blocking issues in the diff.\n"
        )
        self.assertEqual(review_prompt.extract_verdict(text), "APPROVE")

    def test_a_real_request_changes_is_extracted(self):
        text = "### Verdict\n**REQUEST CHANGES** -- the null deref at a.ts:9.\n"
        self.assertEqual(review_prompt.extract_verdict(text), "REQUEST CHANGES")

    def test_needs_discussion_is_extracted(self):
        text = "### Verdict\n**NEEDS DISCUSSION** -- the fork is unsettled.\n"
        self.assertEqual(review_prompt.extract_verdict(text), "NEEDS DISCUSSION")

    def test_request_changes_is_not_read_as_approve_by_substring(self):
        # 'REQUEST CHANGES' shares no substring with 'APPROVE', but the section
        # body routinely NAMES the verdict it withheld. Only the marker counts.
        text = "### Verdict\n**REQUEST CHANGES** -- I would APPROVE once a.ts:9 is fixed.\n"
        self.assertEqual(review_prompt.extract_verdict(text), "REQUEST CHANGES")

    def test_approved_does_not_match_approve(self):
        # 'APPROVED' is not the mandated marker. A gate that accepts a near-miss
        # is a gate that accepts prose.
        text = "### Verdict\nThis PR is **APPROVED** by me.\n"
        self.assertIsNone(review_prompt.extract_verdict(text))

    def test_two_markers_resolve_to_the_NON_approving_one(self):
        # Blocking-first, never a coin flip and never toward APPROVE. Answering
        # None here would RED a review that did its job, and a false red clears
        # only by re-running (`enforce_admins: true`). Same precedence order
        # safe_merge.sh already uses (:137 blocking before :141 approve).
        text = "### Verdict\n**APPROVE** or maybe **REQUEST CHANGES**, hard to say.\n"
        self.assertEqual(review_prompt.extract_verdict(text), "REQUEST CHANGES")

    def test_a_verdict_line_naming_the_verdict_it_withheld_is_not_ambiguous(self):
        text = "### Verdict\n**REQUEST CHANGES** -- fix a.ts:9, then this is an **APPROVE**.\n"
        self.assertEqual(review_prompt.extract_verdict(text), "REQUEST CHANGES")

    def test_no_heading_yields_none(self):
        self.assertIsNone(review_prompt.extract_verdict("**APPROVE** -- looks fine to me.\n"))

    def test_empty_text_yields_none(self):
        self.assertIsNone(review_prompt.extract_verdict(""))

    def test_the_LAST_verdict_heading_wins(self):
        # The model REVISES UPWARD here, and that shape is the only one that
        # pins last-wins. Two earlier drafts of this test did not: one planted
        # the first "### Verdict" mid-sentence (where `^#{1,6}` never matches,
        # so the fixture had ONE heading); the next revised DOWNWARD, where
        # blocking-first precedence returns REQUEST CHANGES from either anchor.
        # Both passed with `headings[0]` substituted -- verified by mutation.
        # Revising upward separates them: from the LAST heading the answer is
        # APPROVE; from the FIRST, the draft's REQUEST CHANGES wins precedence,
        # then trailing prose trips the terminal rule and yields None.
        text = (
            "### Verdict\n**REQUEST CHANGES** -- draft: a.ts:9 looks unguarded.\n\n"
            "Re-checked: the caller filters, so that draft finding was wrong.\n\n"
            "### Verdict\n**APPROVE** -- nothing blocking.\n"
        )
        self.assertEqual(review_prompt.extract_verdict(text), "APPROVE")

    def test_an_inline_mention_is_not_a_heading(self):
        text = (
            "I need to emit a ### Verdict section saying **APPROVE** when I finish.\n\n"
            "Final answer below.\n"
        )
        self.assertIsNone(review_prompt.extract_verdict(text))

    # --- the trailed-off monologue: a verdict must TERMINATE the response -----
    #
    # The #501 failure is a model that stops mid-thought. Anchoring on the last
    # `### Verdict` is weakest exactly there: in an unfinished response the last
    # heading is a DRAFT or a QUOTE. Each of these certified as APPROVE before
    # the terminal rule -- i.e. bug #501, unfixed, on a required check.

    def test_a_QUOTED_format_block_then_more_reasoning_is_not_a_verdict(self):
        text = (
            "Recall the required output format:\n\n"
            "```\n### Verdict\n**APPROVE** -- one sentence max.\n```\n\n"
            "Given all, final verdict: REQUEST CHANGES due to BLOCKING finding.\n\n"
            "Final answer below.\n"
        )
        self.assertIsNone(review_prompt.extract_verdict(text))

    def test_a_verdict_quoted_in_an_UNTERMINATED_fence_is_not_a_verdict(self):
        # The one shape where stripping fences is load-bearing rather than
        # belt-and-braces: the model quotes its own format and trails off INSIDE
        # the code block, so no prose follows and the terminal rule is happy.
        # Without `_FENCE`, this quoted example certifies as APPROVE. (Verified
        # by mutation: with a closed fence, the terminal rule alone already
        # rejects, so a closed-fence fixture pins nothing.)
        text = "Recall the required output format:\n\n```\n### Verdict\n**APPROVE** -- one sentence max.\n"
        self.assertIsNone(review_prompt.extract_verdict(text))

    def test_a_DRAFT_the_model_then_argues_with_is_not_a_verdict(self):
        text = (
            "### Verdict\n**APPROVE**\n\n"
            "Hmm, wait. Actually a.ts:9 can null-deref. Let me redo this properly.\n\n"
            "Final answer below.\n"
        )
        self.assertIsNone(review_prompt.extract_verdict(text))

    def test_a_HEDGED_heading_line_the_model_walks_back_is_not_a_verdict(self):
        text = (
            "### Verdict: leaning **APPROVE**, but let me re-check the null deref first.\n\n"
            "Final answer below.\n"
        )
        self.assertIsNone(review_prompt.extract_verdict(text))

    def test_trailing_blank_lines_do_not_break_a_real_verdict(self):
        self.assertEqual(
            review_prompt.extract_verdict("### Verdict\n**APPROVE** -- fine.\n\n\n"),
            "APPROVE",
        )

    def test_a_verdict_on_the_heading_line_itself_still_counts(self):
        # A false RED is a real cost, not a safe default: it blocks a merge on a
        # review that did its job. The section header is a format detail the
        # model can reasonably collapse.
        self.assertEqual(review_prompt.extract_verdict("### Verdict: **APPROVE**\n"), "APPROVE")

    def test_a_heading_that_merely_starts_with_verdict_is_not_the_section(self):
        self.assertIsNone(review_prompt.extract_verdict("### Verdicts\n**APPROVE**\n"))

    def test_crlf_line_endings_still_extract(self):
        text = "### Verdict\r\n**APPROVE** -- fine.\r\n"
        self.assertEqual(review_prompt.extract_verdict(text), "APPROVE")

    def test_the_max_tokens_banner_does_not_break_extraction(self):
        # The banner is PREPENDED above the review; it must not shadow the
        # section nor be mistaken for one.
        text = (
            "> :warning: **Review truncated by max_tokens cap.**\n\n"
            "### Verdict\n**APPROVE** -- nothing blocking.\n"
        )
        self.assertEqual(review_prompt.extract_verdict(text), "APPROVE")

    def test_the_charter_it_gates_still_mandates_the_section_it_looks_for(self):
        # The extractor and the charter must not drift: if the charter stops
        # asking for the section, the extractor silently REDS every review.
        # `assertIn("### Verdict", rules)` looked like it bound them and did
        # not -- the charter's own PROSE says "### Verdict", so deleting the
        # whole format spec left it green. So ROUND-TRIP instead: build a reply
        # in the shape each charter demands and run the real extractor over it.
        # This can only pass while the two agree.
        for scope in (review_prompt.SCOPE_STUDIO, review_prompt.SCOPE_ENGINE, review_prompt.SCOPE_MIXED):
            rules = review_prompt.build_system_rules(scope)
            self.assertIn("### Verdict\n", rules, scope)
            template = rules[rules.rindex("### Verdict\n") :]
            # The charter's own template line, rendered as the model would:
            # "**APPROVE**, **REQUEST CHANGES**, or **NEEDS DISCUSSION**."
            self.assertIn("**APPROVE**", template, scope)
            reply = "### Verdict\n**APPROVE** -- nothing blocking.\n"
            self.assertEqual(review_prompt.extract_verdict(reply), "APPROVE", scope)


class TestVerdictCli(unittest.TestCase):
    """The workflow calls the TESTED extractor -- not an untestable heredoc (#468)."""

    def _run(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "review.txt"
            p.write_text(text, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(CLI), "--verdict", str(p)],
                capture_output=True,
                text=True,
            )

    def test_cli_prints_the_verdict_and_exits_zero(self):
        proc = self._run("### Verdict\n**APPROVE** -- fine.\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "APPROVE")

    def test_cli_exits_nonzero_when_no_verdict(self):
        proc = self._run(PR500_MONOLOGUE)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("no verdict", proc.stderr.lower())

    def test_cli_exits_nonzero_on_a_missing_file(self):
        # An unreadable review is not an approval either.
        proc = subprocess.run(
            [sys.executable, str(CLI), "--verdict", "/nonexistent/review.txt"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 1)

    def test_cli_exits_zero_on_request_changes(self):
        # DELIBERATE, and the narrow scope of #501: this gate answers "was a
        # verdict rendered?", NOT "was it an approval?". Making the required
        # check red on REQUEST CHANGES hands the bot an unappealable veto --
        # `enforce_admins` is true and BLOCKING findings are resolvable by
        # REBUTTAL (review-resolution.md), so a bot that would not retract
        # would wedge the branch for everyone, admins included. Tracked as its
        # own fork; pinned here so the scope decision is deliberate, not lost.
        proc = self._run("### Verdict\n**REQUEST CHANGES** -- a.ts:9 null deref.\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "REQUEST CHANGES")

    def test_the_five_arg_path_still_works(self):
        # --verdict must not cannibalise the charter-building CLI.
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "files.txt").write_text("\n".join(STUDIO_FILES), encoding="utf-8")
            (d / "pr.diff").write_text("diff --git a/x b/x\n", encoding="utf-8")
            (d / "desc.txt").write_text("desc", encoding="utf-8")
            (d / "comments.txt").write_text("", encoding="utf-8")
            out = d / "request.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(CLI),
                    str(d / "files.txt"),
                    str(d / "pr.diff"),
                    str(d / "desc.txt"),
                    str(d / "comments.txt"),
                    str(out),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn(STUDIO_MARKER, json.loads(out.read_text())["system"][0]["text"])


if __name__ == "__main__":
    unittest.main()
