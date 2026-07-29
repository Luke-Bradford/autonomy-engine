#!/bin/bash
# studio-build-loop -- ONE fresh headless Claude fire on the Mac mini.
# Mirrors the (paused) cloud routine: a short-lived process per fire = fresh
# context, driven entirely by prompt.md. Runs in an ISOLATED worktree so it
# never fights the supervisor's main checkout or the paused old-engine loops.
# Invoked by launchd every 2h (StartInterval) OR manually for a supervised fire.
#
# AUTH: subscription via keychain (NO api key -- operator hard rule).
#   * --bare is FORBIDDEN here: it strips the stored subscription login.
#   * --setting-sources project,local skips USER-level hooks (caveman/persona
#     output styles) while keeping the keychain auth intact.
#
# EFFORT: --effort high is passed EXPLICITLY and must stay explicit.
#   `--setting-sources project,local` strips the USER-level settings.json, which
#   is where `effortLevel` lives -- so the flag that (correctly) keeps the
#   operator's persona out of headless fires ALSO silently dropped effort to
#   DEFAULT. There are no project/local settings here to put it back. The loop
#   does unattended reducer-semantics surgery; it should not think LESS hard than
#   an attended session. Operator chose `high` over `max`: the driver chains
#   fires back-to-back (drive.sh MAX_FIRES, 6 at time of writing), so per-fire
#   cost compounds.
#   Do NOT "simplify" this away by trusting settings inheritance -- there is none.
set -uo pipefail

INFRA="/Users/lukebradford/Dev/studio-loop"
REPO="/Users/lukebradford/Dev/studio-loop-repo"
PROMPT="$INFRA/prompt.md"
TS="$(date +%Y%m%d-%H%M%S)"
LOG="$INFRA/logs/fire.$TS.log"

mkdir -p "$INFRA/logs"
cd "$REPO" || { echo "FATAL: worktree $REPO missing" >>"$LOG" 2>&1; exit 1; }

echo "=== studio-build-loop fire $TS START (repo=$REPO) ===" >>"$LOG"
git fetch origin --quiet >>"$LOG" 2>&1

claude -p "$(cat "$PROMPT")" \
  --model opus \
  --effort high \
  --fallback-model sonnet \
  --setting-sources project,local \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  >>"$LOG" 2>&1
rc=$?

echo "=== studio-build-loop fire $TS END (claude exit $rc) ===" >>"$LOG"
exit "$rc"
