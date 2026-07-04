# loop-coexistence — attended sessions alongside the live loop

The unattended loop drains the same board you are working, on a few-minute
cadence, from its own checkouts. An attended session that ignores it will
race it (2026-07-04: both built #258's center zone in parallel; the loop's
slices merged first and the attended duplicate was correctly closed).

## Before claiming a ticket interactively

1. **Read the ticket's LIVE comments first** — the loop posts coordination
   state there every pass (parked findings, "slice N shipped", scoping
   notes). Memory/summaries go stale within hours on a hot board.
2. **Check what the loop is doing NOW**: the dashboard's center card /
   `git log --oneline -10 origin/main` (its merge cadence is visible) /
   open PRs. A ticket whose slices are landing every ~15 minutes is ITS
   ticket tonight.
3. **Removing `loop-ready` does NOT stop in-progress work** — the rail
   continues a multi-slice ticket it already started. The loop's own claim
   signals are its issue comments and your WORKTREE: a live-dirty worktree
   on a ticket branch bars the loop from that scope (it checks).

## While building alongside it

- `git fetch origin` every ~15 minutes on a loop-hot area; a stale base
  means full re-integration (main moved 5 commits during one rebase).
- Expect the loop to GATE-CHECK AND MERGE any open PR it finds — including
  yours — and to re-point the main checkout's HEAD afterwards. After
  pushing from a shared checkout, go read-only there; build in an isolated
  worktree.
- Write ticket specs as HANDOFFS, not notes-to-self: the loop builds open
  specs within the hour (#211's interim slice shipped ~50 minutes after the
  spec comment). If you spec it and don't want it built, say so in the
  ticket.

## When you collide anyway

Stand down on the overlap, rebase onto the merged foundation, keep only the
non-overlapping remainder, and leave a retraction/coordination comment on
the ticket. Racing costs more than the code is worth — the merged side has
already passed the gate.
