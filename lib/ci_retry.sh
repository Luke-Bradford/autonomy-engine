#!/bin/bash
# lib/ci_retry.sh -- retry a command through TRANSIENT failures (CI resilience).
#
# Why (#505 / the 2026-07-16 night): the Claude PR Review workflow makes several
# LIVE API calls per run -- `gh pr diff`, `gh api .../comments`, `gh pr view`,
# `gh pr comment`, and a `curl` to the Anthropic API. CI and studio-ci make no
# such calls mid-job, so when GitHub's API had a ~90-minute rough patch (503s +
# flaky fetches) it failed ONLY the review job: a red required check, a "run
# failed" email, and a wasted headless-loop retry cycle -- for a fault that
# cleared in seconds. Resilience is proportional to a job's external surface;
# the review job has five transient-failure surfaces and had none retried.
#
# `retry` absorbs the blip: a 503 costs a short backoff, not a failed job.
#
# FAIL-SAFE: retry NEVER turns a persistent failure into a pass. It re-runs the
# EXACT command and, once attempts are exhausted, returns the command's OWN exit
# status -- so a genuinely-broken call still reds the step. It only ever hides a
# failure that later SUCCEEDS on retry, which is the definition of transient.
#
# bash 3.2 compatible. Functions-only (sourced by workflow steps + the test);
# the guard at the end keeps a direct `bash lib/ci_retry.sh` a no-op.

# retry <max_attempts> <base_backoff_s> <command> [args...]
#   Runs the command; on non-zero exit, backs off <base>*<attempt> seconds and
#   retries, up to <max_attempts> total. Returns 0 on the first success, else the
#   command's LAST exit status.
#
#   A command that redirects its own output (`gh pr diff > pr.diff`) must be
#   wrapped in a shell function so every attempt re-runs the redirect cleanly:
#       fetch() { gh pr diff "$PR_NUMBER" > pr.diff; }
#       retry 5 3 fetch
#
#   A command that must NOT be retried on a given failure (e.g. a permanent HTTP
#   4xx) should `exit` from inside its wrapper function rather than `return`,
#   so retry never sees it.
retry() {
  # `local` (bash 3.2 supports it) so retry never clobbers a caller's names when
  # sourced alongside other logic. Assign from positionals/literals only -- never
  # `local x=$(cmd)`, which would mask the command's exit status.
  local retry_max="$1"
  local retry_base="$2"
  local retry_n=1
  local retry_rc=0
  local retry_sleep=0
  shift 2
  while true; do
    # Capture the command's OWN exit status directly. `if "$@"; then ...; fi`
    # would make $? afterwards 0 (an if-compound succeeds when its condition is
    # false with no failing else), so the give-up path would return 0 -- a
    # FAIL-OPEN bug that reports a persistent failure as success. Run then read.
    "$@"
    retry_rc=$?
    if [ "$retry_rc" -eq 0 ]; then
      return 0
    fi
    if [ "$retry_n" -ge "$retry_max" ]; then
      echo "retry: '$*' failed after $retry_n attempt(s) (last rc=$retry_rc) -- giving up" >&2
      return "$retry_rc"
    fi
    retry_sleep=$(( retry_base * retry_n ))
    echo "retry: '$*' failed (rc=$retry_rc); attempt $retry_n/$retry_max, backing off ${retry_sleep}s" >&2
    [ "$retry_sleep" -gt 0 ] && sleep "$retry_sleep"
    retry_n=$(( retry_n + 1 ))
  done
}

# Functions-only: when sourced (the only real entry point) this returns here with
# `retry` defined; a direct execution falls through to a no-op.
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0
