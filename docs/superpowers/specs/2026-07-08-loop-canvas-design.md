# The Loop Canvas — configure the loop as a diagram, not a textarea

Companion to `2026-07-08-personalities-and-setup-design.md` (operator session
2026-07-08, late). Operator direction:

> "Pay attention to the different types of loops, the visuals. How do we
> enable the configuration of these so users can see how and where the loop
> should work, when something needs checking, definition of done. We
> currently have a text box which explains how we are doing this, but we're
> not allowing a defined loop. Configure this simply, easily, visually,
> intuitively."

## Source grounding

- **Loops article** (claude.com/blog/getting-started-with-loops): every loop
  type is presented as a DIAGRAM — trigger → work → check → stop condition.
  Four types: turn-based (manual), goal-based (verifiable exit criteria),
  time-based (interval), proactive routines (event/schedule). Our triggers
  already map 1:1 (manual / cron / event / loop); what we lack is the
  check + stop-condition stations as CONFIG rather than prose.
- **Advisor pattern** (ClaudeDevs 2074606058128224365): executor calls a
  stronger model for guidance; most tokens billed at the executor rate —
  our two-brain pair; on the canvas it is the WORK station's shape.
- **Managed-agents multi-agent docs**: composition patterns named
  parallelization / specialization / **escalation** (consult a more capable
  agent for complex subtasks — the pair again), coordinator + roster,
  per-agent model/tools/prompts. Confirms the industry shape: agents are
  configured units composed into flows — which is exactly what a workstream
  card should read as.

## The canvas

Every workstream card is HEADED by its loop, drawn as five stations with a
loop-back arrow. Each station is a clickable node: click → that station's
editor opens beneath the canvas. The diagram IS the configuration surface;
the prose textarea survives only inside one station (WORK → instructions).

```text
 ⟲ ──────────────────────────────────────────────────────────┐
 [ WHEN ] → [ PICK UP ] → [ WORK ] → [ CHECK ] → [ DONE WHEN ]┘
```

| Station | Question it answers | Backing config (exists?) |
| --- | --- | --- |
| WHEN | what starts a run | `trigger:` — loop / cron / event / manual (EXISTS, ws_set) |
| PICK UP | what it works on, from where | `scope.labels` + board (EXISTS) |
| WORK | who does it, how | brains (pair/single via `agent.planner.enabled` — pending), model/effort, runs-as account, instructions (EXISTS except the flag) |
| CHECK | when something needs checking | mid-work: ask-thinking-when-unsure (pair on/off) · end: PLAN-CHECK vs plan (pair) · role `gate:` (QA) · then the repo's merge gate chain (EXISTS as config; NOT yet composed visually) |
| DONE WHEN | definition of done for a run / the loop | NEW: `done:` block — per-run: "PR opened" / "PR merged" / "board drained"; per-day caps: max sessions (budget), max spend later. Honesty split below |

Node rendering doubles as OBSERVED state: last run's path lights the
stations it passed (reuses the phase-track honesty vocabulary, SD-32:
solid = observed fact, outline = configured, dotted = prompt-shaped).

## The honesty split (non-negotiable)

