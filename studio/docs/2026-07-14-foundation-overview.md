# Studio foundation + UI — overview & build map

**Status:** index / cohesion doc, 2026-07-14. Ties the foundation specs + the UI epic into one
buildable sequence and records the **cross-cutting systems that span specs** (the interlocks).
Read this first; it says how it all hangs together and in what order.

## The layer model

```text
L0  Engine invariants (exist today) ─ pure reducer, run_events append log, state=fold(events),
                                      immutable versions, ${} inert single-pass, driver owns I/O+timers
        │
L1  FOUNDATION (engine/domain — build first)
    ├─ #1 Domain model + Activity framework   (variables, policy, skipped, globals, audit, rerun, contract)
    ├─ #2 LLM-activity model                  (llm_call shapes, structured output, cost-as-facts, tools)
    ├─ #3 Git-backed authoring + Publish       (DB-SSOT + git seam, stable ids, CAS publish, secrets-out)
    └─ #4 Activity library + monitoring depth  (branch model, if/switch, foreach container, files, waits)
        │
L2  UI EPIC  (renders L1 — Fluent v9, ADF hub shell, Author/Monitor/Manage)
        │
L3  P7 packaging (Docker / OSS self-host)
```

## Spec index

| Doc | Layer | Series |
| --- | --- | --- |
| `2026-07-14-foundation-domain-activity-framework.md` | L1 | F0–F12 |
| `2026-07-14-foundation-llm-activity-model.md` | L1 | L1–L12 |
| `2026-07-14-foundation-git-publish.md` | L1 | G1–G10 |
| `2026-07-14-foundation-activity-library.md` | L1 | A0–A15 |
| `2026-07-14-foundation-scheduler-lifecycle.md` | L1 | S1–S11 |
| `2026-07-14-foundation-expression-language.md` | L1 | E1–E8 |
| `2026-07-14-foundation-challenge-findings.md` | review | T1–T14 |
| `2026-07-14-adf-grade-ui-design.md` | L2 | U0–U15 (+R1/R2) |
| `2026-07-12-target-architecture.md` | ref | — |

## Cross-cutting systems (the interlocks — one design, many specs)

1. **ActivityDefinition contract (#1 D6) = the universal seam.** Every activity — `http_request`,
   `llm_call`/`agent_task` (#2), control + file (#4) — is one contract entry (control vs execution
   path, config schema, typed I/O, policy, secure fields, `errorMap`, `idempotent`). The UI palette
   + properties panel read it. **Nothing plugs in outside this contract.**
2. **Edge / branch / outcome model** spans **#1** (`EdgeOnSchema` + `skipped`) and **#4 A0** (named
   `branch` edges for `if`/`switch`). Operational `success/failure/skipped/completion` ≠ business
   routing (`true`/`false`/case). **A0 amends #1 — sequence them together; reconcile pipeline-success
   semantics once.**
3. **Durable-wait / timer primitive** spans **#1** (retry `node.retryScheduled`/`retryDue`, timeout)
   and **#4** (`wait` = `timer.due`; `webhook` = `externalWait.*` park/resume). **ONE driver-owned
   scheduler primitive** (built in #1 retry, generalized in #4 A5), never three.
4. **Secret model** spans **#1** (secureInput/Output emit-time redaction + opaque handle),
   **#2** (prompt/completion secure, telemetry-vs-content split), **#3** (secrets NEVER in git +
   connection `secretStatus`/`enabled` readiness gate), **#4** (storage credentials → connection
   secret-config split). **One rule: secrets live only in the encrypted store; never persisted to
   the event log or git; a secure value can't drive typed `${}` (handle or prohibit).**
5. **Typed outputs + `${}` language** spans **#1** (`validateRefs`, typed outputs, `vars`/`global`),
   **#2** (structured output **lowered to `config.outputs`** — the SSOT the checker understands),
   **#4** (array-safe predicates + `${item}`). **Stays INERT: single non-rescanning pass, closed
   allowlist, save-time validation.**
6. **Cost / usage / audit** spans **#2** (`activity.metered` immutable facts + run-cost projection),
   **#1** (version audit + run history), **#3** (git provenance on versions) → surfaced in **Monitor
   (UI U10–U12 + #4 monitoring depth)**.
7. **Versions + active pointer** spans **#1** (immutable `PipelineVersion`) and **#3** (Publish = CAS
   on an `active` pointer; triggers store CONCRETE version ids — never symbolic `active`), preserving
   the scheduler's "unbound never fires" + immutable-pin guarantees.
