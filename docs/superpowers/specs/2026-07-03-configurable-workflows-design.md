# Configurable Workflows — design spec (the product flow)

> Status: **operator-delegated design** (2026-07-03). The operator granted full autonomy ("run
> this, don't gate anything on me, you have my input") and asked for a coherent product flow, so
> this design is authored from their stated requirements rather than an interactive brainstorm.
> Umbrella spec for issue #83; each increment (W1-W7) gets its own spec→plan→PR. Supersedes nothing
> — it *composes* the agent-org model (`2026-07-02-dynamic-agent-org-design.md`) into a product.

## The vision (operator's words, synthesised)

> "A loop I could point at a repo and it just builds and future-thinks, keeping on top of testing
> without much of my input" — with "the ability to configure the workflows, pick the agents, how
> they should and shouldn't behave, create our own dynamic approach to loops", surfaced in "an easy
> approach" that "allows API, Codex, local LLM for other agents."

So the product is a **configurable, multi-provider, multi-agent autonomous engineering loop**:
point it at a repo, keep the sensible defaults or compose your own workflow of agents (each on any
provider), and it runs — builds features, tests like a human, researches and future-thinks, gated
by *your* rules — with minimal input and an easy config surface.

## What already exists vs what this adds

**Exists (built, increments 1-3 + BYO-LLM #78):** the **agent model** — a role is a named worker
with an `account` (provider: `claude_subscription` / `codex_subscription` / `anthropic_api` /
`openai_api` / `openai_compatible`+local), a `model`, a `prompt` (behaviour rails), a `scope`, and
behaviour knobs; the supervisor headless-dispatches enabled `loop` roles round-robin. So
**multi-provider-per-agent and custom-named agents are already real.**

**This design adds the layers that make it a *workflow product*:**
1. **Composition** — wire agents together with triggers + gates + handoffs (a *workflow*, not just
   a bag of roles).
2. **An easy config surface** — author it from the config page (forms) *and* a chat box (describe
   it in words; a chat agent edits the config for you).
3. **A default that just works** — point-and-go, then customise.
4. **Future-thinking + keep-on-testing behaviour** — the researcher and QA agents.
5. **Easy onboarding** — pick a local repo or link a GitHub one, VS-Code-like.
6. **A solid runtime** — the dashboard as a managed, health-reporting, hard-killable service.

## Core concepts (the workflow model)

| Concept | What it is | Where it lives |
|---|---|---|
| **Agent** | named worker: `account`(provider) + `model` + role-`prompt` + `scope` + behaviour knobs | `roles:` in `.autonomy/config.yaml`; prompt in `.autonomy/roles/<name>.md` |
| **Trigger** | when it runs: `loop` (continuous) / `cron` (schedule) / `event` (board/PR state) | `trigger:` on the agent |
| **Gate** | how far it can act: raise-issue → open-PR → approve → **merge**, bounded by `merge_gate` + a per-agent `gate` knob (human-approves vs agent-approves-and-merges) | `gate:` knob + `merge_gate.strategy` |
| **Handoff** | agent A's output feeds agent B — emergent from triggers + board state (Researcher→PM→Coder→QA→human) or explicit | board labels + events |
| **Workflow** | the whole composition for a repo: which agents, triggers, gates, handoffs | the repo's `roles:` block (+ a small `workflow:` block for defaults/ordering) |

**Nothing here hard-codes org policy.** A workflow is data (config), authored from the UI/chat,
validated by `roles.py`, executed by the supervisor. "Create your own dynamic approach to loops" =
edit the workflow; no engine change.

## The default workflow (out-of-box — "just works")

Point at a repo → scaffold a sensible default so it runs with zero configuration, then customise:

```
Researcher (cron, future-thinks) ─ enriches the board with opportunities/updates/gaps
        │
PM (cron) ─ grooms, prioritises, spec-checks, labels `ready`
        │
Coder (loop, scope=ready) ─ builds prioritised items, self-tests ─▶ opens PR
        │ emits pr.opened
QA (event) ─ tests the diff, thinks like a human (correctness + UX + docs + do the numbers add
             up), raises bugs/regressions ─▶ gates the merge per your knob
        │
Anything blocked / unclear / QA-flagged ─▶ the "needs human" queue on the dashboard
```

Default providers = cloud (the operator's Claude subscription); any agent can be swapped to Codex
or a local LLM (e.g. Researcher/PM prep on the local model to save tokens — BYO-LLM #78). Default
gate = `wait-for-human` (QA raises, you merge); flip to `auto-merge-on-pass` per agent when you
trust it. The whole default is a template the operator can edit or replace.

## The easy config surface (two ways, same underlying config)

1. **Config page (forms).** Create / edit / clone / name an agent; pick its provider (account) and
   model (from the live model-discovery list, #82); set trigger (loop/cron/event + schedule),
   scope (labels/paths/milestone), gate, tools, and its prompt; see the workflow as a diagram.
   This is agent-org increment 5.
2. **Chat box (natural language).** A chat panel — backed by the operator's Claude or Codex — that
   *edits the workflow config from words*: "add an agent that researches competitors every night";
   "the tester should only look for bugs and regressions and raise them against the ticket it's on,
   but I approve PRs myself." The chat agent proposes a config diff (validated by `roles.py`),
   shows it, and applies it on confirm. It configures the org; it does not silently act on the
   repo. This is genuinely new (W4).

Both write the same `.autonomy/config.yaml` `roles:`/`workflow:` block; files stay the source of
truth (editable by hand too).

## Easy onboarding (VS-Code-like)

- **Pick a local repo** → the engine reads its GitHub remote for push/pull (via `gh`), scaffolds
  the pack + the default workflow, registers it. (Mechanism exists as `start <repo>`/`quickstart`;
  this makes it a UI flow.)
- **Link a GitHub repo** → clone it, then the same scaffold. Choose where it lives locally.
- Front door: `./start` on an unconfigured machine opens the browser at onboarding, not a CLI
  dead-end (agent-org spec already commits to this).

## Increments (decomposition — the buildable tickets)

Each is its own spec→plan→PR; most are loop-buildable once scoped. Ordered by dependency + value.

- **W1 — Scheduler (cron triggers).** A tick fires `trigger.type: cron` agents on schedule (lean
  launchd, per the agent-org spec). Unblocks PM/Researcher. *(agent-org increment 4a)*
- **W2 — Event bus (event triggers).** Emit `pr.opened`/`pr.synchronize`/`issue.created`/
  `merge.done` (gh-poll first); `trigger.type: event` agents wake on them → QA reacts to PRs,
  choreography emerges. *(4b)*
- **W3 — Config-page authoring.** Create/edit/clone/name agents + workflow from the UI; provider +
  model pickers (needs #82 model discovery). *(increment 5)*
- **W4 — Chat-driven config.** The chat box that edits the workflow from natural language
  (proposes a validated config diff, applies on confirm). *(new)*
- **W5 — Role rails + default workflow.** The PM/QA/Researcher/Coder prompt rails + the default
  template + the behaviour knobs wired (QA gate/scope/regression; Researcher future-think +
  web_search; PM duties; Coder self-test/blockers) + the "needs human" dashboard queue.
  *(increment 6)*
- **W6 — Easy onboarding UI.** Pick-local / link-GitHub from the dashboard; the VS-Code-like flow.
  *(increment 5+)*
- **W7 — Solid runtime.** Dashboard as a managed launchd service with start/status/hard-kill + a
  positive health signal + faster (async) state. *(ties #80, #81)*

Multi-provider-per-agent is **already done** (accounts + BYO-LLM #78) — every increment above just
picks an account. Model discovery (#82) feeds W3/W4's pickers.

## Constraints & invariants (inherited, CI-enforced)

- macOS bash 3.2.57; Python 3 stdlib only; source-guards; `shellcheck -S warning` clean.
- **Config edits (page or chat) go through `roles.py` validation and never bypass the merge gate.**
  The chat agent proposes config; it does not merge code or act on the repo outside the workflow it
  writes. `merge_gate.strategy` stays the merge authority; `gate: auto-merge-on-pass` still routes
  through it + branch protection — never a silent merge.
- Fail-safe never fail-open; no secrets in the accounts/credentials index; repo-agnostic `bin/`/
  `lib/`; safe defaults (only Coder on by default until the operator opts a workflow in).
- Every agent's provider is a first-class per-agent choice (account); local LLMs plug in exactly
  like cloud (BYO-LLM). Nothing here ships or mandates a specific model.

## Open questions (resolved as each Wn is specced, not blocking)

- `workflow:` block shape vs pure emergence from `roles:` triggers + board — lean: keep it emergent
  (roles + triggers + labels), add an explicit `workflow:` only if ordering can't be expressed by
  scope/labels.
- Chat config-diff UX (W4): apply-on-confirm vs auto-apply — lean: propose + confirm (never silent
  config changes).
- The "future-thinking" researcher's output (W5): raise-issues vs handoff-to-PM — already a knob;
  default handoff-to-PM so a human/PM triages before the board fills with speculative work.
- Meta/product agent (the operator's "an agent thinking about what's needed"): model it as just
  another agent in the default workflow — a "product" role (cron) that audits the app + board and
  raises gap issues. Falls out of W5 (rails) + W1 (cron); no special mechanism.
