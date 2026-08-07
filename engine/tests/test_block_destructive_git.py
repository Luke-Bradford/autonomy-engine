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
HOOK = os.path.join(HERE, "..", "..", ".claude", "hooks", "block_destructive_git.py")
sys.path.insert(0, os.path.join(HERE, "..", "..", ".claude", "hooks"))
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

    def test_flagged_wrappers_do_not_smuggle_it_past(self):
        # review: consuming only the bare wrapper keyword left `-u root git reset
        # --hard` unrecognised as git at all, so it sailed through.
        for cmd in ("sudo -u root git reset --hard",
                    "env -i git restore .",
                    "time -p git clean -fd",
                    "nice -n 10 git stash",
                    "nohup git reset --hard HEAD",
                    "command git restore .",
                    "sudo -u root env FOO=1 git clean -fd"):
            self.assertBlocked(cmd)

    def test_a_wrapper_with_no_git_is_not_git(self):
        for cmd in ("sudo -u root rm -rf /tmp/x", "env -i pnpm test", "time -p ls"):
            self.assertAllowed(cmd)

    def test_non_wrapper_commands_that_MENTION_git_are_not_running_it(self):
        # `man`/`which`/`apt` are not wrappers, so the token after them is not a
        # subcommand -- otherwise reading docs would be blocked.
        for cmd in ("man git stash", "which git", "apt list git", "type git"):
            self.assertAllowed(cmd)

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

    def test_stash_forms_split_by_whether_they_LOSE_work(self):
        # review NITPICK: pop/apply/branch RESTORE work (git refuses them when they
        # would overwrite local changes), so only the work-removing forms are refused.
        for cmd in ("git stash list", "git stash show -p", "git stash apply",
                    "git stash pop", "git stash apply stash@{1}",
                    "git stash branch fix/x stash@{0}"):
            self.assertAllowed(cmd)
        for cmd in ("git stash", "git stash push -u", "git stash save wip",
                    "git stash drop", "git stash drop stash@{0}", "git stash clear"):
            self.assertBlocked(cmd)

    def test_stash_label_names_the_form(self):
        self.assertEqual(guard.verdict("git stash drop")[1], "git stash drop")
        self.assertEqual(guard.verdict("git stash clear")[1], "git stash clear")

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

    def test_override_is_per_command_not_per_line(self):
        # review WARNING: the override was matched against the whole raw string, so
        # the text appearing ANYWHERE disabled the guard for a real destructive call
        # elsewhere in the same line.
        self.assertBlocked('echo "ALLOW_DESTRUCTIVE_GIT=1" && git restore .')
        self.assertBlocked("ALLOW_DESTRUCTIVE_GIT=1 git restore ok.bak; git reset --hard")
        self.assertBlocked('cat <<EOF\nALLOW_DESTRUCTIVE_GIT=1\nEOF\ngit stash')
        # only the value 1 counts, and only as an env prefix on THAT command
        self.assertBlocked("ALLOW_DESTRUCTIVE_GIT=0 git restore .")

    def test_destructive_flag_anywhere_in_the_args(self):
        # review WARNING: first-token-only matching let reordered flags bypass
        for cmd in ("git reset --mixed --hard HEAD",
                    "git reset -q --hard origin/main",
                    "git clean --dry-run -f",
                    "git clean -d -f",
                    "git clean -d --force",
                    "git checkout --force main",
                    "git checkout -f main",
                    "git checkout -q -f other-branch"):
            self.assertBlocked(cmd)

    def test_bare_pathspec_checkout_is_blocked(self):
        # review WARNING: `git checkout .` / `git checkout <file>` discard changes
        # exactly like `checkout -- <path>`, and are the COMMONEST form of the
        # accident. `exists` is injected so this does not depend on the real cwd.
        tracked = {"README.md", "src/app.ts"}
        def ex(p):
            return p in tracked
        for cmd in ("git checkout .",
                    "git checkout ./",
                    "git checkout README.md",
                    "git checkout src/app.ts",
                    "git checkout studio/",
                    "git checkout -q README.md"):
            self.assertTrue(guard.verdict(cmd, exists=ex)[0], "should BLOCK: %r" % cmd)

    def test_refs_are_still_checkoutable(self):
        # the loop does these constantly; blocking them would wedge it
        def ex(p):
            return p in {"README.md"}
        for cmd in ("git checkout main",
                    "git checkout feat/711b-destructive-git-guard",
                    "git checkout origin/main",
                    "git checkout -b feat/x origin/main",
                    "git checkout -B studio-loop-work origin/main",
                    "git checkout --track origin/x"):
            self.assertFalse(guard.verdict(cmd, exists=ex)[0], "should ALLOW: %r" % cmd)

    def test_nondestructive_neighbours_of_those_flags(self):
        for cmd in ("git reset --soft HEAD~1",
                    "git reset --mixed HEAD",
                    "git clean -n",
                    "git clean --dry-run",
                    "git checkout -b feat/x",
                    "git checkout --track origin/x"):
            self.assertAllowed(cmd)

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