Stations mix three kinds of truth, and the canvas must not blur them
(#157/#149 precedent — a knob that only shapes prose must say so):

- **Enforced by the engine**: trigger, scope labels, gate, merge-gate chain,
  budget caps (when built). Rendered solid.
- **Prompt-shaped**: "ask thinking when unsure", PLAN-CHECK, most DONE
  criteria ("stop when the board is drained") — they live in the rail the
  engine materializes/instructs. Rendered dashed, with the ⓘ saying "the
  agent is instructed to do this; the merge gate still enforces the hard
  stop".
- **Observed**: what actually happened last run. Rendered as the lit path.

DONE WHEN therefore has two rows: **hard stops** (engine: budget/sessions
cap, merge-gate refusal) and **instructed stops** (rail: definition of done
written into the prompt from structured choices, so the textarea stops
being the only carrier of loop semantics — the canvas WRITES the rail's
"when to stop" section from the user's picks, one honest generated block).

## Fallback model ≠ same effort (operator note, 2026-07-08)

> "We have the idea of a fallback model, but applies the same thinking
> effort. The effort we assign to one model might be different for another."

Correct, and partially an upstream constraint: the claude CLI takes ONE
`--effort` per session alongside `--fallback-model` — the CLI switches
models itself mid-session, so the engine cannot re-issue a different effort
at the switch. What we CAN do honestly:

- The WORK station shows the fallback as its own row — model picker +
  an effort cell that reads "inherits the session effort" with ⓘ
  explaining the CLI constraint, instead of implying an independent knob.
- Advice at pick time: choose an effort valid for BOTH models (the docs:
  "not all models support the effort parameter"; xhigh is recommended on
  Fable/Opus-4.7+/Sonnet-5 — a haiku fallback under xhigh is the mismatch
  case). A save-time WARN fires when the pair is a known mismatch.
- Schema stays truthful: no `fallback_effort` key until the CLI can honor
  one (an unconsumable knob would need a #157 honesty NOTE from birth). If
  the CLI grows per-model effort, the cell becomes a picker.

## Loop-type presets (the article's four, as one-click canvas shapes)

The add-workstream wizard and the WHEN station offer the four shapes with
the article's own framing:

1. **Continuous routine** (proactive): WHEN=loop · DONE=board drained /
   cap. The coder default.
2. **On a schedule** (time-based): WHEN=cron preset · DONE=queue empty this
   run. PM shape.
3. **When something happens** (event): WHEN=event checkboxes · DONE=that
   item handled. QA shape.
4. **When I say** (turn-based): WHEN=manual · Run now button. Helper shape.

Goal-based lands as DONE WHEN's verifiable-criteria row (later; recorded).

## Build slices (extends the personalities build order)

- **C1 — canvas render (read)**: the five-station diagram on every ws card
  fed by existing org data + merge_gate_chain (#187's backend); observed
  lighting from the session index. Replaces the flow line.
- **C2 — station editors**: move the existing editors under their stations
  (trigger→WHEN, scope→PICK UP, brains/model/account/instructions→WORK,
  gate→CHECK); no new writes.
- **C3 — CHECK composition**: render the full chain (pair checks + role
  gate + repo merge gate) as one honest sequence w/ solid/dashed split.
- **C4 — DONE WHEN**: `done:` schema (validated; honesty NOTEs until
  consumed) + rail-generation of the instructed-stop block + budget cap as
  the first enforced stop (folds the old slice-5 budget here).
- **C5 — presets in the wizard** (the four shapes above).

Mockup: `docs/superpowers/mockups/2026-07-08-loop-canvas-mockup.html`
(interactive; the four presets switchable, stations clickable) — the
review artifact for this spec.

## v2 corrections (operator review of the first mockup, 2026-07-08)

### The canvas is a COMPILER, not a picture

The first mockup showed a fixed flow — "this is the plan, deal with it."
Wrong shape. Each station holds an ORDERED, EDITABLE STEP LIST; the canvas
compiles those steps into the agent's brief (the rail). The user adds,
amends, reorders, toggles and removes steps; prose is the OUTPUT (visible
via "what this writes into the brief"), with a per-step free-text escape
hatch. The brief's generated sections are fenced (`<!-- canvas:check -->`)
so hand-written content survives regeneration.

### The step catalog (CHECK station, initial)

Each step is tagged enforced / instructed, per the honesty split:

| Step | Kind | Mechanism |
| --- | --- | --- |
| ask thinking when unsure | instructed | pair rail section |
| thinking checks code vs plan (plan-check) | instructed | pair rail section |
| subagent code review before push | instructed | materialized reviewer agent (planner pattern) + rail step |
| run the full test suite before push | instructed | rail step |
| security pass on the diff | instructed | rail step (reviewer agent w/ security brief) |
| browser-verify the UI | instructed | rail step |
| hand off to the QA workstream | enforced wiring | QA binding (event pr.opened) — adds/links the workstream |
| review bot · CI · merge gate | enforced, always-on | branch protection + safe_merge — shown, not removable |

"Custom check…" = name + free text, lands as an instructed rail step.
The same list pattern later extends WORK (ordered work steps) and DONE
WHEN (stop conditions) — CHECK ships first because it answers "when does
something need checking".

### Fallback is PER BRAIN — and only one brain has a real one

- **Building brain**: real fallback — the CLI's `--fallback-model` switches
  mid-session. One row: `building · model · effort · falls back to X`
  (effort inherits — the earlier note stands).
- **Thinking brain**: Claude Code subagent frontmatter carries ONE model —
  there is no fallback mechanism. The row says so: `thinking · model · if
  unavailable: the builder continues alone and flags it in the PR`
  (instructed behavior, written into the brief by the compiler). No fake
  picker. If subagent fallback lands upstream, the cell becomes one.

### Added user stories (extend the personalities catalogue)

| # | Story | Oracle |
| --- | --- | --- |
| S16 | Add "subagent code review before push" to the coder's CHECK list from the catalog. | reviewer agent materialized; brief gains the fenced step; PR body shows the review happened |
| S17 | Remove plan-check from a repo that runs one brain. | step absent from brief; canvas shows the shorter chain |
| S18 | Reorder: run the full test suite BEFORE the subagent review. | brief lists steps in the new order |
| S19 | Wire the QA workstream as a CHECK step ("hand off to QA") from the coder's canvas. | QA binding created/linked; canvas shows the handoff edge |
| S20 | Custom check: "verify the changelog was updated" typed free-text. | fenced instructed step in the brief, tagged instructed on the canvas |
