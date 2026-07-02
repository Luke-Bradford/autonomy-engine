# Multi-role agent org — design

> **⚠️ Partially superseded (2026-07-02).** The role→substrate *mapping* below (PM/Researcher →
> Managed Agents, QA → Actions) is **no longer the design** — substrate is now a per-agent choice,
> every role runs headless in the engine by default, and each agent picks a named *account*
> (subscription or API key). See
> [`superpowers/specs/2026-07-02-dynamic-agent-org-design.md`](superpowers/specs/2026-07-02-dynamic-agent-org-design.md).
> The trigger taxonomy (loop/cron/event) and the QA robustness / empirical-gate notes here remain
> valid background.

> Status: design approved in direction by the operator (2026-07-01); this spec turns the
> research in [control-room-research.md](control-room-research.md) into a buildable plan and the
> backlog issues that follow it. **Not built yet** — the engine today runs a single hand-rolled
> Coder loop. This is the #1877 "multi-role org" successor, updated with facts the original
> [managed-agents-comparison.md](managed-agents-comparison.md) predates (Claude Code *routines*;
> the mid-run rate-limit-resume gap).

## The question this answers

The operator wants Coder + PM + QA + Researcher (+ custom) roles, per repo, enable/disable-able,
where PM/Researcher run on a schedule, QA reacts to approved PRs and gates the merge, and the
operator can add custom roles and say *when/where* each fires. The core design question:
**how much is cron-scheduled vs a loop that listens/reacts vs event-triggered?**

## Principle (from surveying the field)

Devin, Factory, Copilot, Sweep, OpenHands, AutoGen, CrewAI, LangGraph, Amp, Sourcegraph — **none
uses a continuous polling loop as its trigger.** The decision rule they collectively imply:

- **Continuous loop** — only when work is *unbounded, back-to-back, and needs precise
  rate-limit-aware pacing*. This is the engine's Coder loop. Nothing off-the-shelf does the
  pacing well, which is exactly why `supervisor.sh` stays hand-rolled.
- **Event** — when a *specific state transition* must be reacted to promptly and the event is
  cheap to receive (GitHub webhook / Actions).
- **Cron** — when work is *discoverable by a periodic scan* and latency-tolerant.

## Role → trigger → substrate

| Role | Trigger | Substrate | Rationale |
|---|---|---|---|
| **Coder** | continuous **loop** | hand-rolled **engine** (`supervisor.sh`) | unbounded board-drain; precise sleep-until-reset; keep as-is |
| **QA** (gate merge) | **event** — PR approved + CI green on head SHA | Claude Code **routine** (native `pull_request`/`check_run` webhooks) or **GitHub Actions** (`workflow_run` + `pull_request_review`) | the trigger *is* a discrete GitHub transition; Actions carries the write token to complete the merge; no hosted listener needed. Bounded self-heal like Sweep (base green + <2 attempts). |
| **PM** (triage/groom) | **cron** (few×/day) | **Managed Agents** coordinator | bounded periodic sweep; latency-tolerant; natural coordinator of the roster |
| **Researcher** | **cron** (daily/weekly) + manual-run | **Managed Agents** | explicitly periodic, read-only, no merge path |
| **Custom** | operator picks `loop`/`cron`/`event` | operator picks substrate | one config shape, operator declares when/where |

