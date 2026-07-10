# ticket-to-merge (starter pipeline, v2 — typed edges)

The reference pipeline from the sequencer spec (v5), now with the real
dependency graph (P2a, #349): typed edges (success / failure / completion),
the QA failure path IN the graph, and the QA-verdict back-edge into the
coding loop under an ENFORCED 3-bounce cap.

Shape: pick → plan → ⟲ coding loop (exit instructed · max_rounds 5
enforced) → open the PR → qa-gather → three checks (verify · breakage ·
qa-review) → qa-verdict (needs all three green) → summarize →
journal-run. Any check's failure verdict routes to notify-park instead;
journal-run runs either way (join: any over two on-completion edges).
qa-verdict's failure verdict back-edges to the coding loop with the QA
comments as input; the 4th failure parks the PR for a human.

Notes:

- Parallelism is OPT-IN (SD-36): this template ships without
  `caps.max_parallel`, so nodes interleave one session per supervisor
  iteration. Set `"max_parallel": 2` (or 3) in `caps` to run the three QA
  checks as genuinely concurrent sessions — each gets its own ephemeral
  worktree. Caveat: concurrent sessions pushing ONE branch race each other;
  briefs that push should pull-rebase-push (the checks here only read and
  comment, so the fan is safe out of the box).
- Nodes whose failure verdict steers the graph get a compiled
  `pipeline:verdict` footer naming the exact verdict file — a session
  writes `{"outcome": "success"|"failure"}` there; writing nothing means
  the session's own outcome is the verdict.
- The v1 QA stage container is dissolved: container children cannot carry
  edges yet (stage+edges composition is P2b). Bind the qa account/model
  per node via `runs_as` if you want a different brain on the checks.
- Nodes share state via git/GitHub (the pushed branch, the ticket's
  comment trail, the PR) — the engine does not carry payloads between
  node sessions.
- A `concurrency: {policy: parallel}` trigger can run SEVERAL runs of this
  pipeline at once. The engine does not claim work items: the PICK brief
  must claim its ticket (assign/label at pick time) so overlapping runs
  never grab the same one — the SD-36 precedent (races are the briefs'
  concern, never silently absorbed by the engine).
- Merging is NEVER a pipeline node's job: the repo merge gate
  (safe_merge + the configured strategy) owns it.
- `trigger_default` is informational (the binding role's own `trigger:`
  drives dispatch); P4's assignment slots consume it.

Use: copy this directory to `<repo>/.autonomy/pipelines/ticket-to-merge/`
and bind it: `roles.coder.pipeline: ticket-to-merge`.
