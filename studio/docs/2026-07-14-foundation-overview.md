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
5. **Generic durable-scheduler primitive (ONE early ticket)** — driver-owned alarm abstraction;
   **retry (#1), `wait` (#4), and `webhook`-expiry all consume it** (retry is NOT its own primitive).
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
