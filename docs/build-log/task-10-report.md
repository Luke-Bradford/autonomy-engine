# Task 10 Report: `worktree_gc.sh` — generic `--repo` version

## Summary
✅ **DONE** — `bin/worktree_gc.sh` created, shellcheck clean, smoke test passed, committed and pushed.

## Steps Executed

### Step 1: Implement bin/worktree_gc.sh
- Created `/Users/lukebradford/Dev/autonomy-engine/bin/worktree_gc.sh` exactly as specified in the brief.
- File is a thin, verbatim port of eBull's existing `worktree_gc.sh`, changed only to accept `--repo <path>` parameter instead of hardcoding the repo.
- Made executable: `chmod +x bin/worktree_gc.sh`

### Step 2: Shellcheck
```bash
$ shellcheck -S warning bin/worktree_gc.sh
(no output)
```
**Result: CLEAN** — no warnings or errors.

### Step 3: Smoke Test
```bash
$ bin/worktree_gc.sh --repo "$(pwd)"

== prune stale worktree admin entries ==
== delete local branches merged into origin/main ==
  (0 merged branch(es) removed)
== remaining worktrees (loop/agent-specific = KEEP) ==
/Users/lukebradford/Dev/autonomy-engine f08b125 [main]
```
**Result: PASSED** — script runs cleanly, prunes worktree admin entries (none needed), deletes 0 merged branches (only main exists), and lists the remaining worktree correctly.

### Step 4: Commit and Push
```bash
$ git add bin/worktree_gc.sh
$ git commit -m "feat: add generic worktree_gc.sh (--repo parameterized)"
$ git push

[main 77bc70b] feat: add generic worktree_gc.sh (--repo parameterized)
 1 file changed, 48 insertions(+)
 create mode 100755 bin/worktree_gc.sh
To https://github.com/Luke-Bradford/autonomy-engine.git
   f08b125..77bc70b  main -> main
```
**Result: COMMITTED & PUSHED**

Commit SHA: `77bc70b` (full: `77bc70b7d0c65cd03e59ee68d1ebf8a4bf9a50f9`)

## Self-Review

- ✅ Shellcheck clean? Yes — no output, zero warnings.
- ✅ Smoke test ran cleanly, deleted 0 branches? Yes — only main exists, nothing deleted.
- ✅ Code exactly the brief's (verbatim port, only --repo parameterization)? Yes — copied exactly.
- ✅ Fetch-fail/origin-main-unresolved SKIP guard present? Yes — lines 44–48 handle the case.
- ✅ File executable? Yes — `chmod +x` applied.
- ✅ Commit message correct? Yes — "feat: add generic worktree_gc.sh (--repo parameterized)".

## Key Implementation Details

**The script:**
1. Accepts `--repo <target-repo-path>` as a required argument.
2. Changes into the target repo (exits if unable).
3. Prunes stale worktree admin entries via `git worktree prune -v`.
4. Safely deletes local feature branches already merged into `origin/main`:
   - Fetches origin and validates `origin/main` exists (if either fails, SKIPS deletion safely).
   - Preserves `main` and the current branch.
   - Uses `git merge-base --is-ancestor` to confirm full merge before deletion.
   - Counts and reports deleted branches.
5. Lists remaining worktrees (marked as "loop/agent-specific = KEEP" for documentation).

**bash-3 compatibility:**
- No `mapfile`, no globstar (`**`), no non-POSIX features.
- Uses `while IFS= read -r b; do ... done < <(git for-each-ref ...)` for branch iteration (bash-3 safe).
- All constructs compatible with `/bin/bash 3.2.57` on macOS.

## No Concerns
No issues found. Script is production-ready for use in the autonomy engine.
