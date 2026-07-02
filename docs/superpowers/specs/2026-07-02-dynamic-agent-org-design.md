# Dynamic agent org — design spec

> Status: **approved in direction** by the operator (2026-07-02) via a brainstorming session.
> Supersedes the hard role→substrate mapping in [`docs/agent-org-design.md`](../../agent-org-design.md).
> Not built yet. This spec defines the *config model* that makes the multi-role org fully
> declarative and configurable, and decomposes it into build increments.

## What this revises

`agent-org-design.md` hard-codes a substrate per role — "PM → Managed Agents", "Researcher →
Managed Agents", "QA → Actions". The operator's correction: **substrate was never meant to be
fixed.** Every role is a headless agent the engine runs (exactly how the Coder loop runs today),
triggered by cron / event / another agent, self-gating on whether to run. Each agent picks
**which account it calls from** — a Claude subscription, a Codex/OpenAI subscription, or an API
key on a named account. Managed Agents stops being a mandate and becomes (later, optionally) just
another account kind.

The goal is a loop **dynamic enough for any business**: agents, accounts, triggers, scope, and
rails are all declarative and editable from the config page — no engine change to reshape the org.

## Principles

1. **Headless-first.** The default execution substrate is the engine itself (a CLI adapter
   invocation, like `supervisor.sh` runs Coder today). No hosted platform required to run PM/QA/
   Researcher. Managed Agents / GitHub Actions are optional account kinds, not defaults.
