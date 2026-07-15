# Foundation joint spec — run-outcome semantics + retry state machine (F1b + F2b)

**Owns:** #1 **F1b** (pipeline success-semantics reconcile, issue #442) and #1 **F2b** (reducer
retry-eligibility, the D4 HOLD). One spec, because they are **the same predicate**: both are about
what `settle` counts as a run-ending failure.

**Status: FOUR of five decisions SETTLED; decision (c) is an OPEN FORK — see #475.**
**Do not build F1b against this document until (c) is settled.** F2b depends on F1b.

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
| (c) | **#442 divergence 1** — "handled ⇒ success" | **OPEN FORK — #475** — §C |
| (d) | **Container parity** — `firstUnhandledChildFailure` short-circuits identically | **SETTLED** — §D |
| (e) | **#443 posture** — a reducer change re-folds already-bound run logs | **SETTLED** — §E |

---

## Evidence (probed, not argued)

Run against the real `createEngine`/`reduce`, real events, no mocks. The drain probe removed the
`firstUnhandledFailureTop` short-circuit at `reduce.ts:735-742` and changed nothing else. Probe code
was throwaway (the precedent is spec #5's outbox prototype); its **findings** are recorded here
because they are the only evidence anyone has for the blast radius.

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
against this shape.

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
  Terminating by construction, not by a guard.

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

`TERMINAL_NODE` is derived from `TerminalNodeStatusSchema.options` with a `satisfies` guard
(`types.ts:143-148`), so adding an 8th status that *is* terminal and forgetting it there is a compile
error. `retry_pending` is not terminal, so that guard needs no change — **but** the `satisfies`
relationship must be re-checked when the status is added.

### A.2 The event + command triple (do not ship a partial one)

Spec #1 D4 (lines 96-104) specifies **three** primitives. **Verified: none of them exist** —
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

`permanent`/`cancelled` never retry (D4). `policy` is F2a's `NodePolicySchema` (merged, `88a6ed2`);
`policy.retry` absent means "policy says nothing" → **0** → never eligible, so every existing doc is
unaffected. Eligible → fold to `retry_pending` + emit `scheduleRetry`. Not eligible → fold to
`failure` exactly as today.

**Accept the widening, and say why.** #472 flagged that this couples the reducer to retry POLICY:
`settle`'s notion of a run-ending failure becomes policy-dependent. That is real and it is accepted —
it is intrinsic to HOLD, which the operator chose. It is *bounded*: the reducer reads `policy.retry`
and `attempts` and nothing else, and `policy` is already part of the **immutable bound version**, so
the read is replay-stable by construction. It does not read the clock, the driver, or any mutable
row.

### A.4 The `LIVE_NODE` guard — decide, don't inherit

`LIVE_NODE = {ready, dispatched}` (`reduce.ts:75`) gates `onSucceeded`/`onFailed`/`onCallReturned`
and `onRetryRequested`'s "impossible" diagnostic (`reduce.ts:1021`). A `retry_pending` node is in
none of those sets.

**Decision: do NOT widen `LIVE_NODE`.** Widening it would silently let a late `node.succeeded` fold
onto a held node in all four handlers. Instead `node.retryDue` gets its **own** handler with a
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

That is the correct design — the durable alarm row **is** the recovery mechanism, and re-deriving a
retry from the projection would double-arm it. But it makes the dependency explicit and
**load-bearing**: **F2b shipped without F2c is a hang, not a degraded retry.** Build order is
therefore F1b → F2b **+** F2c together, or F2b behind a policy that no doc can set. Do not ship F2b
alone.

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
`{a, p1}`; drained dispatches `{a, p1, p2, p3}` — same final outcome, strictly more work).

ADF does exactly this. But **ADF activities are not billed per token, and studio's are** — studio
nodes are LLM calls and HTTP posts. Drain therefore costs real money and real side effects on runs
already known to be doomed. This is accepted because the alternative is #442's actual bug (handlers
that never run), and because it is what makes the outcome evaluable at all. It is **not** free, and
an operator who sees spend on a doomed run should find this paragraph rather than be surprised.

*Mitigation available under option 2 only:* the conjunction keeps the eager short-circuit legal as a
pure **optimisation** for the unhandled-failure case — same verdict, less spend. Under options 1/3 the
verdict genuinely depends on draining, so it cannot be optimised away. This is a real, un-obvious
argument for option 2 and it belongs in the operator's decision.

---

## §C — (c) "handled ⇒ success" — **OPEN FORK (#475). DO NOT GUESS.**

### C.1 The defect

