#!/usr/bin/env python3
"""tests/test_block_destructive_git.py -- the PreToolUse git guard.

The FALSE-POSITIVE cases are the point of this file: the first version of the hook
grepped the raw command string and blocked its own test probe because the probe's
prompt text merely CONTAINED "git restore". A guard that blocks a fire for writing
a commit message about `git reset --hard` would be worse than no guard, so text
ABOUT a command must stay allowed while the command itself is refused.
"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", ".claude", "hooks", "block_destructive_git.py")
sys.path.insert(0, os.path.join(HERE, "..", ".claude", "hooks"))
import block_destructive_git as guard          # noqa: E402


class TestBlocks(unittest.TestCase):
    def assertBlocked(self, cmd):
        self.assertTrue(guard.verdict(cmd)[0], "should BLOCK: %r" % cmd)

    def assertAllowed(self, cmd):
        self.assertFalse(guard.verdict(cmd)[0], "should ALLOW: %r" % cmd)

    def test_the_destructive_set_is_blocked(self):
        for cmd in ("git checkout -- README.md",
                    "git checkout --  src/a.ts src/b.ts",
                    "git restore .",
                    "git restore --staged .",
                    "git stash",
                    "git stash push -u",
                    "git reset --hard HEAD",
                    "git reset --hard origin/main",
                    "git clean -fd",
                    "git clean -xfd"):
            self.assertBlocked(cmd)

    def test_blocked_after_a_real_separator(self):
        # the destructive call hiding at the end of a chain still counts
        for cmd in ("pnpm test && git restore .",
                    "cd studio; git stash",
                    "false || git reset --hard HEAD",
                    "git add -A\ngit checkout -- x.ts"):
            self.assertBlocked(cmd)

    def test_env_prefix_does_not_smuggle_it_past(self):
        self.assertBlocked("FOO=bar git restore .")
        self.assertBlocked("env GIT_DIR=.git git stash")

    def test_ordinary_git_is_untouched(self):
        for cmd in ("git status --short",
                    "git add -A",
                    "git commit -m 'fix'",
                    "git checkout -b feat/x origin/main",
                    "git checkout main",
                    "git fetch origin --quiet",
                    "git worktree add ../exp HEAD",
                    "git log --oneline -5",
                    "git diff origin/main...HEAD"):
            self.assertAllowed(cmd)

    def test_readonly_stash_is_allowed(self):
        self.assertAllowed("git stash list")
        self.assertAllowed("git stash show -p")

    def test_text_ABOUT_a_command_is_not_the_command(self):
        # the regression that the live probe exposed
        for cmd in ('echo "never run git restore in a shared tree"',
                    "echo 'git reset --hard is banned'",
                    'git commit -m "docs: explain why git restore is refused"',
                    'grep -rn "git stash" docs/',
                    'claude -p "Run exactly this: git restore --staged ." --model sonnet'):
            self.assertAllowed(cmd)

    def test_heredoc_body_is_not_the_command(self):
        self.assertAllowed('cat >f.md <<\'EOF\'\nDo not use git restore here.\nEOF')
        self.assertAllowed('git commit -F - <<EOF\nmentions git reset --hard\nEOF')

    def test_explicit_override(self):
        self.assertAllowed("ALLOW_DESTRUCTIVE_GIT=1 git restore f.bak")

    def test_label_names_the_offending_form(self):
        self.assertEqual(guard.verdict("git stash")[1], "git stash")
        self.assertEqual(guard.verdict("git clean -fd")[1], "git clean -f")


class TestHarnessContract(unittest.TestCase):
    """Exercises the real script over stdin, the way the harness invokes it."""

    def _run(self, payload):
        p = subprocess.run([sys.executable, HOOK], input=payload,
                           capture_output=True, text=True)
        return p.returncode, p.stderr

    def test_exit_2_blocks_and_explains(self):
        rc, err = self._run(json.dumps({"tool_input": {"command": "git restore ."}}))
        self.assertEqual(rc, 2)
        self.assertIn("BLOCKED", err)
        self.assertIn("cp f f.bak", err)      # the safe alternative is offered

    def test_exit_0_allows(self):
        rc, _ = self._run(json.dumps({"tool_input": {"command": "git status"}}))
        self.assertEqual(rc, 0)

    def test_fail_open_on_garbage(self):
        # in front of EVERY Bash call: a parse error must never block the agent
        for payload in ("not json", "", "{}", '{"tool_input": {}}',
                        '{"tool_input": {"command": null}}'):
            rc, _ = self._run(payload)
            self.assertEqual(rc, 0, "garbage %r must fail OPEN" % payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
