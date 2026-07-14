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

## Master build order (the load-bearing prerequisites first)

Across all L1 specs, these must land early because everything else leans on them:

1. **#1 F0** — structured failure `kind` on `node.failed` (gates ALL retry/policy).
2. **#4 A0** — branch/outcome model + **#1 F1** `skipped` edge + success-semantics tests (gates
   `if`/`switch` and clean routing/monitoring).
3. **#1 F2c** retry-scheduler primitive → generalized as **#4 A5** durable-wait (gates `wait`/`webhook`).
4. **#1 secure (F4) + connection secret-config split (#4 A10)** — the secret model (gates
   secureOutput refs, credentialed connectors, git secret-reconcile #3 G8).
5. **#1 D6 ActivityDefinition contract (F9a)** — the seam every later activity migrates onto.
6. Then breadth: #2 LLM (L*), #4 control/file (A*), #3 git/publish (G*), interleaved by value.
7. **L2 UI epic** renders as each L1 capability lands — Shell (U0–U3) can start anytime (model-
   agnostic); Author/Monitor deepen as the model + read-models (R1/R2) arrive; **Publish command
   (UI) needs #3**.
8. **L3 P7** packaging last.

**MVP-usable bar is already met** (Connection→pipeline→trigger→fire→watch). This foundation makes it
ADF-GRADE + genuinely general-purpose; ship it in value order, each ticket merged green + browser-
verified (UI epic's mandatory Playwright gate).

## Loop integration (next, after review)

- The autonomous loop follows `prompt.md`'s **work-order**, not the issue list. After the review
  gate: **writing-plans** decomposes these series into the loop queue, then the supervisor appends
  the ordered work to `prompt.md` (position vs P7 = operator's call) + adds the **browser-verify
  gate** for UI tickets, and re-arms the driver (after closing `[mvp-ready]` #428).

## Open cross-spec decisions (for the operator)

1. **Epic position** — foundation before / interleaved with / after P7 packaging?
2. **Scope for a first cut** — everything (big), or a "**ADF-grade v1**" subset (e.g. variables +
   policy/retry + branch model + if/switch/foreach + real LLM adapters + structured output + basic
   git export), deferring cloud storage / tools-loop / rerun-from-failed / external-wait?
3. **Autonomy** — supervised per-fire vs the continuous driver (with the new Playwright gate).
4. The per-spec open questions (each doc's tail) — most resolved; a few product calls remain
   (SecureString, single-vs-env active pointer, in-process tools vs CLI-only).
