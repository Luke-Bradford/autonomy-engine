# Control-room research — live agent boards, observability UIs, triggering models

Compiled 2026-07-01 from a multi-agent web-research sweep (operator asked: "research what's
available in the wild"). Sources are cited inline in the research transcripts; this is the
synthesis that drives the P1 page rework and the Track-C agent-org design. Everything here is
grounded in official docs of the named products.

## 1. What makes a board read as "live right now" (not a log dump)

From Devin, Cursor, Copilot, Factory, OpenHands + realtime-dashboard UX writing (Smashing,
NN/g, Grafana, Datadog):

- **Group rows by state, not by repo.** Claude Code's own `claude agents` view groups into
  **Ready-for-review · Needs-input · Working · Completed** (+ Pinned). This is the answer to
  "show idle/waiting, not a history that looks active."
- **Motion must map to real state** (the load-bearing rule). In-progress → animated token;
  idle → *static* muted token; done → static green; failed → static red. Animation divorced
  from real activity is the #1 reason a "live" board reads as dead/untrustworthy.
- **Freshness widget** = sync dot + "updated 3s ago" + (manual refresh). Highest-signal live
  indicator; absent/stale timestamps are the top trust-killer.
- **Count-up elapsed** ("running 4m32s"), never a frozen bar. The increment *is* the liveness.
- **Current-task focus.** Devin pins Task/Plan/PR/Summary; Copilot pins the assigned issue +
  draft-PR checklist ticking off. The goal + ticket ref/link stays visible, not buried.
- **Structured event stream, not raw log** — parsed records (ts, severity, actor, message),
  groupable/collapsible, so it's scannable and filterable vs a wall of text.
- **Idle ≠ empty ≠ error** — three distinct designed states with explicit copy ("idle 2m",
  "board empty — waiting for work") + a last-activity anchor.
- **Anti-patterns:** no connection indicator; no update timestamp; fake continuous motion;
  hidden staleness (show "Offline · reconnecting"); colour-only status; everything same weight.

## 2. Tree vs Timeline — observability UIs (Langfuse, Phoenix, LangSmith, Helicone, AgentOps)

Unanimous pattern: **two rendering modes over one span dataset**, toggle-switchable —
- **Tree** — hierarchy/nesting (our current view).
- **Timeline / waterfall** — spans laid on a horizontal wall-clock axis, bar length = duration,
  so "which step is slow / what's parallel" is visible. (Phoenix `TimelineBar`, Langfuse
  Timeline, LangSmith Gantt, Helicone Span/Jaeger view, AgentOps Session Waterfall.)
- **Heat-colour by share** — colour each node red/amber by its % of total trace latency *or*
  cost (Langfuse: red ≥75%, amber 50–75%), values aggregated up the tree.
- **Per-node**: kind icon + status + latency + tokens + cost, cost/tokens rolled up to parents.
- **Session = a thread of runs** rendered as chat-like history; status enum on the thread
  (`idle/busy/interrupted/error` in LangSmith).

## 3. Claude Code emits all of this already — consume it, don't reinvent

- **`claude agents --json`** → sessions with `cwd, kind, startedAt, id, state ∈
  working|blocked|done|failed|stopped, waitingFor`. Directly dashboard-consumable. State on
  disk: `~/.claude/jobs/<id>/state.json`, roster `~/.claude/daemon/roster.json`.
  Caveat: this lists `claude agents`/`--remote`/`/loop` sessions, **not** our supervisor's
  `claude -p` one-shot runs — so we adopt its *state model + grouping* now, and can consume the
  JSON directly if/when roles run as managed agent sessions.
- **OTel export** (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP endpoint the dashboard hosts) is the
  *authoritative* real-usage source: metrics `claude_code.token.usage` (type=input/output/
  cacheRead/cacheCreation, per model/agent/skill), `claude_code.cost.usage` (USD),
  `claude_code.session.count`; spans `claude_code.interaction → llm_request → tool` where
  **subagents nest under the parent `claude_code.tool` span automatically**. This is the clean
  path to real 5h/weekly quota + cost + throughput — a P2+ upgrade over stream-json parsing.
- **Agent SDK stream + hooks** (if roles move to the SDK): `AssistantMessage.parent_tool_use_id`
  for nesting, `StreamEvent` for live deltas, `ResultMessage` for cost/tokens/turns,
  `SubagentStart/Stop` + `Notification{idle_prompt|permission_prompt}` for lifecycle/idle.

## 4. Triggering model — the answer to "cron vs loop vs event"

Surveyed Devin, Factory Droids, Copilot, Sweep, OpenHands, AutoGen, CrewAI, LangGraph, Amp,
Sourcegraph. **Consensus:**

- **No one uses a continuous polling loop as a trigger.** The engine's Coder loop is the
  exception, justified only because board-drain always has queued work.
- **Event-driven dominates** — GitHub webhooks / Actions events: `issues.labeled`,
  `issue_comment`, `pull_request` opened/approved, **`check_run.completed` (CI)**. Plus
  on-demand @mention (Slack/PR/Linear).
- **Cron is the secondary layer** for *periodic sweeps* — Devin Automations (RRULE hourly/
  daily/weekly), Copilot via Actions `schedule:`, LangGraph Platform cron. Not for core work.
- **QA-gates-merge is event-driven**, best exemplar Sweep: on `check_run.completed` failure for
  a recent PR, **bounded self-heal** (base branch green + <2 prior attempts + 15-min window).
- **Multi-role structures**: Factory ships role droids (Code/Reliability/Knowledge/Product/
  Review) + user-defined custom subagents in `.factory/droids/*.md` (own prompt/model/tools);
  CrewAI roles = role+goal+backstory with a hierarchical manager delegating; Amp = main agent +
  Oracle (read-only reviewer) + Librarian (search).

### Recommended role → trigger model for the engine

| Role | Trigger | Why |
|---|---|---|
| **Coder** | **loop** (current supervisor) | board-drain always has work; the one place a loop fits |
| **QA** | **event** — on PR approved / CI green → run checks → complete merge | react to state, don't poll; bounded like Sweep's self-heal |
| **PM / triage** | **cron** — periodic board triage/grooming sweep | low-frequency, predictable, cheap |
| **Researcher** | **cron** — scheduled deep-dive on labelled tickets | long-running, not latency-sensitive |
| **Custom** | config-declared: `loop | cron | event` | operator defines when/where it fires |

### Minimal per-repo role config shape (proposed)

```yaml
roles:
  coder:      { enabled: true,  trigger: loop,  parallel: 1, model: claude-opus-4-8 }
  qa:         { enabled: false, trigger: event, on: [pr.approved, ci.green], scope: diff }
  pm:         { enabled: false, trigger: cron,  schedule: "0 */4 * * *" }
  researcher: { enabled: false, trigger: cron,  schedule: "0 9 * * 1" }
  # custom roles: same shape, add prompt: .autonomy/roles/<name>.md
```

Event sources available today without a webhook server: `gh pr list`/`gh run list` polling from
the supervisor (cheap, already how the loop reads the board). A real webhook listener is a later
upgrade; **the engine can start event-driven-*by-polling* and swap to webhooks later** without
changing the role contract.

## 4b. Quota data — the 5h/weekly % is already in our logs (major find)

We were only reading `resetsAt`. The **`rate_limit_event.rate_limit_info`** object we already
parse carries the authoritative server-side numbers:

- **`utilization`** (0.0–1.0) = the % used, emitted per window.
- **`rateLimitType`** ∈ **`five_hour`** | **`seven_day`** — the 5h and weekly windows stream
  independently. This is exactly the "5h limit % / weekly limit %" the operator asked for.
- `resetsAt` (epoch), `surpassedThreshold` (0.9 for 5h, 0.75 for weekly), `status`
  (`allowed`/`allowed_warning`/`rejected`), overage fields (`isUsingOverage`, `overageStatus`,
  `overageResetsAt`).
- Caveat: emitted on **threshold-crossing**, not continuously, and carries **no session count /
  token denominator**. So: track max `utilization` per `(rateLimitType, resetsAt)`, reset when
  `resetsAt` advances.

**Session + token counts** are stdlib-computable from `~/.claude/projects/<slug>/<uuid>.jsonl`
(`message.usage` per `type:"assistant"` record, each with an ISO `timestamp`). **Dedup on
`message.id`** (streamed usage repeats ~2.3×) — this is what `ccusage` does. Gives absolute
tokens + distinct-session count per rolling 5h/weekly window; the true **%** still comes from
`utilization` (plan denominator is undisclosed). No `claude usage` subcommand exists in 2.1.197;
`/usage` is interactive-only.

→ **P1 quota panel:** two bars (5h, weekly) from `utilization`, + session count from JSONL. Real,
stdlib-only, no OTel needed. OTel remains the richer P2+ upgrade.

## 4c. Two Anthropic substrates for Track C (comparison doc predates one)

- **Managed Agents** (scheduled deployments): **cron-only** trigger + manual run + pause/resume;
  webhooks are *outbound notification only*. Native multiagent = **coordinator + roster (≤20
  agents, ≤25 threads)**, messaging routed through the coordinator. Self-hosted sandbox worker
  for tool exec reaching operator networks. Vaults for secrets.
- **Claude Code "routines"** (NOT in the comparison doc): trigger on **cron + GitHub webhooks
  (`pull_request`, `push`, `issue`, `check_run`, `workflow_run`, `release`, filterable by
  label/branch/merged) + a per-routine HTTP endpoint**. This is the native event-trigger the
  reactive QA role wants — no self-hosted listener.
- **Risks to carry:** (1) Managed Agents cron granularity ambiguous — **plan a 1-hour floor**
  (reinforces "Coder stays a loop"). (2) **Mid-run rate-limit resume is undocumented/unverified**
  (open items: `claude-agent-sdk-python#812`, Claude Code #62788) — **the #1 thing to verify
  empirically before moving any long-running role off the hand-rolled engine.** (3) Claude-only
  (Codex roles stay hand-rolled). (4) Agent SDK library itself has no scheduler/event loop.

## 5. Implications for our build

- **P1 (now):** reshape from tree-dump → live "now" view: state-grouped workers, idle vs
  working from log freshness, current-ticket focus (ref/title/link), Tree **+** Timeline toggle,
  structured supervisor-voice, moving throughput graph (server-sampled, flatlines when idle),
  professional theme + light/dark. All from data we already emit.
- **P2 (#10):** controls (start / graceful-stop / hard-stop) + chat box (agent↔operator) +
  live model/effort override.
- **Track C (new design, #1877+):** the multi-role org above — roles, trigger models, enable/
  disable/custom, QA-gates-merge. Its own spec + issues. Consider moving roles onto the Agent
  SDK / managed sessions so `claude agents --json` + OTel + hooks light up natively.
