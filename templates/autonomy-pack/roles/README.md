# .autonomy/roles/ — role prompts

One markdown file per role. The file IS the role's system prompt — the pack's
single source of truth, never copied elsewhere (the engine and any workflow
read this exact path).

## Standard roles

- `qa.md` — scaffolded by onboard; used by the qa-merge-gate workflow
  (`templates/qa-merge-gate.yml` in the engine repo) when `roles.qa` is
  enabled with `substrate: actions`.
- `researcher.md` — scaffolded by onboard; the read-only, cron/manual
  forward-looking deep-dive (understands the app/board/stack and surfaces
  findings via the `output:` knob). Enable it with the `researcher:` example in
  `config.yaml`.
- `pm.md` — scaffolded by onboard; the cron board-groomer (labels are the
  routing contract; duties keyed to the `duties:` knob; human decisions
  escalate via the fenced `autonomy-question` schema the dashboard's
  needs-you queue parses). Enable it with the `pm:` example in `config.yaml`.

## Custom roles

Any role name works. Declare it in `.autonomy/config.yaml` with the same
shape as the standard four, point `prompt:` here, and the control-room
dashboard renders it generically (name + substrate badge + trigger + status):

```yaml
roles:
  security_sweeper:
    enabled: true
    substrate: actions          # engine | managed_agents | routine | actions
    trigger:
      type: event               # loop | cron | event
      on: [pr.opened]           # pr.opened | pr.synchronize | issue.created | merge.done | session.done
    prompt: .autonomy/roles/security_sweeper.md
```

Rules (enforced by `doctor.sh` via the engine's roles validator):
- `prompt:` must be a repo-relative path to a file that exists inside this
  repo — absolute paths and `../` escapes are rejected;
- `substrate`/`trigger.type` must be one of the enums above;
- `cron` triggers need a `schedule:`, `event` triggers need a non-empty
  `on:` list whose tokens are all from the known event vocabulary
  (`pr.opened`, `pr.synchronize`, `issue.created`, `merge.done`, `session.done`).

Declaring a role does not run it — a substrate has to pick it up (the coder
loop is the engine; QA-on-actions is the qa-merge-gate workflow; other
substrates are wired per role as they land).
