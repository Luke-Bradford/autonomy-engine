---
name: pipeline-sessions
description: Use when your prompt is a compiled pipeline brief — it contains engine-framed sections such as a pipeline node id and type, loop round counters, or instructions to write a verdict file.
---

# pipeline-sessions — working as one node of a pipeline run

Your session is one activity inside a larger pipeline run. The engine
compiled your brief, dispatched you, and will route the run based on your
outcome. (The routing rules are ENFORCED by the engine — this skill
explains what your side of the contract means.)

## Reading the compiled brief

The brief has fenced, engine-written sections around the activity's own
instructions: which node you are (id + type), the repository scope rules,
and — inside a loop — the current round and the round cap. The activity
text between those sections is your actual job; the framing tells you how
much room you have.

## The verdict file (when the brief names one)

Some briefs instruct you to write a small JSON verdict file at a given
path. It carries up to two independent keys:

- `{"exit": true}` — ONLY inside a loop, and ONLY when the loop's stated
  exit condition is genuinely met, with evidence (e.g. the named tests
  actually pass in this session). Absent or false = the loop runs another
  round, up to its cap. Never write `exit: true` to escape a loop you
  could not finish — the cap and the failure paths exist to handle that
  honestly.
- `{"outcome": "success"}` or `{"outcome": "failure"}` — your judgment
  verdict, when the activity is a decision point (a review, a check).
  This steers which edge fires downstream and can OVERRIDE your session's
  own success: a session that ran fine but found problems writes
  `"failure"` — that is the designed way to send work back or divert to a
  recovery path.

Both keys may appear in one file, and each degrades separately when the
file is malformed or missing: a loop simply does NOT exit (another round
runs, or the cap ends it — missing evidence never exits a loop early),
and a decision point falls back to your session's raw success/error. So
write the file carefully or not at all — you cannot accidentally exit a
loop, but you can accidentally lose a failure verdict you meant to send.

## Caps and pacing

Round caps, session caps, and bounce caps are enforced by the engine, not
suggestions. Don't stall a round hoping for more; do the most complete
honest increment the round allows, report precisely what remains, and let
the loop's next round (or the cap's park path) continue. A run that ends
"capped" and parks for a human is a CORRECT outcome — a padded success is
not.

## Failure is routable

An error outcome fires the failure edges — notify, park, bounce-back —
that the pipeline's author designed for exactly that case. State clearly
WHAT failed and where; the next activity in the failure path reads your
output as its context.
