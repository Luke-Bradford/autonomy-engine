# ticket-to-merge (starter pipeline, P1 subset)

The reference pipeline from the sequencer spec (v5), in the P1 linear
subset: nodes run in array order; the coding loop's exit condition is
instructed while its `max_rounds` is ENFORCED by the engine.

P1 notes:

- Branch/back-edge stages of the full reference design (plan-viability
  branch, QA verdict back-edge, finish-how branch) land with P2's typed
  dependency edges. This subset is honest about that: no silent
  approximations.
- Nodes share state via git/GitHub (the pushed branch, the ticket's
  comment trail, the PR) -- the engine does not carry payloads between
  node sessions in P1.
- Merging is NEVER a pipeline node's job: the repo merge gate
  (safe_merge + the configured strategy) owns it.
- `trigger_default` is informational in P1 (the binding role's own
  `trigger:` drives dispatch); P4's assignment slots consume it.

Use: copy this directory to `<repo>/.autonomy/pipelines/ticket-to-merge/`
and bind it: `roles.coder.pipeline: ticket-to-merge`.