`firstUnhandledFailureTop` (`reduce.ts:312-320`) treats a failure as *handled* if it carries **any**
outgoing `failure`/`completion` edge. ADF instead evaluates **leaves**: *"Evaluate outcome for all
leaves activities. If a leaf activity was skipped, we evaluate its parent activity instead. Pipeline
result is success if and only if all nodes evaluated succeed."*

Correcting #442's framing: it says studio's rule is wrong because a handler "does not have to be a
real catch". **That is not the difference** — under ADF, `a --failure--> h` with no other branch also
succeeds. The *actual* difference is that studio is missing the **skipped-leaf ⇒ evaluate-parent**
rule, which is what makes ADF fail Do-If-Else (`:486`/`:532`).

### C.2 Why this cannot be settled by the loop

**Two operator-stated principles point in opposite directions.**

- **"Fail-safe, never fail-open"** (CLAUDE.md, non-negotiable). **P1 proves strict ADF parity
  violates it**: `join:'any'` reports success on a run with a wholly unhandled failure. This
  eliminates option 1 **on the merits** — that part needs no operator, and is not the fork.
- **"The spec is right when those `DIVERGES from ADF` labels can be deleted honestly"** (operator,
  #472). This eliminates **option 2**, which leaves `:564`'s divergence permanently in place.

Each principle kills the option the other permits. The residual fork is a **product** judgement about
what "handled" *means* in studio, on the exact shape #442 was filed about:

> **When a failure is absorbed only by skip-propagation to a downstream handler — ADF's documented
> "Generic error handling" pattern — does the run report SUCCESS or FAILURE?**

Note the pattern's *handler* runs under every option; drain (§B) fixes that. Only the **run's
reported outcome** forks.

### C.3 The options

Shape `:564` (ADF "Generic error handling"): `a→b→c`, `c --failure--> eh`, `c --skipped--> eh`; `a`
fails. `a` carries no failure/completion edge; `b`,`c` skip; `eh` runs via the skip arm and succeeds.

| | Rule | `:564` | P1 (`join:'any'`) | Labels deletable? |
|---|---|---|---|---|
| **1. Strict ADF** | leaf-eval only | success | **success — FAIL-OPEN** | yes |
| **2. Conjunction** | `unhandled-failure test` **AND** leaf-eval must both pass | **failure** | failure | **no — `:564` still diverges** |
| **3. Leaf-eval + deliberate-catch absorption** | leaf-eval, but a failure is only absorbed when an outgoing `failure`/`completion`/`skipped` chain was actually **satisfied by a node that ran** | success | failure | yes |

- **Option 1 — eliminated** by the fail-safe invariant (P1). Listed for completeness.
- **Option 2** — fail-safe, smallest diff, every flip conservative, and it keeps the short-circuit
  available as an optimisation (§B.3). Cost: it retains the ad-hoc "has an outgoing failure edge"
  test that #442 objects to, and ADF's documented pattern reports failure forever even though its
  handler ran. `:564`'s label changes reason but does not go away.
- **Option 3** — the only option that is both fail-safe *and* fully ADF-shaped. It closes P1 because
  `join:'any'`'s rescue of `a` is **not** a satisfied catch on `a`. Cost: genuinely new machinery
  (an absorption relation over the drained graph), unproven — it needs its own design + spike pass,
  which is a fire.

### C.4 Recommendation

**Option 3**, with option 2 as the fallback if the operator wants the smaller diff now.

Reasoning: option 3 is the only one that satisfies both stated principles at once, and (c) is the
kind of semantics that is expensive to revisit — it re-folds run logs (§E), so "ship 2 now, move to 3
later" pays the migration cost twice. Against that: option 3 is the only option whose rule has **not**
been probed, and the loop should not invent an absorption relation under an operator directive that
explicitly says to raise new forks rather than guess.

### C.5 Sub-decisions blocked behind (c)

These only bind if leaf-evaluation is adopted (options 1/3, and option 2's second conjunct). They are
listed so the settling fire does not rediscover them:

1. **What is a leaf, given back-edges?** `firstUnhandledFailureTop` merges `topOutgoing` **and
   `backOutgoing`** into today's handled test (`reduce.ts:315`), so a node whose only
   failure/completion out-edge is a **back**-edge is handled today. Leaves can only be computed on
   the **forward** set (the only acyclic one — partitioned at `reduce.ts:148-153`), where that same
   node **is** a leaf and its failure would now fail the run. **A silent flip on the retry-loop
   shape.** Decide explicitly; `topOutgoing` vs `backOutgoing` is the seam.
2. **"Evaluate its parent" must recurse** — `reduce.test.ts:513` (`x --failure--> a`,
   `a --success--> b`) only survives if a skipped parent recurses to *its* parent (`b` skipped → `a`
   skipped → `x` succeeded). State it.
3. **Which parent?** ADF's prose says "parent" (singular); studio nodes have **many** predecessors.
   For a skipped leaf with parents `{p1: success, p2: failure}`, ANY/ALL/the-one-that-caused-the-skip
   give different verdicts. **No spec settles this.** It must be settled with (c) or it becomes a
   third fork.
4. **`finishRun.reason` changes meaning.** Under leaf-eval, `node_failed:<id>` names a node possibly
   far **upstream** of the leaf that triggered evaluation (Do-If-Else reports `node_failed:a`,
   reached via skipped leaf `b`). Same string, new meaning: an operator can no longer infer from it
   that `a` had no handler. Either redefine the vocabulary or add a reason naming both the leaf and
   the blamed node. `capped`/`invalid_event` are unaffected.

### C.6 Reuse — the machinery already exists (do not add a helper)

- **Do NOT build leaf-evaluation on `nodeForwardAdjacency`/`forwardDescendants`** (`params.ts`).
  Those are **node-only** — back-edges *and container endpoints* are excluded by construction. Leaf
  evaluation must range over top-level **entities** (nodes ∪ containers), so reusing them would
  silently drop containers from the leaf set.
- **`reduce.ts:171-180` already precomputes what is needed.** Leaves are
  `sortedTopEntities.filter(id => topOutgoing.get(id)!.length === 0)`. The parent-walk's reverse
  adjacency is **`topIncoming`** (take `e.from` per incoming edge) — it already exists; there is no
  reverse-adjacency gap. `childOutgoing`/`childIncoming` (`reduce.ts:190-201`) are the identical pair
  for container parity (§D).

---

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

**The rule** (per #443's own recommendation): if a run's log **ends in a terminal `run.finished`**,
resync the row from that fact and never re-derive it under a newer reducer. `run_events` is the
source of truth and `run.finished` is a durable fact; second-guessing it via a re-fold is the
**fail-open** direction, and this repo's rule is fail-safe. This immunises the whole class (any
reducer change vs. any pre-existing log), not just F1b's instance.

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

Measured under the drain + leaf-eval probe. **5 tests across 2 files.** Any F1b fire that touches a
different set has done something the spec did not sanction.

| Test | Today | Why it moves |
|---|---|---|
| `edge-model.test.ts:486` `MATCHES ADF: a skipped final branch…` | success | **Mislabelled (P3)** — isomorphic to `:532`. Flips under 1/2/3. |
| `edge-model.test.ts:532` `DIVERGES from ADF: a failure is "handled" by any failure edge` | success | The Do-If-Else divergence. Flips under 1/2/3 — **the label deletes.** |
| `edge-model.test.ts:564` `DIVERGES from ADF: an unhandled failure short-circuits…` | `b`,`c`,`eh` = `pending` | Drain makes the handler **run** under all options. Outcome forks: success (1/3) vs failure (2). |
| `reduce.test.ts:195` `join:all — an unsatisfied-terminal incoming edge SKIPS the node` | success | **Not a characterization test — a real pin.** Flips to failure under leaf-eval: its skipped sibling `d`'s parent-chain reaches `b`. Worth a second look during F1b — a *real* pin moving is a louder signal than a characterization pin moving. |
| `reduce.test.ts:315` | `skipped` | Benign/observational: drain lets a node reach `skipped` that today stays `pending`. |

Unaffected and **must stay green**: the bounce-cap/spin tests, all container pins, every `join`
semantics pin except `:195`, and the branch-inertness diagnostics (P4).

---

## Build order

1. **#443** — log-authoritative terminality (§E). **Prerequisite.**
2. **(c) settled** via #475. **Blocks everything below.**
3. **F1b** — drain + the single shared predicate (§B.2) + container parity (§D) + the blast-radius
   test moves. One fire.
4. **F2b + F2c together** — `retry_pending`, the `scheduleRetry`/`retryScheduled`/`retryDue` triple,
   the `node.retryDue` handler. **Not F2b alone** (§A.5).
   **Fix first, inside F2b** (carried from F2b's ticket row, and F2b is the ticket that makes it
   bite): `driver.ts`'s pump appends the **parsed** event (`appendEngineEvent`) but folds the **raw**
   one (`engine.reduce(state, event)`). Inert while nothing reads `kind` — but F2b's eligibility rule
   reads exactly `kind`, so an untyped event would be *stored* `kind:'permanent'` (the parse default)
   while the *live* reducer saw `undefined`: live and replay disagree, and the disagreement decides
   whether a node retries. Reduce the value `appendEngineEvent` parses, not its input.

## Non-goals

- Re-litigating HOLD vs re-open (#472 settled it; §A).
- Per-version reducer-semantics markers (§E).
- Branch-edge activation — `if`/`switch` remain #4 A0/A1/A2; branch edges stay inert.