**QA robustness:** push-primary + poll-backstop. Native branch protection (required check +
required approval) owns the hard veto; the QA agent owns *intelligence + the merge trigger* by
posting its verdict as a required check run. A low-frequency `gh` reconciler (~every few min,
well within GitHub's 5000/hr) catches dropped webhook events. Re-arm on `pull_request.synchronize`
(new commits invalidate both approval and CI).

## Config schema (extends `.autonomy/config.yaml`, same stdlib parser)

Adds a `roles:` block; `agent`/`merge_gate`/`board` stay as top-level single-source-of-truth.
Every role = enable/disable + substrate + trigger, with trigger-specific sub-fields shown only
for the type that uses them (mirrors the existing `merge_gate.strategy` conditional-field style).

```yaml
roles:
  coder:
    enabled: true
    substrate: engine            # engine | managed_agents | routine | actions
    trigger: { type: loop }
    instances: 1                 # parallel loop count (bounded by account headroom)
    # model/fallback fall through to top-level agent.* unless overridden here

  pm:
    enabled: false
    substrate: managed_agents
    trigger: { type: cron, schedule: "0 */6 * * *" }
    role: coordinator            # native-multiagent role hint
    prompt: .autonomy/roles/pm.md

  qa:
    enabled: false
    substrate: actions           # or: routine
    trigger:
      type: event
      on: [pull_request_review.approved, workflow_run.completed]
      reconcile_cron: "*/10 * * * *"   # poll backstop for missed events
    scope: diff                  # diff | affected | full_regression
    completes_merge: true        # still bottlenecked by merge_gate.strategy (never silent-merge)
    prompt: .autonomy/roles/qa.md

  researcher:
    enabled: false
    substrate: managed_agents
    trigger: { type: cron, schedule: "0 3 * * *" }
    prompt: .autonomy/roles/researcher.md
```

Rules baked in (consistent with CLAUDE.md invariants): only `coder` enabled by default;
`prompt:` points at a real pack file (`.autonomy/roles/*.md`), never a shadow copy; QA's
`completes_merge` is still gated by `merge_gate.strategy` (safe default `manual`, never silently
auto-merges); `substrate` routes a role to engine vs managed-agents vs routine vs actions —
the hybrid made explicit and per-role.

## Two Anthropic substrates (both Claude-only; Codex roles stay hand-rolled)

- **Managed Agents** (scheduled deployments): **cron-only** trigger + manual + pause/resume;
  native multiagent = coordinator + roster (≤20 agents, ≤25 threads), messaging via the
  coordinator; self-hosted sandbox worker for tool exec on operator networks; vaults for secrets;
  per-firing `deployment_run` audit record. Webhooks are outbound-notification only.
- **Claude Code routines**: trigger on **cron + GitHub webhooks** (`pull_request`, `push`,
  `issue`, `check_run`, `workflow_run`, `release`; filter by label/branch/merged) **+ per-routine
  HTTP endpoint**. The native event path the reactive QA role wants.

## Dashboard surfacing (the page is designed for this now)

Per-repo **Roles** list (P1 renders it read-only; Coder live, others as disabled/not-configured):
each role row shows name · enabled · **substrate badge** (where it runs) · **trigger state**:
- `loop` → live status (thinking/acting/sleeping-until-reset).
- `cron` → next-fire countdown + last-run outcome + pause/resume + "Run now" (P2 controls).
- `event` → "armed, listening for: approved+green" + last-triggered + reconciler's last sweep.

One activity tree renders both substrates identically (the activity-source abstraction): a PM
coordinator with QA/Researcher threads nests like a Coder session's subagents. A **scheduling
lane** in "git in flight" shows each PR's join state (`approved ✅ | CI ⏳ | QA: armed→running→
verdict`, keyed on head SHA) so the operator sees *why* a merge hasn't fired.

## Empirical validation gate (do this before trusting any long-running role off-engine)

**Managed Agents mid-run rate-limit behavior is undocumented/unverified** (open items:
`claude-agent-sdk-python#812`, Claude Code #62788). A rate-limited *session start* fails with
`session_rate_limited_error` and retries next cron tick (no backoff); whether an *in-flight*
session degrades gracefully or crashes on a 429 is unknown. Verify empirically first — this is
exactly the thrash `supervisor.sh` was hardened against (usage-limit backoff, reset-epoch sleep).
Until verified, **only cron/bounded roles (PM/Researcher/QA-check) move to Managed Agents; the
continuous Coder loop stays hand-rolled.**

## Proposed backlog (issues to create)

1. **Role config schema + parser** — extend `config_parser` reads + `doctor`/`onboard` for the
   `roles:` block; validate substrate/trigger enums; safe defaults. (engine, small)
2. **QA role — event-driven merge-gate** — GitHub Actions (`workflow_run`+`pull_request_review`)
   or routine; verdict as a required check; reconciler backstop; bounded self-heal.
3. **PM role — cron triage sweep** on Managed Agents (coordinator); board grooming/unblock.
4. **Researcher role — cron** on Managed Agents; read-only; manual-run.
5. **Custom-role support** — `.autonomy/roles/<name>.md` + config; dashboard renders generically.
6. **Empirical spike: Managed Agents mid-run rate-limit resume** — the validation gate above.
   Blocks 3/4.
7. **Dashboard: role surfacing + scheduling lane** (P1 renders read-only; controls in P2).
