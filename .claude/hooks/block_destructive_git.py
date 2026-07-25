#!/usr/bin/env python3
"""PreToolUse(Bash) guard: refuse git commands that DESTROY uncommitted work.

Why this exists (measured, 2026-07-25 usage review): a fire ran `git checkout --`
during mutation testing and wiped its own uncommitted review fixes; separately a
SUBAGENT's checkout clobbered edits in the shared working tree. Both cost a rework
cycle. Unattended fires run with --dangerously-skip-permissions, so an
instruction-level rule has no enforcement behind it -- this hook is the enforcement.

CONTRACT (verified, not guessed): the tool call arrives as JSON on STDIN; exit 2
BLOCKS it and returns stderr to the model. A published example using a
`$CLAUDE_TOOL_INPUT` env var is WRONG -- no such variable exists, so that form
silently allows everything (a fail-open guard, worse than none).

WHY A PARSER AND NOT A GREP: the first version grepped the raw command string and
blocked its own test probe, because the probe's PROMPT TEXT contained the words
`git restore`. A fire writing a commit message or doc that merely mentions these
commands would have been blocked. So quoted spans and heredoc bodies are stripped,
and the check only fires on a word that is actually in COMMAND position.

FAIL-OPEN on any internal error, deliberately: this sits in front of EVERY Bash
call, so a crash that blocked them all would wedge the loop and burn quota
crash-looping. A guard that occasionally misses is recoverable; one that bricks the
agent is not.

Escape hatch: prefix the command with ALLOW_DESTRUCTIVE_GIT=1.
Stdlib only (repo policy: no third-party imports).
"""
import json
import os
import re
import sys

OVERRIDE = "ALLOW_DESTRUCTIVE_GIT"
# Stash subcommands that INSPECT or RESTORE work rather than remove it. `pop`/`apply`
# put work back (and git refuses them when they would overwrite local changes), and
# `branch` moves a stash onto a new branch -- all restorative. Only bare `stash`,
# `push`/`save` (move work out of the tree) and `drop`/`clear` (delete a stash
# outright) are destructive.
STASH_SAFE = ("list", "show", "apply", "pop", "branch")


def _looks_like_path(arg, exists):
    """Is this checkout argument a PATHSPEC (discards changes) rather than a ref?

    git itself needs `--` to disambiguate, so this is a heuristic and says so:
    `.`, a trailing-slash dir, or a name that EXISTS in the working tree is treated
    as a path; anything else (`main`, `feat/x`, `origin/main`) is treated as a ref.
    A branch that shares a name with a file is genuinely ambiguous to git too, and
    lands on the safe side here (blocked).
    """
    if arg in (".", "./") or arg.endswith("/"):
        return True
    return exists(arg)


def destructive_form(sub, args, exists=os.path.exists):
    """The human label if `git <sub> <args>` can delete uncommitted work, else None.

    Decided over the ARGUMENT LIST, not by matching the first token: review found
    that `git reset --mixed --hard HEAD` and `git clean --dry-run -f` slipped past a
    first-token regex. A destructive flag counts wherever it appears.
    """
    if sub == "restore":
        return "git restore"
    if sub == "stash":
        if args and args[0] in STASH_SAFE:
            return None
        if args and args[0] in ("drop", "clear"):
            return "git stash %s" % args[0]
        return "git stash"
    if sub == "checkout":
        if "--" in args:
            return "git checkout -- <path>"
        # -f/--force overwrites local modifications on the way to another ref
        if any(a == "--force" or (a.startswith("-") and not a.startswith("--") and "f" in a)
               for a in args):
            return "git checkout --force"
        # A BARE pathspec discards changes exactly like `checkout -- <path>`:
        # `git checkout .` / `git checkout README.md`. This is the commonest form of
        # the accident this hook exists to prevent, and the `--`-only check missed it.
        # `-b`/`-B` create a branch from a ref, so the operand is never a pathspec.
        if not any(a in ("-b", "-B") for a in args):
            for a in args:
                if a.startswith("-"):
                    continue
                if _looks_like_path(a, exists):
                    return "git checkout <path>"
        return None
    if sub == "reset":
        return "git reset --hard" if "--hard" in args else None
    if sub == "clean":
        for a in args:
            if a == "--force" or (a.startswith("-") and not a.startswith("--") and "f" in a):
                return "git clean -f"
        return None
    return None

GUIDANCE = """BLOCKED: `%s` can destroy uncommitted work in a shared working tree.
This has already cost this project two rework cycles (a fire wiped its own review
fixes; a subagent clobbered edits it did not own).

Do this instead:
  * mutate-and-restore a file:  cp f f.bak  ->  mutate  ->  run  ->  mv f.bak f
  * clean tree for an experiment:  git worktree add ../exp-<name> HEAD
  * discarding a file YOU created this session, and you are certain:
      prefix the command with ALLOW_DESTRUCTIVE_GIT=1"""


def strip_noncode(cmd):
    """Remove quoted spans and heredoc bodies so text ABOUT a command is not
    mistaken for the command. Replaces them with a space to keep word boundaries."""
    # heredoc bodies: <<'EOF' ... EOF  /  <<EOF ... EOF (greedy to last delimiter)
    def drop_heredocs(s):
        m = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", s)
        if not m:
            return s
        delim = m.group(1)
        end = re.search(r"^\s*%s\s*$" % re.escape(delim), s[m.end():], re.M)
        cut = m.end() + (end.end() if end else len(s))
        return s[:m.start()] + " " + drop_heredocs(s[cut:])

    s = drop_heredocs(cmd)
    s = re.sub(r"'[^']*'", " ", s)          # single-quoted
    s = re.sub(r'"(?:\\.|[^"\\])*"', " ", s)  # double-quoted (escapes honoured)
    return s


def commands_in(cmd):
    """Yield (segment, overridden) for each command-position segment of a shell line.

    `overridden` is True only when THIS segment carries the ALLOW_DESTRUCTIVE_GIT=1
    env prefix. Review found the override was previously tested against the whole raw
    string, so the text appearing anywhere -- in a quoted string, a heredoc, a
    neighbouring command -- disabled the guard for a real destructive call elsewhere
    in the same line. The override is a property of one command, not of the line.
    """
    for seg in re.split(r"(?:\|\||&&|[;\n|&()])", cmd):
        seg = seg.strip()
        if not seg:
            continue
        overridden = False
        while True:
            m = re.match(r"^(?:([A-Za-z_][A-Za-z0-9_]*)=(\S*)|sudo|time|env)\s+", seg)
            if not m:
                break
            if m.group(1) == OVERRIDE and m.group(2) == "1":
                overridden = True
            seg = seg[m.end():]
        yield seg, overridden


def verdict(cmd, exists=os.path.exists):
    """(blocked, human_label). `exists` is injected so tests are deterministic."""
    for seg, overridden in commands_in(strip_noncode(cmd)):
        if overridden:
            continue
        m = re.match(r"^git\s+(.*)$", seg, re.S)
        if not m:
            continue
        parts = m.group(1).split()
        if not parts:
            continue
        label = destructive_form(parts[0], parts[1:], exists)
        if label:
            return True, label
    return False, None


def main():
    try:
        data = json.load(sys.stdin)
        cmd = (data.get("tool_input") or {}).get("command") or ""
    except Exception:
        return 0          # fail-open: never wedge every Bash call
    if not cmd:
        return 0
    try:
        blocked, label = verdict(cmd)
    except Exception:
        return 0          # fail-open
    if blocked:
        sys.stderr.write(GUIDANCE % label + "\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
