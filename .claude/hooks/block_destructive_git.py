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
import re
import sys

# git subcommand forms that can silently delete uncommitted work.
DESTRUCTIVE = (
    (r"checkout\s+--(\s|$)", "git checkout -- <path>"),
    (r"restore(\s|$)", "git restore"),
    (r"stash(\s|$)", "git stash"),
    (r"reset\s+--hard", "git reset --hard"),
    (r"clean\s+-[a-zA-Z]*f", "git clean -f"),
)
# Read-only stash forms are explicitly fine.
STASH_READONLY = re.compile(r"^stash\s+(list|show)(\s|$)")

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
    """The command-position segments of a shell line, split on real separators."""
    for seg in re.split(r"(?:\|\||&&|[;\n|&()])", cmd):
        seg = seg.strip()
        if not seg:
            continue
        # drop leading env assignments (FOO=bar git ...) and `sudo`/`time`
        while True:
            m = re.match(r"^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|time|env)\s+", seg)
            if not m:
                break
            seg = seg[m.end():]
        yield seg


def verdict(cmd):
    """(blocked, human_label). Pure: unit-testable without the harness."""
    if "ALLOW_DESTRUCTIVE_GIT=1" in cmd:
        return False, None
    for seg in commands_in(strip_noncode(cmd)):
        m = re.match(r"^git\s+(.*)$", seg, re.S)
        if not m:
            continue
        rest = m.group(1).strip()
        if STASH_READONLY.match(rest):
            continue
        for pat, label in DESTRUCTIVE:
            if re.match(pat, rest):
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
