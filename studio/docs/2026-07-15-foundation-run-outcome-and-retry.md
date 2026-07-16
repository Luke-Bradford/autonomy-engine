# Foundation joint spec — run-outcome semantics + retry state machine (F1b + F2b)

**Owns:** #1 **F1b** (pipeline success-semantics reconcile, issue #442) and #1 **F2b** (reducer
retry-eligibility, the D4 HOLD). One spec, because they are **the same predicate**: both are about
what `settle` counts as a run-ending failure.

**Status: ALL FIVE decisions SETTLED, and the whole chain SHIPPED — #443 (`f732950`), F1b
(`3a78658`), F2b + F2c together (see the build order's item 3).**

**FOUR build-time corrections this spec owes its readers, all probed** (details at their sections):

1. **§A.3's eligibility formula is wrong on two counts** and names the wrong counter — retry keys on
   a new `retries` field, not `attempts`.
2. **The build order's parsed-vs-raw fold bug is INERT**, not the live retry-deciding bug it was
   billed as.
3. **§A.5's "re-deriving would DOUBLE-ARM it" is FALSE**, and it was the load-bearing justification
   for doing nothing on boot. `armWakeup` is upsert-if-absent and returns the existing row *whatever
   its status* (`repo/scheduled-wakeups.ts:56-57`, whose own comment says so). Re-arming is a no-op
   when the row exists — which is what made the safe fix free, and what made this spec's advice to
   skip it a **permanent hang** for any run crashed between the HOLD and the ARM. Fixed by
   `recoverHeld`'s three-arm check; note the same idempotence means a SPENT row cannot be healed by
   re-arming either, which a present-vs-absent check gets wrong.
4. **This spec never asked WHO IS ALLOWED TO PUMP a run**, and that — not F2a or S1 — was F2c's real
   dependency. It sequenced the EVENTS carefully while the alarm quietly became a second driver entry
   point, which double-billed LLM calls and hung the run. The primitive (`run/drives.ts`) deserved its
   own line in the build order and now has one.

Read those blocks before trusting the surrounding passages.

(c) was briefly raised as an operator fork (**#475**) on the belief that the only rule satisfying both
the fail-safe invariant and #472's "labels deleted honestly" bar was unproven. A spike proved it —
**#475 is CLOSED, dissolved by evidence, not by a judgement call**. See §C.2.

**Why this document exists.** Spec #1 line 223 said the hold-vs-reopen fork was "#5's"; spec #5's
own spike-hardened block said "D4 must add either (i)… or (ii)… — spec it before F2b/F2c build",
deferring to D4. The fork was **genuinely unowned by both**, which is what let it slip to the point
where F2b was the next ticket in the build order with no settled semantics under it. This spec is
now the SSOT for run-outcome + retry semantics; #1 D4/D5 and #5's block point here.

**Provenance.** Operator decision #472 (2026-07-15) settled the D4 fork as **HOLD**, and directed
that it be specced **jointly** with #442 before any F2b code. Every claim below marked *(probed)* was
verified against the real reducer — see [Evidence](#evidence-probed-not-argued).

---

## The five questions this spec was directed to answer

| # | Question | Verdict |
|---|---|---|
| (a) | **D4 HOLD** — a retry-eligible `transient` failure parks non-terminally | **SETTLED** — §A |
| (b) | **#442 divergence 2** — eager short-circuit vs drain-to-fixpoint; do they converge with (a)? | **SETTLED** — §B. *Partial* convergence: the operator's hypothesis is half right, and the other half is a latent bug. |
| (c) | **#442 divergence 1** — "handled ⇒ success" | **SETTLED** — §C. Leaf-evaluation **AND** absorption ("option 3"). Strict ADF parity is fail-open under `join:'any'` (**P1**); the safe minimal fix leaves an ADF divergence pinned forever. The conjunction satisfies both, and was probed. |
| (d) | **Container parity** — `firstUnhandledChildFailure` short-circuits identically | **SETTLED** — §D |
| (e) | **#443 posture** — a reducer change re-folds already-bound run logs | **SETTLED** — §E |

---

## Evidence (probed, not argued)

Run against the real `createEngine`/`reduce`, real events, no mocks. Two probes, both throwaway (the
precedent is spec #5's outbox prototype); their **findings** are recorded here because they are the
only evidence anyone has for the blast radius. ~~`reduce.ts` is byte-identical to `origin/main` on
this branch — verify with `git diff origin/main -- …/reduce.ts`.~~ **That instruction was true only
on the SPEC's branch** (this document landed before any F1b code, so the probes had to prove they
left nothing behind). F1b has since shipped, so `reduce.ts` is *deliberately* no longer identical;
the sentence is struck rather than deleted so a reader who remembers it is not left wondering.

- **Drain probe** — removed the `firstUnhandledFailureTop` short-circuit (`reduce.ts:735-742`),
  changed nothing else. Yields P1, P2, P3, P4 and §B.3's cost figure.
- **Option-3 probe** — drain + the §C.4 predicate, routed through **both** call sites. Yields §C.3's
  verdict table and the blast radius. Full engine suite: **572 passed, 5 failed** — and the 5 are
  exactly the blast-radius table.

Everything else in this document is **argued**, and says so. Where a claim is argued and load-bearing,
it is marked.

**P1 — `join:'any'` absorbs a wholly unhandled failure under strict ADF leaf-evaluation.**
Doc: `a --success--> d`, `p --success--> d`, `d` has `join:'any'`. `a` fails and carries **no**
`failure`/`completion` edge — no catch exists anywhere in the doc.

```text
today (short-circuit):  a=failure  p=success  d=pending   finish = failure / node_failed:a
drained:                a=failure  p=success  d=success   forward leaves = {d} → all succeeded
```

`d`'s `a`-group is dead but its `p`-group is satisfied, so `join:'any'` runs it. `a` and `p` both
have out-edges, so the only forward leaf is `d`, and `d` succeeded. Strict ADF ("*Pipeline result is
success if and only if all nodes evaluated succeed*") therefore reports **success on a run whose
node failed with no handler at all**. This is the decisive fact in §C: it is **fail-open**, and it is
**studio-specific — ADF has no `join:'any'`**, so the rule studio would be copying was never designed
against this shape. It is what eliminates strict ADF parity, and §C.3's absorption conjunct exists
precisely to close it (probed: the same doc reports **failure** under the settled rule).

`join:'any'` is not a contrived shape: `nodeJoin` (`params.ts:1911`) is a deliberate SSOT shared by
the reducer and static validation, `params.ts:1741-1747` already carries a false-accept hazard
analysis scoped specifically to `any`, and it is pinned by a live test (`reduce.test.ts:212`). It is
API-authorable via `node.config.join`; note it has **no canvas affordance today** (`join` is typed on
`ContainerSchema` but reaches a node through the untyped `config` record), which lowers its frequency
but not its validity.

**P2 — the outcome predicate has TWO call sites, and drain breaks the second one.** Same probe:

```text
drained:  finish = failure / reason: 'invalid_event'
```

`settle` emitted `finishRun{success}` → the driver appended `run.finished{success}` → **the reducer
called its own event impossible** and returned `finishRun{failure, invalid_event}` with
`state.status` stuck at `running`. Cause: `firstUnhandledFailureTop` is called at **`reduce.ts:735`**
(settle) *and* **`reduce.ts:1157`** (the `run.finished` impossibility check). Changing one and not
the other makes the reducer contradict itself **on a brand-new run**, and a stuck-`running` row is
exactly what `reconcile.ts:136` selects and can re-drive. See §B.

**P3 — the pinned characterization tests contain a contradiction.** `edge-model.test.ts:486`
(`MATCHES ADF: a skipped final branch after a failed condition → success`) builds `a --failure--> handler`,
`a --success--> b` and fails `a`. `edge-model.test.ts:532` (`DIVERGES from ADF: a failure is "handled"
by any failure edge → success (F1b)`) builds `a --failure--> onFail`, `a --success--> onOk` and fails
`a`. These are **isomorphic up to node renaming**, assert the **identical** outcome (`success`), and
carry **opposite labels**. Both are the ADF Do-If-Else shape, which ADF fails. The `MATCHES ADF`
label at `:486` is simply **wrong** — whatever (c) decides, that pin moves with `:532`, and D5's
claim that "four match the ADF target" is really three.

**P4 — verified non-findings** (recorded so a later fire does not re-litigate them):
- **The bounce cap and the skip-only-spin test survive drain untouched.** Drain touches neither
  `fireBackEdges` nor the whole-body-terminal gate; the spin test passes under the drain probe. The
  `DEFENSIVE_BOUNCE_CAP` reasoning at `reduce.ts:82-92` holds verbatim.
- **A forward cycle cannot hang leaf-evaluation.** Leaf-evaluation only runs once
  `allTopLevelTerminal` holds; a forward cycle's nodes never terminalize, so it is never reached.
  ~~Terminating by construction, not by a guard.~~

  **CORRECTED BY F1b (build-time, probed).** The first sentence holds; the conclusion does **not**,
  and it was the more dangerous half. A **skip-propagated** cycle *is* reachable with every node
  terminal: the skip enters from OUTSIDE the cycle, so each node resolves to `skipped` without ever
  running, `allTopLevelTerminal` holds, and the walk goes straight into it —
  `x --failure--> a`, `a --success--> b`, `b --success--> a`, `b --success--> c` with `x` succeeding.
  Termination is **by the guard, not by construction**; without it the pure reducer loops forever
  inside one synchronous `reduce()`, wedging the driver's pump. §C.4's sketch made this worse by
  passing `seen` and never adding to it — fixed below.

  **Both walks need their own pin**, and this is the trap: they are reached by DIFFERENT conjuncts.
  The cycle doc above only exercises **leaf-evaluation** (conjunct 2) — it has no failed node, so it
  never enters `absorbedSkip`. Reaching that one needs a FAILED node whose taint enters the cycle
  (`f --success--> s1`, `s1 --success--> s2`, `s2 --success--> s1`, `f` fails). Shipped with one pin
  each, both mutation-verified: deleting either guard hangs its own test and leaves the other green.

  **A second, separate hazard the same shape exposes: stack depth.** F1b's first draft implemented
  both walks recursively (as §C.4's sketch reads). Depth is then O(chain length) on a doc the engine
  does not control — measured: fine at 4k chained skipped nodes, `RangeError: Maximum call stack size
  exceeded` at 5k, where the flat loop it replaced coped. That is a `throw` from inside the PURE
  reducer. **Both walks ship ITERATIVE (explicit stack)**; `evalEndpoint` pushes parents in reverse
  edge order so LIFO reproduces the recursive form's doc-order, first-match-wins blame, which
  `finishRun.reason` names. Deliberately NOT pinned by a test: recursion survives to ~4k, so any doc
  cheap enough to test passes either way, and at the size that discriminates `settle` is already
  O(n²) (~4s per drive at 5k, measured) — such a doc is unusable for reasons that dwarf the stack.

---

## §A — (a) D4 HOLD: the retry state machine **[SETTLED]**

Settled by operator decision #472. Re-open was rejected on the merits *there* and is not re-litigated
here: `settle` emits `finishRun{failure}` the moment an unhandled failure appears, so a `transient`
failure that folds a node to terminal ends the run **before** any `node.retryDue` could arrive —
re-open is only reachable via a `settle` change that **is** the HOLD.

### A.1 The status

Add a **new, NON-terminal** `NodeRunStatus`: **`retry_pending`**.

The name is deliberate over `held`/`retrying`: it reads correctly in the UI's node overlay (U-series)
and states the *reason* it is parked, not the mechanism. It is **not** in `TerminalNodeStatusSchema`,
so — for free, with no new predicate — `TERMINAL_NODE` excludes it, `endpointOutcome` returns `null`,
every readiness/outcome path treats it as live, and `allTopLevelTerminal` is false while a node is
held. This is where the operator's convergence hypothesis pays off (§B).

`retry_pending` is not terminal, so `TERMINAL_NODE` (`types.ts:143-148`) needs no change.

**Do not trust that `satisfies` guard, and fix its comment while you are here.** `types.ts:144-147`
claims *"adding an 8th `NodeRunStatus` that is terminal, and forgetting it here, is a type error
rather than a silently-permissive engine."* **That is false — probed.** Adding an 8th terminal status
to `NodeRunStatusSchema` and omitting it from `TerminalNodeStatusSchema` **compiles clean**:
`satisfies readonly NodeRunStatus[]` pins only the *subset* direction (terminal ⊆ status), which the
surrounding `new Set<NodeRunStatus>(...)` already pins. It catches a terminal option that is not a
valid status; it cannot catch a *forgotten* one. Harmless for `retry_pending` (non-terminal), but a
later fire adding a genuinely terminal status would be trusting a guard that does not exist.

### A.2 The event + command triple (do not ship a partial one) — **BUILT as specced**

Spec #1 D4 (`…domain-activity-framework.md`, the three bullets under D4) specifies **three** primitives. **Verified: none of them exist** —
`EngineCommandSchema` (`types.ts:432`) is `dispatchNode | startChild | finishRun`, and
`scheduleRetry`/`node.retryScheduled`/`node.retryDue` appear in `studio/packages` **only in comments**
(`scheduler/alarms.ts:28`, `repo/scheduled-wakeups.ts:49`, `schemas/wakeup.ts:8` — S1 already
anticipates them). Operator directive (a) named only `node.retryDue`; that is not enough, because
**`scheduleRetry` is F2b's own output**. F2b must add:

| Primitive | Kind | Owner | Notes |
|---|---|---|---|
| `scheduleRetry{nodeId, failedAttemptId}` | **command** | reducer (F2b) | Emitted when a `transient` failure is retry-eligible. Pure — no clock. Consumed by S1's outbox; its dedupe discriminator is **attempt-n** (spec #5's spike block: omitting the attempt number makes attempt-2's retry collide with attempt-1's already-`fired` row and **silently never arm**). |
| `node.retryScheduled{nodeId, nextAttemptAt}` | **event** | driver (F2c) | The durable fact. `nextAttemptAt` is **stored**, never recomputed at fold time — the reducer stays clock-free. |
| `node.retryDue{nodeId, previousAttemptId}` | **event** | driver (F2c) | Folds → re-dispatch. Must be added to `EngineEventSchema`. |

### A.3 Retry-eligibility (the pure decision)

On `node.failed` for a live node, F2b decides:

```text
eligible  ⇔  kind === 'transient'  ∧  attempts < (policy.retry ?? 0)
```

> **CORRECTED BY F2b (build-time, probed). This formula is WRONG on two independent counts, and
> the counter it names is the wrong one.** As built:
>
> ```text
> eligible  ⇔  kind === 'transient'  ∧  retries < (policy.retry === undefined ? 0 : policy.retry)
> ```
>
> where `retries` is a NEW `NodeRunState` field counting POLICY retries in the current loop round.
> Both defects were found by the planning gate and confirmed against the real reducer:
>
> 1. **Off by one.** `attempts` increments at **DISPATCH** (`reduce.ts:603` mints `attemptId` from
>    `ns.attempts`, `:641` folds `attempts + 1`), so it is already **1** at the first `node.failed`.
>    `attempts < retry` therefore delivers `retry: N` → **N** total attempts, where F2a's schema says
>    *"`retry: 2` = up to 3 attempts"* (`pipeline.ts:184`) — and collapses an explicit `retry: 1` into
>    `retry: 0`, which is the very absent-vs-explicit-0 confusion §A.3 spends four paragraphs
>    protecting. **A test asserting only "transient+budget ⇒ retry_pending" passes under the broken
>    rule**; the pin has to count TOTAL attempts. It does (`retry-state-machine.test.ts`).
> 2. **Loop rounds spend the budget.** §A.6 correctly requires `attempts` stay MONOTONIC across a
>    back-edge reset — and never reconciles that with §A.3 reading it. A loop-body node with
>    `retry: 2` retries in round 1 and, from round 3 on, has none: its budget was consumed by
>    BOUNCES, not by failures. §A.6 and §A.3 were each right alone and wrong together.
>
> A separate counter fixes both and keeps §A.6 verbatim: `attempts` stays monotonic for attempt-id
> minting and stale-rejection, `retries` is cleared by `resetNodes` so each round gets its own
> budget, and the rule now reads exactly like its English contract with no off-by-one to re-break.
> It also stops boot recovery (`node.retryRequested`) from silently eating the operator's budget —
> `attempts` conflates policy retry, boot retry and loop round; `retries` counts only the first.
>
> **Lesson: a spec formula that names a field is asserting that field's semantics.** `attempts` was
> load-bearing in three unrelated ways, and §A.3 borrowed it for a fourth without checking. Probe
> the counter, not just the condition.

`permanent`/`cancelled` never retry (D4). `policy` is F2a's `NodePolicySchema` (merged, `88a6ed2`);
`policy.retry` absent means "policy says nothing" → **0** → never eligible, so every existing doc is
unaffected. Eligible → fold to `retry_pending` + emit `scheduleRetry`. Not eligible → fold to
`failure` exactly as today.

**The `?? 0` is a v1 shortcut with a stated expiry — do not cement it.** F2a's schema
(`pipeline.ts:180-185`) explicitly requires: *"`0` is meaningful and is NOT the same fact as absent …
F2b must preserve that difference once a catalog/global default exists."* `retry ?? 0` **erases** that
distinction: it collapses "explicitly never retry this node" and "policy says nothing" into the same
value. That is safe **today** and only today — no catalog/global default exists, so both genuinely
mean 0. The moment F13b's catalog default or a global policy default lands, absent must resolve to
*the default* while an explicit `0` must still mean *never*. F2b must therefore keep absent and `0`
distinguishable at the read site (`policy.retry === undefined` vs `=== 0`), not normalize them.

**Accept the widening, and say why.** #472 flagged that this couples the reducer to retry POLICY:
`settle`'s notion of a run-ending failure becomes policy-dependent. That is real and it is accepted —
it is intrinsic to HOLD, which the operator chose. It is *bounded*: the reducer reads `policy.retry`
and `attempts` and nothing else, and `policy` is already part of the **immutable bound version**, so
the read is replay-stable by construction. It does not read the clock, the driver, or any mutable
row.

### A.4 The `LIVE_NODE` guard — decide, don't inherit

`LIVE_NODE = {ready, dispatched}` (`reduce.ts:75`) has exactly **three** uses: `onSucceeded`
(`reduce.ts:868`), `onFailed` (`:911`), and `onRetryRequested`'s "impossible" diagnostic (`:1021`).
`onCallReturned` is **not** one of them — it gates on `ns.status === 'waiting'` (`reduce.ts:952`), and
`waiting` is not even in `LIVE_NODE`. A `retry_pending` node is in none of these sets (neither
`ready`/`dispatched` nor `waiting`), which is the property that matters.

**Decision: do NOT widen `LIVE_NODE`.** Widening it would silently let a late `node.succeeded` fold
onto a held node in those three handlers. Instead `node.retryDue` gets its **own** handler with a
`status === 'retry_pending'` guard, mints the next `attemptId` from `attempts` (as every other
dispatch does), and emits `dispatchNode`. `node.retryRequested` (the existing boot-decision event)
keeps its `LIVE_NODE` guard and stays **distinct** from `node.retryDue` — D4 says so explicitly.

### A.5 HOLD has no boot-recovery path of its own — F2b hard-depends on F2c/S1

`onResumed` (`reduce.ts:1089-1127`) re-emits commands only for `ready` (→ `dispatchNode`) and
`waiting` (→ `startChild`). A `retry_pending` node matches neither, so `onResumed` emits nothing;
`settle` cannot finish the run (held ⇒ non-terminal ⇒ `allTopLevelTerminal` false); and
`reconcile.ts`'s `dispatchedNodes()` selects only `status === 'dispatched'`, so it is not interrupted
either. **Net: after a crash, a held run stays `running` forever unless S1's `scheduled_wakeups` row
re-arms it.**

> **F2c build-time addendum — the reconciler needed a change this section did not predict.** The
> analysis above is exactly right about `onResumed` and `dispatchedNodes()`, and stops one file
> short. A held run reaches `reconcile.ts`'s resume path, re-derives **zero** commands, and so falls
> through `needsExecutor` (`commands.some(...)` on an empty array is `false`) into
> **`report.finalized`** — a bucket documented as *"now terminalized"*. It is not terminalized; it is
> waiting on its alarm. It also collects a fresh `run.resumed` on EVERY boot. Fixed with an explicit
> `held` bucket, gated on there being no commands so a run with a genuinely recoverable node still
> resumes. **"The correct action is none at all" still needs code to say so** — and, per the
> correction below, "none at all" turned out to be the wrong action anyway: the branch now checks the
> alarm row and re-arms or terminalizes. The bucket was right; its body was not.

> **CORRECTION — "re-deriving a `scheduleRetry` here would DOUBLE-ARM it" is FALSE, and this
> paragraph's conclusion is therefore WRONG (probed, both review lenses, independently).**
>
> `armWakeup` (`repo/scheduled-wakeups.ts:34-71`) is **upsert-if-absent** and returns the EXISTING
> row whatever its status. Its own comment states the intent verbatim: *"a replayed `scheduleRetry`
> for an attempt whose alarm already fired must be a no-op, not a resurrection."* The dedupe key is
> deterministic from durable state (`runId`, `nodeId`, `failedAttemptId`), so a re-derived arm
> returns the existing row when there is one — and **creates one when a crash lost it**. Idempotence
> is precisely what makes re-arming free.
>
> That matters because **the HOLD becomes durable strictly BEFORE the alarm exists.** `node.failed`
> folds to `retry_pending` and only *queues* `scheduleRetry`; `pump` drains that command at the
> QUEUE TAIL, so the gap spans every intervening command — minutes of LLM calls, not the sub-tick
> window `launcher.ts` accepts. A crash in that window leaves a log projecting to `retry_pending`
> with **no alarm row**, and this section's advice (plus the `held` bucket built on it) then
> guarantees the run is **`running` forever, across every subsequent boot**. Probed: reconcile
> reports `held`, arms nothing, and the run is unrecoverable without DB surgery.
>
> **The rule stands only when the row EXISTS.** The reconciler must look the alarm up by its derived
> dedupe key (`getWakeupByKey` — which has no non-test caller today and exists for exactly this) and
> re-arm when it is absent, or terminalize. Reporting `held` for a run with no live alarm reports a
> hang as if it were a wait.
>
> **Lesson: an idempotence claim is a property of the code, not of the argument.** This one was
> asserted here, then inherited unchecked by the reducer comment, the handler header, the reconciler
> branch and a test name — five places, one unverified premise, and the safest-sounding option
> ("do nothing") was the unrecoverable one.

**RESOLVED — what actually shipped.** The dependency this section identifies is real and
load-bearing: **F2b shipped without F2c is a hang, not a degraded retry**, so the build order is
F1b → F2b **+** F2c together. Do not ship F2b alone.

Its *conclusion* was wrong, and the correction above says why. The durable alarm row is the recovery
mechanism only WHEN IT EXISTS, and the HOLD→ARM window means it sometimes does not. The reducer
re-derives nothing for a held node — that part stands — but for a reason this section never gave: it
is PURE and cannot read the alarm table, so it cannot answer "does a row exist?". `reconcile.ts`'s
`recoverHeld` can, and does, in three arms (present-and-pending → leave it; absent → re-arm and
append; SPENT → `run.interrupted{retry_alarm_spent}`, because re-arming a settled row is a silent
no-op that would log a due time in the past). See the build order's item 3.

### A.6 Interaction with loop rounds

`resetNodes` (`reduce.ts:691-707`) resets a body to `pending` and keeps `attempts` **monotonic** so a
stale result can never fold. A `retry_pending` node caught in a back-edge reset is reset like any
other — correct, and it is why `attempts` monotonicity must not be "fixed" to reset per round.
`fireBackEdges`'s whole-body-terminal gate (`reduce.ts:507-511`) tests `TERMINAL_NODE`, so a held
node **blocks a bounce** until its retry resolves. Correct and free.

---

## §B — (b) Drain-to-fixpoint **[SETTLED]**, and the convergence answer

**Decision: `settle` drains to a fixpoint.** It no longer emits `finishRun{failure}` the moment
`firstUnhandledFailureTop` finds an unhandled failure (`reduce.ts:735-742` is deleted). The walk
runs to completion; the run's outcome is evaluated **once every top-level entity is terminal**.

Drain is required under **every** option in §C — it is what makes #442's core complaint go away (the
handler that "stays `pending` forever" now runs). So it is settled independently of (c).

### B.1 The convergence answer: PARTIAL — the operator's hypothesis is half right

The operator asked whether HOLD "falls out naturally rather than as a special case" under drain, and
said to test it rather than assume. Tested:

- **TRUE, and it is the good half.** A held node is simply not terminal, so `allTopLevelTerminal` is
  false and the run cannot finish. `firstUnhandledFailureTop` needs **no** "don't count a
  retry-eligible failure" clause; `stepContainers`' `children.every(TERMINAL_NODE)` gate
  (`reduce.ts:555`) makes a container wait for the retry with no code at all. Under drain, HOLD is
  purely "add a non-terminal status" — exactly as hoped, and a real simplification of F2b.
- **FALSE, and the rider hides a bug.** The claim "no change to the outcome predicate is needed" is
  wrong: **P2**. The predicate has two call sites (`reduce.ts:735`, `reduce.ts:1157`) and changing
  one alone makes the reducer reject its own `run.finished{success}` on every affected doc.

### B.2 Mandatory: ONE predicate, one definition

F1b **must** extract the run-outcome decision into a single function and route **both** sites through
it. This is a `TERMINAL_NODE`-style SSOT requirement, not a style preference: the two sites answer
"is this run's outcome success?" and a divergence between them is unrepresentable-by-construction or
it is a latent `invalid_event`. `reduce.ts:787-789` and `reduce.ts:1155-1167` must not be able to
disagree.

### B.3 The cost of drain — stated, not buried

Dropping the short-circuit means **an already-doomed run dispatches every independent branch to
completion** (probed: with `a` failed-unhandled and an independent chain `p1→p2→p3`, today dispatches
`{a, p1}`; drained dispatches `{a, p1, p2, p3}` — strictly more work). The *final outcome* is
unchanged under the settled design (drain + §C.4's predicate both route through §B.2), though not
under the bare drain probe, which reaches `invalid_event` via P2.

ADF does exactly this. But **ADF activities are not billed per token, and studio's are** — studio
nodes are LLM calls and HTTP posts. Drain therefore costs real money and real side effects on runs
already known to be doomed. This is accepted because the alternative is #442's actual bug (handlers
that never run), and because it is what makes the outcome evaluable at all. It is **not** free, and
an operator who sees spend on a doomed run should find this paragraph rather than be surprised.

*No mitigation is available under the settled rule.* Option 2 (the rejected minimal fix) could have
kept the eager short-circuit as a pure optimisation for the unhandled-failure case; under §C.3 the
verdict genuinely depends on draining — `:564` is green precisely *because* the walk drained far
enough for `eh` to run — so the spend cannot be optimised away without changing the answer. That is a
real, un-obvious cost of the decision, and it is accepted knowingly rather than discovered later.

---

## §C — (c) "handled ⇒ success" **[SETTLED — option 3, probed]**

### C.1 The defect

`firstUnhandledFailureTop` (`reduce.ts:312-320`) treats a failure as *handled* if it carries **any**
outgoing `failure`/`completion` edge. ADF instead evaluates **leaves**: *"Evaluate outcome for all
leaves activities. If a leaf activity was skipped, we evaluate its parent activity instead. Pipeline
result is success if and only if all nodes evaluated succeed."*

Correcting #442's framing: it says studio's rule is wrong because a handler "does not have to be a
real catch". **That is not the difference** — under ADF, `a --failure--> h` with no other branch also
succeeds. The *actual* difference is that studio is missing the **skipped-leaf ⇒ evaluate-parent**
rule, which is what makes ADF fail Do-If-Else (`:486`/`:532`).

### C.2 Why this looked like a fork, and why it is not

This was raised as **#475** because two operator-stated principles appeared to be in opposition:

- **"Fail-safe, never fail-open"** (CLAUDE.md, non-negotiable) **eliminates strict ADF parity
  (option 1)** — see **P1**: under `join:'any'`, ADF's leaf rule reports **success** on a run whose
  node failed with no catch anywhere. ADF has no `join:'any'`, so the rule studio would be copying
  was never designed against this shape. This elimination stands and is not revisited.
- **"The spec is right when those `DIVERGES from ADF` labels can be deleted honestly"** (#472)
  **eliminates the safe minimal fix (option 2)**, which leaves `:564`'s divergence pinned forever.

**A third rule satisfies both, and it was probed rather than argued — so the fork dissolves.**
#475 is closed with this evidence. The decision is **option 3**.

### C.3 The decision: leaf-evaluation **AND** absorption

A run FAILS iff **either** conjunct fails:

1. **Absorption** — every `failure` top-level entity must be *absorbed*. A failure is absorbed iff a
   satisfied outgoing `failure`/`completion` edge has a target that actually **RAN**, or its
   skip-taint transitively reaches a satisfied `on:'skipped'` catch whose target **RAN**. A taint that
   merely *evaporates* — the successor ran for an unrelated reason, e.g. `join:'any'` satisfied by a
   different predecessor — is **not** absorption. This conjunct is what closes P1.
2. **Leaf-evaluation** — every forward leaf must evaluate to success; a `skipped` leaf **recurses** to
   its parents instead. This conjunct is what closes divergence 1 (`:486`/`:532`).

Probed verdicts (real reducer, real events, full engine suite):

| Shape | Verdict | Why it is right |
|---|---|---|
| **P1** `join:'any'`, `a` fails with no catch | **failure** | Fail-safe restored — the taint evaporates at `d`, so `a` is unabsorbed. |
| **`:564`** ADF "Generic error handling" | **success** | `a`'s taint reaches `c --skipped--> eh`, which ran → absorbed. No skipped leaf. **The label deletes.** |
| **`:486`/`:532`** Do-If-Else | **failure** | `a` *is* absorbed (its `failure` edge caught), but the skipped leaf `onOk`/`b` recurses to `a`, which failed. **Divergence 1 closed.** |
| **`:507`** genuine Try-Catch | **success** | Absorbed, and its only leaf ran. Preserved. |
| **`:170`** failure whose only out-edge is `on:'skipped'` | **failure** | A skip edge off a *failed* node is `unsatisfied-terminal` — never satisfied. Preserved. |

**Both conjuncts are load-bearing** — neither alone is correct. Leaf-eval alone is option 1 (fails P1);
absorption alone leaves Do-If-Else green (fails `:532`).

**It does not collide with D5's settled rule** that *"an `on:'skipped'` edge does NOT count as handling
a failure"* (spec #1 D5, pinned by `edge-model.test.ts:170`). Absorption reads `on:'skipped'` edges
only along a **skip-taint** — and a skip edge hanging off a *failed* node is `unsatisfied-terminal`
(`reduce.ts:247-251`), so it can never be "satisfied by a node that ran". The two rules are
compatible by construction, not by coincidence.

### C.4 Implementation sketch (probed; ~45 lines, no new helper)

Built entirely on the precomputed `topOutgoing`/`topIncoming` (`reduce.ts:171-180`). `edgeState` and
`endpointOutcome` are reused as-is. Container parity (§D) uses `childOutgoing`/`childIncoming`.

**Two corrections applied when this was built** — the sketch below is the corrected one:
1. **The `seen` guards must actually `add`.** As first written, both recursions passed `seen` and
   never added to it, so a literal transcription infinitely recurses on the P4 shape. Check-then-add
   at function entry, on **both** `absorbedSkip` and `evalEndpoint`.
2. **Lookups are `?? []`, never `!`.** At top scope the maps are keyed by top-level entities, but
   their *values* can name a child when a cross-boundary edge exists (`reduce.ts:177-179` pushes
   `topNode → child` into `topOutgoing`), so the recursion can address an id the map has no key for.
   `validateDoc` forbids that edge and is **advisory** (#444) — the same reason this whole predicate
   must be robust on an unvalidated doc. The pre-F1b code already used `?? []`; not regressing it is
   the requirement.

```ts
const ran = (id) => ['success', 'failure'].includes(endpointOutcome(id, state));
const isDead = (es) => es === 'impossible' || es === 'unsatisfied-terminal';

// A SKIPPED node's taint is absorbed iff it reaches a satisfied on:'skipped' catch that RAN.
absorbedSkip(id, seen):                       // `seen` guards a cycle; revisit ⇒ false
  if seen.has(id) -> false
  seen.add(id)
  for e of topOutgoing(id):
    if e.on === 'skipped' && edgeState(e) === 'satisfied' && ran(e.to)          -> true
    if isDead(edgeState(e)) && outcome(e.to) === 'skipped' && absorbedSkip(e.to, seen) -> true
  false

// A FAILED node is absorbed iff a satisfied failure/completion catch RAN, or its taint reaches one.
absorbedFailure(id):
  for e of topOutgoing(id):
    if (e.on === 'failure' || e.on === 'completion') && edgeState(e) === 'satisfied' && ran(e.to) -> true
    if isDead(edgeState(e)) && outcome(e.to) === 'skipped' && absorbedSkip(e.to, new Set())       -> true
  false

evalEndpoint(id, seen):                       // ADF: skipped leaf ⇒ evaluate parents, RECURSIVELY
  if seen.has(id) -> null
  seen.add(id)
  if outcome(id) === 'failure' -> id          // the blamed node
  if outcome(id) !== 'skipped' -> null
  for e of topIncoming(id): if (b = evalEndpoint(e.from, seen)) -> b
  null

runOutcomeFailure(state):                     // null ⇒ success. THE single predicate (§B.2).
  for id of sortedTopEntities where outcome(id) === 'failure':
    if !absorbedFailure(id) -> id             // conjunct 1
  for id of sortedTopEntities where topOutgoing(id).isEmpty:   // forward leaves
    if (b = evalEndpoint(id, new Set())) -> b // conjunct 2
  null
```

`runOutcomeFailure` is the ONE predicate both call sites route through (§B.2). It is pure, reads only
`state` + the bound graph, and terminates by construction: `seen` bounds both recursions, and it is
only ever reached once `allTopLevelTerminal` holds.

### C.5 Sub-decisions

1. **"Which parent?" — SETTLED: ALL parents are evaluated; ANY evaluated failure fails the run.**
   ADF's prose says "parent" (singular) and studio nodes have many predecessors, so this looked open.
   ADF's own sentence settles it: *"success if and only if **all nodes evaluated** succeed"* — every
   parent is evaluated, so one failed parent fails the run. This is the rule probed above, and it is
   also the fail-safe direction. **It is what flips `reduce.test.ts:195`** (see the blast radius):
   under an "ALL parents must fail" reading `:195` would stay green, so this is a real, deliberate
   choice, not an incidental one.
2. **Recursion is required, not optional.** `edge-model.test.ts:513`
   (`MATCHES ADF: a node skipped by an impossible incoming edge`; edges at `:519` — `x --failure--> a`,
   `a --success--> b`) only stays green if a skipped parent recurses to *its* parent (`b` skipped →
   `a` skipped → `x` succeeded). Not a fork — pinned by an existing test, stated so F1b does not
   "simplify" it away.
3. **What is a leaf, given back-edges? — F1b decides, WITH a test.** `firstUnhandledFailureTop` merges
   `topOutgoing` **and `backOutgoing`** today (`reduce.ts:315`), so a node whose only
   failure/completion out-edge is a **back**-edge is "handled". The sketch above is **forward-only**
   (`topOutgoing` excludes back-edges by construction — `reduce.ts:148-153`), so that node becomes an
   unabsorbed failure and fails the run. **No existing test covers this shape** — the full suite
   passed under the probe. It is narrow (a satisfied failure back-edge normally resets its body and
   re-runs, so the node does not sit terminal-`failure` at drain; an exhausted one already finishes
   the run with `capped`), so it is an implementation detail for F1b rather than a product fork —
   **but F1b must pin it with a test either way, not leave it to fall out.**

   **RESOLVED by F1b: forward-only, and the "pin it either way" instruction cannot be honoured as
   written — because there is nothing observable to pin.** The suspicion in the parenthetical is
   correct and complete: `fireBackEdges` runs at the TOP of `settle`, so a satisfied failure
   back-edge is *always* consumed (bounce, or `capped`) before the walk reaches a fixpoint and the
   predicate runs. Mutation-verified: **re-merging back-edges into the predicate leaves the entire
   suite green**, so a test asserting forward-only-ness would pass under both rules — theatre, not a
   pin. What F1b pinned instead is the **reachable** pair: (i) a satisfied failure back-edge bounces
   rather than reaching the predicate, and (ii) the shape that *does* reach it holding a back-edge —
   one whose reset body can never go terminal (a body node inside a skipped container; `validateDoc`
   rejects it, and is advisory) — where the **pre-F1b reducer reported `success`** on a run whose
   node failed with a catch that could never run. That fail-open is closed by the **`ran(e.to)`**
   clause in `absorbedFailure`, NOT by forward-only-ness (it holds under either), and *that* is what
   the test locks. **Lesson: "pin it either way" presumes the decision is observable. When it isn't,
   say so and pin the property that actually changed.**
4. **`finishRun.reason` — SETTLED: keep `node_failed:<id>`, and mean the BLAMED node.** Under
   leaf-eval the blamed node can sit far **upstream** of the leaf that triggered evaluation
   (Do-If-Else reports `node_failed:a`, reached via skipped leaf `b`). The string is unchanged, so the
   blast radius stays at 5 tests; what changes is that an operator can no longer infer from it that
   `a` had no handler. Accepted: the alternative (a richer reason naming both leaf and blamed node)
   moves 5 further tests for a diagnostic nicety, and is a cheap follow-up if operators ask.
   `capped`/`invalid_event` are unaffected.

### C.6 Reuse — the machinery already exists (do not add a helper)

- **Do NOT build leaf-evaluation on `nodeForwardAdjacency`/`forwardDescendants`** (`params.ts:1951`,
  `:1955-1956`). Those are **node-only** — back-edges *and container endpoints* are excluded by
  construction. Leaf evaluation must range over top-level **entities** (nodes ∪ containers), so
  reusing them would silently drop containers from the leaf set.
- **`reduce.ts:171-180` already precomputes everything needed.** Leaves are
  `sortedTopEntities.filter(id => topOutgoing.get(id)!.length === 0)`. The parent-walk's reverse
  adjacency is **`topIncoming`** — it already exists; there is no reverse-adjacency gap.
  `childOutgoing`/`childIncoming` (`reduce.ts:190-201`) are the identical pair for container parity.

## §D — (d) Container parity **[SETTLED]**

**Decision: whatever (c) settles applies verbatim to containers**, via `childOutgoing`/`childIncoming`
over `c.children` (§C.6). A container's outcome is decided by the same predicate as the run's,
scoped to its children — one rule, two scopes.

Two facts that shrink this to almost nothing:

- **Containers already drain.** `stepContainers` only decides after
  `c.children.every(TERMINAL_NODE)` (`reduce.ts:555`), so divergence 2 is a **top-level-only** defect.
  `firstUnhandledChildFailure` (`reduce.ts:327-335`) short-circuits the *decision*, not the walk.
- **But the top-level short-circuit still kills in-flight containers**, because
  `firstUnhandledFailureTop` fires while a container is mid-round and ends the whole run. Drain (§B)
  fixes that as a side effect.

So (d) reduces to: **`firstUnhandledChildFailure` must be replaced by the same predicate as
`firstUnhandledFailureTop`, not left behind.** It is called out because the two functions are
near-duplicates (`reduce.ts:312` / `:327`) and a fire that fixes only the top-level one leaves
containers on the old semantics **silently** — nothing would fail.

Existing container pins (`edge-model.test.ts:436-478`) must keep passing; a skipped child must still
never fail its stage.

---

## §E — (e) #443 posture **[SETTLED]**

**Decision: the LOG is authoritative over the projection for terminality. #443 is a PREREQUISITE of
F1b, not a follow-up.**

**Why it stops being theoretical.** Runs are event-sourced (`state = fold(run_events)`) with the
**current** reducer, so any semantics change re-folds already-finished logs. F1b is the change that
makes this bite at scale: an old log that recorded `run.finished{success}` under "handled ⇒ success"
(every Do-If-Else doc) re-folds under any (c) option to a run that should have **failed**. The
`run.finished{success}` impossibility check then fires, returns `finishRun{failure, invalid_event}`,
and leaves `state.status === 'running'`. `reconcile.ts:136` selects exactly `status='running'` rows
and decides via the **projection** — so the fast path is missed, `run.resumed` is appended, and **an
already-succeeded run re-executes a node's side effect.**

P2 shows the same `invalid_event` shape arising on a **brand-new** run from the two-predicate-site
bug — same failure mode, two independent causes. §B.2 fixes the new-run cause; this fixes the old-log
class.

**The rule** (per #443's own recommendation): if a run's log records a terminal fact, resync the row
from that fact and never re-derive it under a newer reducer. `run_events` is the source of truth and
`run.finished` is a durable fact; second-guessing it via a re-fold is the **fail-open** direction, and
this repo's rule is fail-safe. This immunises the whole class (any reducer change vs. any pre-existing
log), not just F1b's instance.

**SHIPPED (`terminalFactFromLog`, `run/events.ts`), and the built rule is finer than the sentence
above — read this, not the sentence, when building F1b.** #443's prose said "ends in a terminal
`run.finished`". As built it is **the LAST terminal event wins**, over `run.finished` **and**
`run.interrupted`:

- An "ends in" rule re-drives forever any log with a **trailing non-terminal** — and pre-#443 logs
  have exactly that (`[… run.finished, run.resumed, node.dispatched …]`), because appending
  `run.resumed` over a terminal **is** the bug. Last-terminal-wins heals them; "ends in" cannot.
- It is the only correct read of the one multi-terminal log the driver can produce: `pump` appends
  `run.finished` **before** folding it, so a REJECTED finish is durable, followed by the
  `finishRun{failure, invalid_event}` returned instead. Reading the FIRST terminal resyncs the
  rejected `success`.
- The invariant it rests on is exact: **no TERMINAL event is appended after an ACCEPTED terminal
  event**. NON-terminal events legitimately may — which is why F2c's `node.retryDue` and P3b's
  `call.returned` are free to land later. `launcher.ts`'s `terminalizeInterrupted` gated on the ROW,
  not the log, and violated it (a throw in pump's fold/sync after the durable `run.finished` append
  landed there with the row still `running`, so it appended `run.interrupted` over an accepted
  terminal); fixed in the same PR. **Anything F1b/F2b adds that appends a terminal must honour it.**

**Named cost, probed, accepted:** if a crash lands between a rejected `run.finished{success}` and its
replacement, the log holds that success alone and the row resyncs `success` where the old
projection-based path resynced `failure`. Inherent to the rule — the reconciler cannot distinguish "an
OLD reducer accepted this" (where `success` is right, and is the point of #443) from "the CURRENT
reducer rejects it", and only the version marker deferred below could. It needs a self-inconsistent
reducer at write time — **the two-call-site bug §B.2 fixes** — plus a crash inside that window.

**Explicitly NOT doing (v1): versioning reducer semantics per pipeline version.** A catalog/version
marker so old logs fold under the rules they were written under is the "correct" answer and is
**heavier than v1 needs**. Deferred, with the tradeoff stated: without it, every future reducer
ticket re-opens this question for **in-flight** runs.

**Residual risk, accepted and named:** log-authoritative terminality only immunises **finished** runs.
A run that is genuinely **in-flight across a deploy** still folds under the new reducer and can
project differently from what its driver believed. That window is narrow (crash + upgrade + an
affected doc shape), it is strictly smaller than today's, and closing it needs the version marker
above. Accepted for v1.

---

## Blast radius — the tests that move

**Measured under the option-3 probe (the settled rule): exactly 5 tests across 2 files** — the full
engine suite ran 572 passed / 5 failed, and the 5 failures are this table. An F1b fire that moves a
*different* set has done something this spec did not sanction; one that moves *more* has almost
certainly changed the `finishRun.reason` vocabulary (C.5.4 keeps it deliberately, which is what holds
the number at 5 — under a richer reason string, 5 further tests move).

> **CORRECTION (F1b, build-time): the real number is 6, and the 5 was a measuring artefact.** The
> probe ran the **engine** suite (`packages/shared/src/engine`); `studio-ci` runs `pnpm test`, which
> is `pnpm -r run test` across the **workspace**. The 6th is
> **`packages/server/src/run/__tests__/driver.test.ts:122`** (`an unhandled node failure fails the
> run (row + projection)`), which seeds exactly `a --success--> b` and fails `a`, then asserts
> `b` is `pending`. Under drain `b` reaches `skipped` — the *same* benign/observational flip this
> table already sanctions for `reduce.test.ts:315`, and the run outcome is unchanged. It moved with
> the identical rationale.
>
> This is a trap worth naming, because the sentence above tells the next fire that an unsanctioned
> failure means *its predicate is wrong* — the tempting response to the 6th failure is to start
> rewriting a correct predicate. **A spec's blast radius is only as wide as the suite that measured
> it: state the suite, not just the number.**

| Test | Today | Under the settled rule | Why |
|---|---|---|---|
| `edge-model.test.ts:486` `MATCHES ADF: a skipped final branch…` | `success` | `failure` | **Mislabelled (P3)** — isomorphic to `:532`, and ADF fails it. The `MATCHES ADF` label is wrong and goes. |
| `edge-model.test.ts:532` `DIVERGES from ADF: a failure is "handled" by any failure edge` | `success` | `failure` | The Do-If-Else divergence — closed by the leaf conjunct. **The label deletes.** |
| `edge-model.test.ts:564` `DIVERGES from ADF: an unhandled failure short-circuits…` | `b`,`c`,`eh` = `pending`; `failure` | all run; `success` | Drain makes the handler run; absorption makes the run green. **The label deletes** — ADF's Generic error handling pattern now works end-to-end. |
| `reduce.test.ts:195` `join:all — an unsatisfied-terminal incoming edge SKIPS the node` | `success` | `failure` | **A real pin, not a characterization test** — the loudest signal in this table. `b` fails and *is* absorbed by `catch`, but the skipped leaf `d` recurses to `b`. Deliberate, and **contingent on C.5.1's ANY-parent rule** (under "ALL parents must fail" it would stay green). Its comment "b's failure was handled" must be rewritten, not deleted. |
| `reduce.test.ts:315` `an implicit-chain failure is unhandled → run fails` | `n2` = `pending` | `n2` = `skipped` | Benign/observational — drain lets `n2` reach `skipped` where today the short-circuit leaves it `pending`. `state.status` stays `failure` (`:319` still passes). |
| `driver.test.ts:122` `an unhandled node failure fails the run (row + projection)` **(the 6th — not in the probe's suite)** | `b` = `pending` | `b` = `skipped` | Identical to `:315`, in `packages/server`. Same benign flip; `state.status`/row stay `failure`. |

Unaffected and **must stay green** (verified under the probe): the bounce-cap + skip-only-spin tests
(P4), every container pin, every other `join` semantics pin, the Try-Catch/Try-Catch-Proceed and
generic-error-handling JOIN pins, and the branch-inertness diagnostics.

**A fire will first see 8 failures, not 5.** Deleting the short-circuit alone (drain, before the §C.4
predicate lands) breaks 8; leaf-eval + absorption + the shared predicate restore 3 of them. That is
expected — do not treat the intermediate state as a regression.

---

## Build order

1. **#443** — log-authoritative terminality (§E). **SHIPPED** (`f732950`, PR #478).
2. **F1b** — drain (§B) + the single shared `runOutcomeFailure` predicate (§B.2, §C.4) + container
   parity (§D) + the blast-radius test moves + C.5.3's back-edge/leaf test. **SHIPPED** — one fire,
   as specced. All three call sites (`settle`'s fixpoint, `stepContainers`, the `run.finished`
   impossibility check) route through the one predicate; every `DIVERGES from ADF` label is deleted
   and its test now asserts the ADF verdict. Corrections this spec earned at build time, each probed:
   P4's cycle claim (the guard is load-bearing — a skip-propagated cycle is reachable), §C.4's sketch
   (`seen` never added; `?? []` not `!`), and the blast radius (**6**, not 5 — the probe measured the
   engine suite, CI runs the workspace).

   **C.5.3 resolved, and it found a real fail-open.** On a doc `validateDoc` accepts, the divergence
   is **unobservable**: `fireBackEdges` runs at the top of `settle`, so a satisfied failure back-edge
   always bounces (or caps) before the predicate ever sees its source sitting terminal-`failure`. The
   one shape that reaches the predicate holding a back-edge is one whose reset body can **never** go
   terminal — a body node inside a skipped container — which `validateDoc` rejects ("makes no
   progress") but which reaches the reducer unchecked via git import or a direct POST, because
   `validateDoc` is advisory (#444). Pre-F1b that doc reported **`success`** on a run whose node
   failed with a handler that could never run (mutation-verified in both directions). Forward-only
   absorption closes it. Both halves are pinned.
3. **F2b + F2c together** — `retry_pending`, the `scheduleRetry`/`retryScheduled`/`retryDue` triple,
   the `node.retryDue` handler. **Not F2b alone** (§A.5). **SHIPPED** — one branch, after one fire
   spent entirely on diagnosis (it found F2c's two blockers, wrote them up here, and stopped rather
   than merge a run engine that double-bills). Includes §A.3's corrected eligibility rule, the
   `node_retry` alarm handler (S1's first real consumer), the clock's boot wiring, and `reconcile`'s
   `held` bucket (a run held on a retry re-derives no commands, so it was landing in `finalized` —
   "now terminalized" — and collecting a fresh `run.resumed` on every boot).

   **The unbuilt primitive this ticket actually needed: EXACTLY ONE DRIVE PER RUN.** It is now
   `run/drives.ts` (a `pLimit(1)` per `runId`) plus `driver.ts`'s `driveRun`, and it is a line this
   build order should have carried from the start. The spec sequenced the EVENTS carefully and never
   asked WHO IS ALLOWED TO PUMP. A second driver entry point is not a detail of the retry ticket; it
   is a foundational change to the run engine.

   > ### B1 — two concurrent pumps on one run **[FIXED]**
   >
   > `executor.ts` stated the invariant — *"within a single run the driver's `pump` is sequential"* —
   > which was true only because the LAUNCHER was the sole pump source. F2c's alarm `afterCommit` was
   > a second one, and nothing serialized them. Each `pump` carries its own in-memory `RunState` and
   > never re-reads the log, so two drives diverged permanently and BOTH wrote. Measured on
   > `root→a`, `root→b`, `a→d`, `b→d` with `d` `join:'any'`, `a`/`b` `retry:1` failing transiently
   > once, both alarms due in ONE tick:
   >
   > ```text
   > DISPATCHED: [... "a#1","b#1","d#0","d#0"]   ← d#0 dispatched TWICE, same attemptId
   > RUN ROW: running        run.finished: absent  ← hangs forever
   > ```
   >
   > **The fix is three parts, and all three are load-bearing** (dropping any one leaves the repro
   > red — mutation-verified, not assumed):
   >
   > 1. **`run/drives.ts`** — `serialize(runId, work)`, one `pLimit(1)` per run. Per RUN, never
   >    global: one slow LLM call must not queue every other run behind it. p-limit was already a
   >    dependency (`executor.ts`'s worker pool), and its FIFO ordering, synchronous registration and
   >    rejection isolation are exactly this contract — verified against p-limit@7 and pinned in
   >    `drives.test.ts`, rather than hand-rolled a second time.
   > 2. **Re-project INSIDE the lock** (`driveRun`). Serializing alone is NOT sufficient: a second
   >    drive that waits its turn and then pumps a snapshot taken BEFORE the wait is just as stale.
   >    The lock's only purpose is to make the `loadEngineEvents` a fixed point nothing can append
   >    behind.
   > 3. **`engine.resume(state)`** — a PURE seam re-deriving what `projectRunState` discards
   >    (commands), WITHOUT appending a `run.resumed` (boot's durable fact; appending one mid-run to
   >    obtain its commands would log a crash recovery that never happened). It is the same
   >    derivation `run.resumed` folds to, asserted rather than assumed.
   >
   > The alarm handler's `fire()` still appends `node.retryDue` inside the clock's transaction
   > (at-least-once demands the append and the settle be inseparable); only the DRIVE moved, and its
   > in-transaction commands are now DISCARDED in favour of the re-derivation. The launcher's
   > `launch()` runs under the same lock, spanning its interrupt-cleanup catch too.
   >
   > **Why the `fire()` transaction may still commit mid-pump, safely.** better-sqlite3 is
   > SYNCHRONOUS and Node is single-threaded, so a `fireOne` can only land at one of the pump's
   > `await` points — never mid-fold. Both `retry_pending` and `ready` are non-terminal, so neither
   > the stale nor the fresh projection can emit a premature `finishRun`, and the alarm's own
   > serialized drive re-projects afterwards and picks the dispatch up. The synchronous-transaction
   > half is the load-bearing one.
   >
   > **The boot reconciler pumps WITHOUT the lock**, and that is deliberate: `buildApp` awaits
   > `reconcileOnBoot` BEFORE starting the clock's interval and before the launcher exists, so it is
   > provably the sole pump source. That ordering was WRONG on this branch (the interval was created
   > first, and a 1s tick would fire into a run reconcile was mid-`pump` on); moving one line beat
   > threading the lock through a boot-only path and ~24 test sites. It is stated at both ends.

   > ### B2 — a crash between the HOLD and the ARM **[FIXED]**
   >
   > See §A.5's correction. `armWakeup` is idempotent, so re-arming is free; the HOLD is durable
   > strictly BEFORE the alarm exists (`pump` drains `scheduleRetry` at the QUEUE TAIL, minutes
   > later), so a crash in that window leaves a held run with NO alarm row, and "do nothing" strands
   > it `running` forever across every boot.
   >
   > `reconcile.ts`'s `recoverHeld` now checks the row instead of assuming it, and there are **THREE**
   > arms, not two — the third is one the review caught and the fix design had missed:
   >
   > | row | node | verdict |
   > | --- | --- | --- |
   > | `pending` | `retry_pending` | `held` — a healthy hold, touch nothing |
   > | absent | `retry_pending` | `rearmed` — arm + append `node.retryScheduled{nextAttemptAt}` |
   > | SPENT (`fired`/`suppressed`/`cancelled`) | `retry_pending` | `interrupted{retry_alarm_spent:<nodes>}` |
   >
   > The spent case cannot be healed by re-arming, and this is exactly where idempotence cuts BOTH
   > ways: `arm` would return that very row (same derived key) and change nothing, while the
   > `node.retryScheduled` appended from it would record a due time in the PAST for an alarm that will
   > never fire again. A present-vs-absent check reports that hang as a wait. §A.5's correction did
   > say *"re-arm when it is absent, **or terminalize**"* — the fix design dropped the second half.
   >
   > No duplicate-append hazard: `armRetry` arms BEFORE it appends, so "no row" implies its
   > `node.retryScheduled` never landed either. The reverse window (row armed, append lost) costs only
   > observability — the asymmetry `armRetry` chose deliberately.
   >
   > `RetryAlarms` grew a `find` alongside `arm` so both halves are backed by ONE store. That is not
   > tidiness: the B2 check is "arm wrote nothing, therefore re-arm", so a `find` reading a different
   > store than `arm` writes would report every held run stranded — and the held tests, which used
   > two separate in-memory `stubAlarms()`, would have passed against exactly that. They now seed and
   > boot through one real db-backed store.

   > ### Corrections this section earned at build time (each probed)
   >
   > - **`onResumed` swallowed a dispatch-prep throw** (`catch { continue }`) where every other
   >   dispatch derivation — `tryDispatchNode`, `onRetryDue`, `onRetryRequested` — terminalizes with
   >   `finishRun{invalid_event}`. Survivable while resume ran once per boot; `driveRun` makes it the
   >   RUNTIME path for every retry AND discards `onRetryDue`'s terminalize in favour of it, so a
   >   swallowed throw would be a permanent hang with a spent alarm. Fixed. **Its reachability is
   >   LATENT, and is recorded that way rather than overstated:** no log reaches a `ready` node with a
   >   throwing prep today, because `tryDispatchNode` preps BEFORE it folds and nothing later removes
   >   an upstream output. The test builds the state by hand and says so. The class is closed because
   >   the alternative is an unreachability argument holding forever.
   > - **The retry `discriminator` is fully redundant with `ref.attemptId`** — the key is
   >   `kind:serializeRef(ref):discriminator` and retry's ref already carries the attempt, so the
   >   collision it was credited with preventing cannot happen whatever its value. The claim was
   >   corrected in `driver.ts` AND in `buildDedupeKey`'s own docblock, which stated it more
   >   emphatically and is the doc the next kind's author reads. The spike's finding is REAL for kinds
   >   whose ref does not pin the occurrence (`round-<r>`, `tick-<epoch>`); it is vacuous for retry.
   > - **`AlarmClock.stop()` refused ARMS**, and `buildApp`'s `onClose` calls it: a run settling
   >   during shutdown that failed transiently could not arm its retry, turning an ordinary transient
   >   failure into a DEAD run. Its stated reason ("an alarm nothing will ever serve") was false — the
   >   row is durable and the boot sweep serves it. `stop()` now stops firing only.
   > - **The false double-arm premise was live in six places** (the pure reducer's docblock, the
   >   handler header, `index.ts`'s wiring comment, the reconciler branch, and two test comments), and
   >   `alarms.ts` still said "NOT WIRED INTO `buildApp` YET" while `index.ts` wired it. All corrected.
   >   The reducer's docblock now gives the RIGHT reason it re-derives nothing for a held node: it is
   >   PURE and cannot read the alarm table, so it cannot make the only check that matters.
   >
   > **Lesson: an idempotence claim is a property of the code, not of the argument** — and its
   > converse is just as sharp. The same idempotence that made re-arming free is what makes re-arming
   > a SPENT row a silent no-op. One unverified premise, inherited into six places, produced both the
   > bug and the incomplete fix for it.

   > ### Outstanding, tracked
   >
   > - **#483** — `web/…/runSummary.ts` drops both new events, so a held node's activity pill renders
   >   RED for the whole retry interval (the raw event feed does show them). Deferred because the fix
   >   changes rendered UI and the fire had no browser MCP for the mandatory verify gate. The ticket
   >   carries the measured finding that it needs NO new status and NO CSS — `node.retryRequested` at
   >   `runSummary.ts:102` is the precedent — so the next fire does not re-derive it.
   > - **P3b owes `startChild` re-emit idempotence.** `resume` re-emits `startChild` for every
   >   `waiting` call node, which would re-spawn a LIVE child pipeline — B1's failure mode one level
   >   down. Latent ONLY because P3's executor stubs `startChild` into an immediate
   >   `call.returned{failure}`, so no node ever persists `waiting`. The deterministic `childRunId` is
   >   asserted to make the re-emit idempotent, but there is no driver child creation yet to key on
   >   it. Stated in `Engine.resume`'s docblock; it is P3b's obligation, not an assumption this seam
   >   is entitled to make.

   **Fixed inside F2b** (carried from F2b's ticket row): `driver.ts`'s pump appended the **parsed**
   event (`appendEngineEvent`) but folded the **raw** one (`engine.reduce(state, event)`).

   > **CORRECTED BY F2b (build-time): the fix is right, its stated urgency is not.** "The
   > disagreement decides whether a node retries" **overstates it — this is INERT, today and for
   > `kind` specifically**, and a fire that believes otherwise will write a test that cannot fail.
   > `kind` is the ONLY `.default()` in the whole event union, and both spellings of a missing one —
   > raw `undefined` and the parsed `permanent` — are non-eligible under `kind !== 'transient'`. Live
   > and replay reach the SAME verdict, so no retry decision changes either way. (It also needs a
   > producer that bypasses the type: `EngineEvent` is the z.infer OUTPUT type, so `kind` is required
   > in TS.) Fixed anyway, and fixed at the choke point rather than at `pump` alone —
   > `appendEngineEvent` now returns `{record, event}` and every append-then-fold site folds
   > `.event`. What that buys is the CLASS, not this instance: the next `.default()` added to a field
   > the reducer reads would be a silent live-vs-replay divergence, which is not a bug anyone finds
   > twice. **Lesson: state a latent bug's blast radius as latent.** An overstated one buys a
   > confident test that pins nothing.

## Non-goals

- Re-litigating HOLD vs re-open (#472 settled it; §A).
- Per-version reducer-semantics markers (§E).
- Branch-edge activation — `if`/`switch` remain #4 A0/A1/A2; branch edges stay inert.