8. **Event-sourcing invariants** (L0) bind everything: pure reducer, `state = fold(own events)`,
   **replay never re-calls a model / re-runs I/O** (#2), timers/side-effects are driver events, every
   decision (control outcomes, variable writes, metering) is a durable event before the walk depends
   on it.

## Master build order (CORRECTED per integration review)

Prerequisites are tighter than the first draft — each of the next few OWNS a schema/primitive that
later specs assume, so they must be single-owner and early:

1. **#1 F0** — structured failure `kind` on `node.failed` (gates ALL retry/policy).
2. **Unified edge/branch schema (ONE ticket in #1, merges F1 + #4 A0)** — `Edge.condition` as a
   discriminated union: operational `{on: success|failure|completion|skipped}` vs business
   `{on: branch, branch}`. Settle it ONCE; `#4` `if`/`switch` implement against the final schema.
3. **Minimal ActivityDefinition contract (split from #1 F9a, EARLY)** — the universal seam #2/#4/UI
   all assume; migrations come later.
4. **Node-level dynamic outputs (`Node.config.outputs` in #1)** — first-class validated output
   override so #2's `outputSchema` lowering has a real home.
5. **Generic durable-scheduler primitive (#5 S1, ONE early ticket)** — driver-owned alarm
   abstraction owned by Spec #5; **retry (#1), `wait` (#4), `webhook`-expiry (#4), tumbling windows
   + schedule ticks + lease-expiry (#5) all consume it** (retry is NOT its own primitive).
6. **Policy/retry/timeout (#1)** on top of the scheduler.
7. **Unified secret model (ONE `SecretRef`/`SecretSink`/redaction contract in #1)** — secure
   outputs can't drive `${}`, secrets resolve only at approved sink fields, git import→`needs_secret`,
   log stores redacted metadata only (opaque handle = later extension, not an alternate live design).
8. Then breadth by value: #2 LLM (L*), #4 control/file (A*), #3 git/publish (G* — G1/G2/G4 parser
   work can run early; G6–G8 gate on version-identity + scheduler-binding + secret-readiness).
9. **L2 UI epic** renders as L1 lands — Shell (U0–U3) anytime (model-agnostic); Author/Monitor deepen
   with the model + read-models (R1/R2); **+ a UI Publish-reconciliation ticket** (DB-only
   Save-as-version vs git-connected Save/Commit+Publish; Manage Git section; supersedes the UI epic's
   "no Publish" note).
10. **L3 P7** packaging last.

## Integration review — corrections (folded 2026-07-14)

Codex's cross-spec pass surfaced these; they amend the specs (writing-plans applies them):

- **Edge/branch = ONE schema, one owner (#1).** Remove #4 A0's "amends #1 later"; fix #4's catalog
  table that still said `if` routes via success/failure — `if`→`true/false`, `switch`→named cases,
  as **business `branch` edges**, distinct from operational outcome.
- **Scheduler primitive is ONE early abstraction**, not retry-first-then-generalized.
- **ActivityDefinition minimal-contract EARLY** (split the migrations off).
- **`Node.config.outputs` is first-class in #1** (ActivityDefinition declares static/default outputs;
  node config specializes for schema-driven activities; git canonicalization + UI must render it).
- **One canonical secret contract in #1** (`SecretRef`/sink/redaction) — the other specs reference it
  instead of each restating prohibit/handle/secureFields/secretStatus.
- **RBAC/multi-user is a deliberate v1 limitation** — single-principal/local workspace; `ownerId`
  fields are future-safe boundaries only; multi-user publish permissions + auth = a later spec.

### Two cross-cutting systems the overview under-counted (now 9–11)

9. **Schema / versioning / validation / canonicalization** — save-time validation + structured
   diagnostics + ActivityDefinition schemas + `config.outputs` + git canonical hashes + import
   upgrade are ONE shared concern across authoring, git, UI diagnostics, and runtime dispatch.
10. **Scheduler, triggers & run lifecycle** — retry timers, `wait`, webhook parking, recurrence
    builder, per-pipeline concurrency, bind-to-version, disabled imports, active-pointer resolution,
    queued/waiting statuses, monitor timelines. **Candidate for its own deepening spec (#5)** before
    `wait`/`webhook`/concurrency (G7/U14/U12b) build.
11. **Observability / read-model** — cost/usage, retry history, timer + external waits, tool
    telemetry, audit, git provenance, run duration, alert hooks: ONE event-taxonomy + read-model +
    redaction + durable-timestamp design (alerts later, but the data model must be deliberate).

**MVP-usable bar is already met** (Connection→pipeline→trigger→fire→watch). This foundation makes it
ADF-GRADE + genuinely general-purpose; ship it in value order, each ticket merged green + browser-
verified (UI epic's mandatory Playwright gate).

## Loop integration (next, after review)

- The autonomous loop follows `prompt.md`'s **work-order**, not the issue list. After the review
  gate: **writing-plans** decomposes these series into the loop queue, then the supervisor appends
  the ordered work to `prompt.md` (position vs P7 = operator's call) + adds the **browser-verify
  gate** for UI tickets, and re-arms the driver (after closing `[mvp-ready]` #428).

## Round-1 challenge amendments (authoritative edit-list; writing-plans applies these)

The adversarial E2E challenge (`…-challenge-findings.md`, T1–T14) produced these binding design
decisions. Each is the SSOT for the edit its owning spec receives.

- **T1 → NEW Spec #6 (expression language)** — the `${}` function catalog + interpolation + system
  vars. Prereq alongside F0. **DONE (spec written).**
- **T2 trigger-context (→ #5 + #6):** add a durable **`run.triggerContext` seed event** (folded by the
  reducer; no out-of-band preload). Add general **`${trigger.*}` per trigger type** (schedule
  `scheduledTime/startTime`; event `body/eventData`; window `windowStart/End`) + **`${run.*}`/
  `${pipeline.*}` system vars** (#6). Allow **expression-valued trigger param bindings** + a **run-now
  param-override body** (`POST /triggers/:id/fire`), resolved fire-time (`pipeline default < trigger
  binding < run-now override`), validated at save.
- **T3 propagate corrections (→ #1/#2/#4 bodies):** move the unified `Edge` **discriminated union**
  into #1 as the single owner (`{on:success|failure|completion|skipped}` operational vs
  `{on:branch, branch}` business); strip #1 D4's per-feature retry-timer prose (superseded by #5 S1);
  fix #2's classify table ("category output → downstream `switch`", NOT "drives success edges"); fix
  #4's `if` catalog row (→ `true/false` branches) + drop A0's "amends #1". **Surgical fixes applied
  below.**
- **T4 loop-dataflow (→ #4 + #1):** `foreach` gets a **first-class aggregate output**
  `results: Array<childOutputShape>` (input-order-stable regardless of `batchCount`), addressable as
  `${nodes.<foreach>.output.results}`; extend `OutputSpec`/`validateRefs` for array-of-child-shape.
  Document **outputs are round-local + cleared on loop re-entry; only variables persist across
  iterations** (fix the validateRefs diagnostic). Specify container output projection (the A3 TODO).
- **T5 subscription/CLI LLM (→ #2):** add a **`cli`/`agent` connection kind `llm_call` accepts** +
  single-shot CLI adapter (`claude -p`/`codex exec` → stdout completion); a **quota/reset-window**
  primitive (sub cap → durable "wait until reset", not blind retry); split `meteringStatus →
  metered|unpriced|unknown`; run-cost projection carries a **completeness flag** (unmetered ⇒ "≥").
- **T6 `Node.config.outputs` (→ #1):** define `Node.config.outputs?: OutputSpec[]` (the home for #2's
  lowered structured schema) + validation/canonicalization/git rules; add `${nodes.x.status}`; decide
  deep `[]` addressing (permissive, runtime-validated — #6 E7).
- **T7 multi-edge JOIN (→ #1 D5):** specify **AND across predecessors, OR among conditions on one
  predecessor** (ADF `dependsOn`) + characterization tests with F1.
- **T8 classify→switch (→ #2/#4):** the pattern + a **mandatory `default`** + save-time switch
  case-exhaustiveness vs the enum output.
- **T9 connection params (→ #2/#1):** connection **parameters** (non-secret, expression-bound at
  dispatch) + `connectionId`/`model` as validated `${}` refs (route Anthropic-vs-OpenAI by param).
- **T10 `SecretRef` sink (→ #1 D8):** a node-config secure field can carry a `SecretRef` resolved at
  dispatch (never logged) — secrets reach a non-connection activity (e.g. an `http_request` auth
  header) without a bespoke connection kind. This is the "canonical SecretRef" the overview promised.
- **T11 `ToolDef` + tool side-effects (→ #2):** define `ToolDef`; **MVP tools are read-only/pure**
  (opaque-telemetry model stays honest) — side-effecting tools promote to the deferred event-modeled
  resumable-loop sub-spec.
- **T12 events + read-models (→ #5/#1/UI):** add `trigger.fired`/`run.created`/`run.admitted`,
  `node.skipped`/`edge.notTaken`, foreach lifecycle events; extend R1/R2 with `triggerContext`/
  `windowContext`/version `provenance`/`activePointerAtCreation`.
- **T13 monitor surfaces (→ UI + #5):** reconcile the UI status enum + R2 with S6 (v1); add
  activity-drill-in, trigger-runs, tumbling-window, filter+time-range (server-side), cost-column,
  cancel, **rerun-distinct render** (copied-vs-executed frontier), cross-run Gantt; event-source
  workspace mutations + publish history for non-version audit.
- **T14 UI authoring (→ UI epic):** add param/var/output/global **authoring** surface, **undo/redo**
  (early — reversible-command store), the **Save-vs-Publish reconciliation** ticket, **outcome-by-
  source-handle** + `if`/`switch` per-branch handles, **`call_pipeline` authoring**, copy/paste,
  multi-select, version-history/picker, container-config forms, drag-drop drop mechanics; annotate
  every UI ticket's hard dependency on its foundation schema.
- **Tier-3** notes (connection probe, prompt-caching cost, refusal taxonomy, DST run-windows,
  shell/git activity, webhook payload contract, env-override globals, etc.) fold as spec caveats or
  explicit deferrals in each owning spec.

## Round-3 fold (amendments written INTO owning specs)

Round-3 confirmatory trace: the 3 fresh scenarios build, but found the T-amendments were recorded
here yet **not written into owning-spec ticket lists** (so unbuildable). Now fixed — the critical
amendments got real tickets: **#1 F13** (`Node.config.outputs`+`nodes.status`, T6) **F14** (multi-edge
JOIN, T7) **F15** (`SecretRef` sink, T10); **#5 S12** (trigger param-bindings + run-now override, T2);
**#2 L13** (dynamic connection/model, T9) **L14** (CLI/subscription kind, T5); **#4 A16** (webhook
typed-output + callBackUri, HITL) **A17** (until wall-clock timeout). Plus:
- **A business `branch` edge MAY also carry a bounce-cap `back:true`** (T3 edge union) — so a
  3-way switch can loop on one arm (approval "needs-changes" → redraft), stashing feedback via
  `set_variable` first (T4: outputs are round-local, variables persist).
- **`foreach` is IN v1** (operator chose full breadth) — so #6's LLM-judge **aggregate flow is a v1
  capability**; the "defer foreach" line in open-decision 2 is superseded.
- **`filter` activity (`.items`, monitored/over-cap arrays) vs `filter(array,pred)` expression
  (small inline reshape, resource-capped)** — the split is the resource cap; documented in #4/#6.
- Remaining Tier-3/editorial (webhook v1 inclusion, prompt-caching cost, DST run-windows, foreach
  lifecycle event names) stay as explicit per-spec deferrals.

**Build-readiness after 3 rounds:** engine-semantics (edge union, scheduler primitive, secret rule,
inert `${}`+catalog, failure-kind, cost-as-facts) are coherent + buildable; the previously-orphaned
dynamic-invocation layer (T2/T6/T9) + webhook payload now have owning-spec tickets. **The design is
build-ready for writing-plans.**

## Open cross-spec decisions (for the operator)

1. **Epic position** — foundation before / interleaved with / after P7 packaging?
2. **Scope for a first cut** — Codex's recommended **coherent "ADF-grade v1" slice** (favor
   coherence over breadth): `F0` · unified edge/branch · minimal ActivityDefinition · typed dynamic
   outputs (`config.outputs`) · inert `${}` with vars/globals validation · secret v1 (prohibit/
   redact) · generic scheduler + retry + `wait` · `if`/`switch` · real LLM **text + structured
   output** · basic Monitor read-models (R1/R2) · DB-only Save/versioning · git **export/import**
   (without full CAS Publish). **Defer**: `foreach` (until item-aggregation + variable determinism
   fully specced), webhook/external-wait, cloud storage, tool-loops, rerun-from-failed, alerts, RBAC,
   full git PR/Publish UX. — accept this v1, or widen/narrow?
3. **Autonomy** — supervised per-fire vs the continuous driver (with the new Playwright gate).
4. The per-spec open questions (each doc's tail) — most resolved; a few product calls remain
   (SecureString, single-vs-env active pointer, in-process tools vs CLI-only).