2. **Auth is a per-agent choice against a named account.** An agent references an account by name;
   the account resolves to either a subscription CLI login (secret-less) or a Keychain-stored API
   key (the #51 credentials store). "Which account each agent calls from" is a first-class config.
3. **Behaviour is declarative where it can be, prompt-driven where it must be.** Structural knobs
   (trigger, account, model, scope, gate mode) live in `config.yaml`; open-ended behaviour
   (how QA reasons, how PM grooms) lives in each role's `.autonomy/roles/<name>.md` rails. The
   engine never hard-codes org policy.
4. **Choreography is emergent, not separately coded.** Researcher → PM → Coder → QA → human is a
   consequence of triggers + board state, not a bespoke pipeline. Agents react to events and read
   the board; the org shape falls out of their individual configs.
5. **Existing invariants hold** (per `CLAUDE.md`): macOS bash 3.2, Python stdlib only,
   `merge_gate.strategy: manual` safe default, fail-safe never fail-open, repo-agnostic.

---

## Layer 1 — Accounts (named auth instances)

A machine-level registry (subscriptions and keys are not per-repo). Extends the #51 credentials
store: an **account** is the classifier layer on top of a credential (or a subscription login).

```yaml
# ~/.config/autonomy/accounts   (stdlib JSON; secrets are NOT here — see below)
accounts:
  claude-sub:     { kind: claude_subscription }
  codex-sub:      { kind: codex_subscription }
  anthropic-work: { kind: anthropic_api, credential: work-key }   # → Keychain label (#51)
  openai-side:    { kind: openai_api,    credential: oai-key }
```

**Account kinds** (initial set): `claude_subscription`, `codex_subscription`, `anthropic_api`,
`openai_api`. Subscription kinds are **secret-less** — they use the CLI login already on the
machine (`claude` / `codex`), so the agent runs with no exported key. API kinds carry a
`credential` pointing at a Keychain label from the #51 store; the secret itself never leaves the
Keychain and never lands in this file.

**Storage & security.** The accounts file holds only names, kinds, and credential *labels* — no
secrets, mode 600, atomic writes (same discipline as the #51 index). Resolution of an account to
usable auth happens at run time: subscription → nothing exported (CLI login); API → export
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in a session-scoped subshell (generalises #51-C).

**Consumers.** The config page manages accounts (create/rename/delete, pick kind, link a
credential). Agents reference them by name. `resolve_account(name)` returns `{kind, env}` where
`env` is the session-scoped export set (empty for subscriptions).

---

## Layer 2 — Agents (each references an account)

Extends the existing `roles:` block (`lib/roles.py`). Every agent — standard or custom — is the
same declarative shape:

```yaml
roles:
  coder:
    enabled: true
    account: claude-sub
    trigger: { type: loop }
    model: claude-sonnet-5
    effort: high
    scope: { labels: [ready], milestone: current }
    prompt: .autonomy/roles/coder.md
  qa:
    enabled: true
    account: anthropic-work
    trigger: { type: event, on: [pr.opened, pr.synchronize] }
    model: claude-opus-4-8
    scope: { target: diff }              # diff | affected | full-regression
    gate: wait-for-human                 # wait-for-human | auto-merge-on-pass
    tools: [read, mcp]                   # code-only vs MCP-enabled
    prompt: .autonomy/roles/qa.md
  researcher:
    enabled: false
    account: codex-sub
    trigger: { type: cron, schedule: "0 3 * * *" }
    output: raise-issues                 # raise-issues | handoff-to-pm
    web_search: true
    prompt: .autonomy/roles/researcher.md
  pm:
    enabled: false
    account: claude-sub
    trigger: { type: cron, schedule: "0 */6 * * *" }
    duties: [groom, prioritise, unblock, spec-check]
    prompt: .autonomy/roles/pm.md
```

**Common fields:** `enabled`, `account`, `trigger`, `model`/`effort`, `scope`, `prompt`. The old
`substrate:` field is dropped from the common case (default = engine headless); it may return
later only as a per-account-kind execution hint.

**`scope` — what an agent works over.** `labels: [...]`, `milestone: <name|current>`,
`query: <gh search>`, `paths: [...]`. This answers "will a coder only look for labelled work" —
yes, if `scope.labels` is set; the PM is what puts `ready` on issues. Empty scope = whole open
board (today's behaviour).

**Per-phase model selection (sub-project D).** Optional `models:` map overrides `model` per phase:

```yaml
    models: { plan: claude-opus-4-8, implement: claude-sonnet-5, test: claude-haiku-4-5 }
```

Absent → the single `model` is used for everything (today's behaviour). Phases are advisory hints
the adapter passes to the agent; the engine does not force a phase state machine.

**Role behaviour knobs (answering the operator's specific questions), all defaulted safe:**

| Role | Knob | Values | Default | Question it answers |
|---|---|---|---|---|
| QA | `gate` | `wait-for-human` \| `auto-merge-on-pass` | `wait-for-human` | "should QA approve or wait for a human before merge" |
| QA | `scope.target` | `diff` \| `affected` \| `full-regression` | `diff` | "only the issue or surrounding areas" |
| QA | `tools` | `[read]` \| `[read, mcp]` | `[read]` | "just look at code or use MCP" |
| QA | `regression` | `{ every: cron }` \| `{ after_tickets: N }` \| off | off | "scheduled regression / after x tickets" |
| Researcher | `output` | `raise-issues` \| `handoff-to-pm` | `handoff-to-pm` | "raise tickets directly or talk to PM" |
| Researcher | `web_search` | bool | `false` | "web searches" |
| PM | `duties` | subset of `[groom, prioritise, unblock, spec-check]` | all | "ensure spec clear, prioritise board, sort for workers" |
| Coder | `self_test` | bool | `true` | "should agents test their work" |
| Coder | `blockers` | `raise-to-pm` \| `raise-to-human` | `raise-to-pm` | "coder raises blockers for the PM" |

Behaviour beyond these knobs lives in the role's prompt file (its rails). `gate` still passes
through `merge_gate.strategy` — QA never silent-merges past the safe default.

**Custom agents.** Any additional `roles:` entry with a name + prompt is a custom agent; the
config page and dashboard render it generically (already true since #16). "Create your own agent"
= add an entry + a `.autonomy/roles/<name>.md`, both from the config page.

---

## Layer 3 — Execution (what the engine grows)

Three mechanisms, each small and independently testable.

1. **Headless dispatch (generalise the Coder loop).** `supervisor.sh` already runs one agent via
   a CLI adapter with a resolved account (#51-C). Generalise to run *any* enabled agent the same
   way: resolve its account → export env (subscription = none) → invoke the adapter with the
   agent's model/effort/prompt/scope. One code path for all roles.

2. **Scheduler (cron triggers).** A tick fires `trigger.type: cron` agents on their schedule.
   Two options (decide at plan time): a launchd plist per cron-agent (native, survives reboot,
   matches `setup_worktree.sh`), or an internal timer in a long-lived supervisor. Lean launchd —
   no new always-on process, and the engine already installs plists.

3. **Internal event bus (event triggers — the "react to actions in the loop" piece).** The engine
   emits events on state transitions — `session.done`, `pr.opened`, `pr.synchronize`,
   `issue.created`, `merge.done` — and `trigger.type: event` agents wake on the ones they listen
   for (`on: [...]`). Sourced primarily from `gh` polling at first (cheap, within rate limits),
   webhook upgrade later. This is what makes the org a *flow*: Coder opening a PR wakes QA without
   either knowing about the other.

---

## Org choreography (emergent)

Not separately coded — a consequence of Layer 2 configs + board state:

```
Researcher (cron) ── loads/enriches issues ──▶ board
                                                 │
PM (cron) ── grooms, prioritises, spec-checks, labels `ready`, unblocks ──▶ board
                                                 │
Coder (loop, scope=ready) ── works prioritised items, self-tests ──▶ opens PR
                                                 │  emits pr.opened
QA (event) ── reviews (diff|affected|regression), raises bugs/regressions ──▶ gate merge
                                                 │
Blockers / unclear specs / QA-flagged issues ──▶ "needs human" surface (dashboard)
```

**Human-in-the-loop surface.** A dedicated **"needs human"** queue on the dashboard aggregates:
Coder blockers escalated past PM, PM items marked `needs-human`, QA blocking findings, and any
agent that raised a clarification. Each entry says *which agent, which ticket, what it needs* — so
"how does a human know what actions they need to help with" is answered by one screen, not by
watching logs. Sourced from a label convention (`needs-human`) + agent-emitted events.

---

## Config page as the front door

`./start` on a fresh machine currently dead-ends at CLI guidance. Revise: with nothing set up,
`./start` should **launch the dashboard and open the browser at the config page**, which becomes
the authoring surface for everything above — accounts, agents (standard + custom), their trigger/
schedule, account assignment, model(s), scope, and behaviour knobs. Driving config from files
stays supported; the page is the primary path. This folds sub-project A (onboarding UX) into the
config page built in #47/#51-B.

---

## Constraints & invariants

- macOS bash 3.2.57; Python stdlib only; source-guarded scripts; `shellcheck -S warning` clean.
- Accounts file: names/kinds/labels only, **no secrets**, mode 600, atomic. Secrets stay in the
  Keychain (#51). Subscription accounts export nothing.
- `merge_gate.strategy` remains the merge authority; `gate: auto-merge-on-pass` still routes
  through it and branch protection — never a silent merge.
- Repo-agnostic; safe defaults (only Coder enabled; QA `wait-for-human`; empty scope = today).
- Fail-safe: an unresolvable account / missing credential falls back to subscription or refuses
  the run with a clear reason — never runs with broken auth silently.

---

## Build increments (decomposition)

Ordered; each is its own spec→plan→PR cycle. Buildable-now vs gated noted.

1. **Accounts registry** — `lib/accounts.py` (kinds, resolve-to-env, extends #51 credentials);
   config-page Accounts section. *Buildable now, subscription + API, no API spend to build.*
2. **Agent-config schema** — extend `roles.py`/`config_parser` for `account`, `scope`, `models`,
   and the behaviour knobs; `doctor`/`onboard` validation. *Buildable now.*
3. **Headless multi-agent dispatch** — generalise `supervisor.sh` to run any enabled agent via
   its resolved account. *Buildable now; running non-Coder roles for real is where behaviour gets
   validated.*
4. **Scheduler + event bus** — cron firing (launchd) + internal event triggers (`gh`-poll first).
   *Buildable now.*
5. **Config page authoring** — create/edit accounts + agents + schedules + scope from the page;
   `./start` opens the browser to it. *Buildable now.*
6. **Role rails + behaviour** — the `.autonomy/roles/*.md` prompts + wiring the behaviour knobs
   (QA gate/scope/regression, PM duties, Researcher output, Coder self-test/blockers, human
   queue). *The prompts are buildable; validating them running for real may want operator
   sign-off on cost if an API account is chosen.*

Managed Agents as an account kind is explicitly **deferred** (optional, later) — not needed for
the subscription-first org.

## Open questions (resolve at plan time, not blocking)

- Scheduler: launchd-per-agent vs one internal timer. (Lean launchd.)
- Event source: `gh` poll cadence vs webhook upgrade path.
- Per-phase models: advisory hint vs enforced phase machine. (Lean advisory.)
- "needs human" surface: label convention vs a dedicated state file. (Lean label + event.)
