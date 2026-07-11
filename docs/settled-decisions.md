# Settled decisions

Operator-approved decisions that bind all future work. Check this file before
coding (pre-flight-review item H); changing an entry requires surfacing it to
the operator FIRST — never silently reinterpret. Each entry cites its origin.

## Platform

1. **macOS `/bin/bash` 3.2.57 is the floor.** No bash-4isms, ever. The engine
   runs on the operator's stock Mac. *(design.md; CI-enforced.)*
2. **Python 3 stdlib only.** Config parsing via `lib/config_parser.py`
   (restricted YAML subset) — adding a dependency is an explicit operator
   decision. *(design.md.)*
3. **Repo-agnostic engine.** Nothing repo-specific in `bin/`/`lib/`; target
   specifics live in the target's `.autonomy/` pack. *(design.md.)*

## Safety posture

4. **Fail-safe, never fail-open.** A `gh` failure is never CI-green
   (`ci_check`); an unresolvable account/prompt/scope REFUSES the session; a
   misconfigured merge gate hard-refuses rather than upgrading itself.
   *(design.md; PRs #52, #62.)*
5. **`merge_gate.strategy: manual` is the default** and `safe_merge.sh` is the
   only sanctioned merge path. *(design.md.)*
6. **Best-effort periphery:** `board.sh` and `unblock_dependents.sh` warn to
   stderr and `exit 0` on every failure — board/notifier hiccups never block
   engineering. *(design.md.)*
7. **Reset-epoch split:** agent adapters only EXTRACT a usage-limit reset
   epoch (outcome string); `bin/supervisor.sh` is the sole writer of
   `.last_usage_reset` and the shared account-keyed marker. *(#3; PR #62
   preserved byte-identically.)*
8. **Secrets live in the macOS Keychain** (#51). Index files
   (`~/.config/autonomy/credentials`, `…/accounts`) hold names/kinds/labels
   only, mode 600, atomic writes. Secrets never cross argv or logs; session
   env exports are subshell-scoped. *(PRs #52, #54, #57, #62.)*
9. **Dashboard is loopback-only** (127.0.0.1/localhost, anything else refused
   at startup) with a per-process control token on the single write endpoint
   and server-side re-validation of all control input. Controls began
   lifecycle-only (#10) and were deliberately extended to model/config/repo/
   credential/account writes (#24, #47, #51) — every extension stays behind
   the same token + validation, and none may ever touch a target repo's
   trade/order/position path. *(#10, #24, #47, #51.)*

## Agent-org (2026-07-02 brainstorm + increments 1-3)

10. **Three declarative layers** — accounts / agents / execution; nothing
    hard-wired; Managed Agents deferred to an optional account kind.
    *(specs/2026-07-02-dynamic-agent-org-design.md.)*
11. **Auth is account-first:** a role's `account:` beats the legacy #51-C
    `credential:`; account resolution failure refuses the session (fail-safe)
    while the credential path stays best-effort. Subscription = nothing
    exported. *(plans/2026-07-02-headless-dispatch.md, decision 1.)*
12. **Dispatch is round-robin, one session per loop iteration**, role list
    re-enumerated every tick; enumeration FAILURE → coder-only fallback;
    EMPTY enumeration → idle. Cron/event triggers belong to the increment-4
    scheduler/event bus. *(ibid., decisions 2/4/9.)*
13. **Model/effort precedence:** one-shot dashboard override (applied last,
    wins for its one session) > CLI flag > role `model:`/`effort:` >
    `agent.*` config > hardcoded default. Fallback model stays global.
    *(#24 + ibid., decisions 6/7.)*
14. **Merge semantics for roles mirror `dashboard_state.build_roles`**, single
    source in `lib/roles.py` (standard roster defaults; custom roles default
    disabled/loop; no `roles:` block → coder only). *(ibid., decision 5.)*
15. **Session log filename pattern `session-<ts>.log` is a contract** — the
    dashboard globs it; the role name goes in the supervisor.log line instead.
    *(ibid., decision 8.)*
16. **Shared usage-limit marker is one per supervisor** (`engine.account_key`);
    with per-role accounts this over-waits (safe direction) — accepted, and
    per-account limit state is issue #3's scope. *(PR #62 tradeoffs.)*
17. **`instances:` is retired in favour of named lanes** (superseded 2026-07-03,
    operator-approved D1). REMOVED from the schema once lanes Part 1 landed
    (#147): no longer validated, dropped from `role_settings`/the dispatch CLI
    and the supervisor NOTE-stub; a leftover `instances:` in an old config is
    inert (ignored, not an error). Parallelism is now expressed as named lanes.
    *(Was: deferred, PR #62 decision 3; retired via
    specs/2026-07-03-lanes-and-board-contract-design.md D1.)*
26. **Per-phase `models:` is retained-but-flagged, not dropped** (settled
    2026-07-04, #149 item 4). The schema still validates `roles.<r>.models:
    {plan,implement,test}`, but no adapter consumes it — the adapter takes ONE
    model (see entry 13). It is deliberately NOT dropped from the schema: #149's
    fail-safe-honesty NOTE now makes the no-op loud (dispatch and `doctor`
    both emit `roles.<r>.models is set but per-phase models are ignored …`), so
    the original reason to drop — a *silent* validated aspiration — no longer
    holds, and a graceful flagged no-op is more fail-safe than hard-rejecting a
    config that set the knob. Revisit wire-vs-drop when #89 designs per-phase
    model switching; the `_KNOB_NOTES` entry disappears for free the moment it
    is wired. *(#149, interim honesty of #89; enforced by
    `tests/test_roles.py` unwired-knob + models-shape cases.)*

## Lanes + board contract (2026-07-03 operator session, D1–D6)

21. **A lane is a named worktree + role subset**, keyed in the repo's one
    committed `.autonomy/config.yaml`; no `lanes:` block = one implicit lane =
    prior behaviour. One supervisor per lane; default lane keeps the legacy
    launchd label. *(specs/2026-07-03-lanes-and-board-contract-design.md, D1.)*
22. **Parallel lanes coordinate by label partition, not runtime claiming** —
    disjoint `scope.labels` is the claim; overlap is a doctor WARNING, never a
    lease mechanism. *(ibid., D1.)*
23. **Labels are the routing contract; Projects v2 is display-only.** Priority
    is `p1`/`p2`/`p3` labels (no board-field reads); the PM routes purely by
    applying labels and never knows lanes exist — label application IS
    assignment. *(ibid., D2/D3.)*
24. **Onboard creates the standard routing labels idempotently**
    (`ready`, `p1`-`p3`, `needs-design`, plus labels referenced by scaffolded
    scopes); existing labels are never modified; Projects boards are never
    auto-created. *(ibid., D4.)*
25. **GitHub is the only board** — no abstraction layer; board access stays
    concentrated in `board.sh` + the few gh call sites as the seam for any
    future adapter. Cron/event roles fire in the default lane only unless
    explicitly pinned. *(ibid., D5/D6.)*

## Workflow

18. **Nothing merges to main without a PR + CI green + review APPROVE on the
    latest commit** (branch protection, enforce_admins). Every push resets the
    review gate. *(CLAUDE.md workflow.)*
19. **Codex second-opinion checkpoints** at spec/plan, first push, and
    rebuttal-only merges — see
    `.claude/skills/engineering/codex-checkpoints.md`. *(Operator decision
    2026-07-02.)*
20. **Tests are genuine** — real scripts sourced, stubs only at the
    established seams. *(CLAUDE.md; test-quality skill.)*

26. **Done once, done everywhere — owned by the merge gate.** Completion is a
    single atomic checklist (issue closed where the PR says so, board status
    Done for closed / Ready for still-open multi-slice tickets, branch
    deleted, dependents unblocked), and it executes at the MERGE, inside
    `safe_merge.sh` — the one chokepoint every workflow shape passes through
    (coder-driven, QA `auto-merge-on-pass`, human-invoked). Roles never own
    done-marking as a duty: whoever triggers the merge gets hygiene for free;
    the PM sweep is backstop only. Board writes stay best-effort (decision 6).
    *(Operator decision 2026-07-04.)*

## Design-blockers resolution (2026-07-04 evening, operator session)

27. **Attended sessions may edit the guardrail files for the named merge-gate fixes**
    (#255 done-everywhere, #192 doc-only unification, #87/#211 structural write path).
    The unattended loop stays hard-barred from `bin/safe_merge.sh` +
    `.github/workflows/**`; the authorization is ticket-scoped, not a general unbar.
    *(specs/2026-07-04-design-blockers-resolution.md §1.)*
28. **Config persistence splits by nature.** Structural truth (`roles:`,
    `merge_gate.*`) is written ONLY via commit + PR through the normal gate; operational
    knobs (model/effort, board display) stay in the untracked `var/` overlay (#202/#218).
    No overlay for structure, ever. *(ibid. §3; settles the #211 fork.)*
29. **UI config writes use full-block re-emit with double validation** (roles.py +
    re-parse-compare, refuse on mismatch); in-block comments are an accepted loss.
    Never a byte-splice writer. *(ibid. §4.)*
30. **Agents are global entities in `~/.config/autonomy/agents`** (index-file
    conventions: stdlib JSON, 0600, atomic, no secrets); bindings live in each repo's
    `roles:` block and carry the per-binding rules (trigger, scope, lane, gate, budget).
    Dangling agent refs degrade to doctor WARNING + ⚠ badge — never silently dropped.
    *(ibid. §5; operator IA direction on #83.)*
31. **SD-24 clarified: an explicit operator-clicked board-creation OFFER is allowed**
    (automation stays forbidden; scaffolds keep `project_title` empty). *(ibid. §6.)*
32. **Phase track renders only honest layers** — solid observed (timestamped facts),
    outline configured (gate chain), dotted detected prompt-phases, empty no-evidence;
    Slice B milestone sources are board.sh's transition log + session-log gate parsing.
    The escalation-comment schema (fenced `autonomy-question` JSON) and the health
    architecture (shared `lib/health.py`, 15-min wedged rule, console.py as the blessed
    dashboard manager) are settled in the same doc §§8–9. *(ibid. §§7–9.)*

33. **The planner/coder pair is the default coding shape** (operator decision
    2026-07-08, #320). The coder session runs a cheap executor model
    (`agent.model` in the pack config); the thinking happens in a `planner`
    subagent (`.claude/agents/planner.md`, scaffolded by onboard, carrying its
    own thinking-tier `model:` override) dispatched twice per non-trivial
    ticket: plan first (written to a lower-model-executable standard), then a
    closing sense-check of the diff against that plan (`PLAN-CHECK: APPROVE`)
    before the PR is declared done. The pair ADDS a gate — review bot / CI /
    Codex checkpoints are untouched. SD-26 (per-phase `models:`
    retained-but-flagged) is unchanged: the pair rides agent frontmatter, not
    adapter phase-switching. *(#320; operator session 2026-07-08.)*

34. **SD-28 is SUPERSEDED for target-repo packs: UI config edits are local**
    (operator decision 2026-07-08, config-workstreams spec). "Config changes
    should just be local, shouldn't need constant PRs. A user downloading
    this could add their own config, not ours." Structural edits from the
    dashboard land in the **var-live shadow** `var/autonomy/config.yaml`
    (the preflight-surviving home — a tracked-file edit is stash-swept);
    the committed `.autonomy/config.yaml` remains the shareable default
    that SEEDS the shadow on first write (legacy persistent overlay folded
    in, then deleted — the overlay retires). One resolver
    (`config_parser.effective_config_path`, applied in the CLI + python
    API) makes every reader agree. SD-29's writer mechanics stay (validate
    before, re-parse-compare after, refusal leaves files untouched); the
    write additionally refuses when `var/` is not gitignored. A
    present-but-unparseable shadow is a pack FAILURE (doctor/preflight
    refuse) — never a silent fallback to the committed file; safe_merge's
    total CONFIG_GET reading it as absent defaults to `manual` (the safest
    direction — accepted). The unattended loop stays barred from editing
    packs; PR-gating remains the ENGINE repo's own dev workflow only.
    *(specs/2026-07-08-config-workstreams-design.md; #326.)*

35. **P2 is split: typed edges ship on the sequential walk (P2a); real
    bounded parallel dispatch and the SD-12 amendment enabling it are P2b**
    (operator decision 2026-07-09, #349). P2a keeps SD-12 verbatim —
    parallel-eligible nodes INTERLEAVE one node-session per iteration;
    story S33's two-sessions-overlap oracle is deliberately deferred to
    P2b, where SD-12 becomes "one DISPATCH per iteration; a dispatch may
    fan out up to the pipeline's enforced max_parallel concurrent
    node-sessions". Docs and briefs must not imply concurrency P2a does
    not have. *(#349 kickoff comment; plans/2026-07-09-sequencer-p2a-typed-edges.md.)*

36. **SD-12 amended for pipelines (P2b): one DISPATCH per loop iteration; a
    dispatch may fan out up to the pipeline's ENFORCED `caps.max_parallel`
    concurrent node-sessions for that role** (operator pre-authorized via the
    SD-35 split option, 2026-07-09, #351). Round-robin fairness between
    roles, re-enumeration every tick, and pause/stop responsiveness between
    iterations survive; sequential pipelines (`max_parallel` absent/1) keep
    the one-session path byte-identical. Fan-out sessions run in EPHEMERAL
    WORKTREES under `var/autonomy-worktrees/` (two sessions in one checkout
    collide on the git index); in-flight runs join the dispatch list
    regardless of trigger type (a cron/event fire only STARTS a run).
    Branch-level races between parallel sessions pushing one branch are the
    briefs' concern (pull-rebase-push), stated in the template README —
    never silently absorbed. *(#351; plans/2026-07-09-sequencer-p2b-parallel-dispatch.md.)*

37. **Canvas pipeline edits write to the var-live shadow
    `var/autonomy/pipelines/<name>/` via `pipeline_save`** (operator-approved
    P3b direction, 2026-07-09, #365) — SD-34 applied to pipeline DOCUMENTS +
    SD-29 double-validation, generalized from `structural_write` to a directory
    asset. One resolver `pipeline.effective_pipeline_dir(repo, name)` is what
    BOTH dispatch (`resolve_pipeline`, raises) and the dashboard viewer
    (`build_pipeline_view`, degrades) consult; the committed pack SEEDS the
    shadow on first save and stays the shareable default. A present-but-invalid
    shadow REFUSES (dispatch raises, the viewer renders its errors) — never a
    silent fallback to committed (prevention-log #3). The writer re-uses the
    established discipline: gitignore guard (refuse when `var/` is not ignored),
    `name`==folder + charset gates, doc/brief byte caps, seed-from-valid-shadow-
    else-committed (a present-but-invalid shadow is never a seed — no
    laundering), staging built from the doc's own `brief_ref`s (no stray files/
    symlinks), re-validate + deep-compare, reader-safe install (`pipeline.json`
    published LAST via atomic replace — no fallback window), snapshot rollback;
    every refusal leaves the shadow byte-identical. **P3b edits a BOUND pipeline
    only** — a wrapped role has no committed dir to seed from, so its canvas
    stays read-only; creating/binding a new pipeline is P4. The `/pipeline` page
    becomes a token-gated write surface (`__CONTROL_TOKEN__` injected), a new
    `POST /api/control` action (never a new endpoint, SD-9). Minimap + search
    defer to P3c. The unattended loop stays barred from editing packs (SD-28-
    superseded-for-packs); this surface is operator-only via the loopback
    dashboard. *(#365; plans/2026-07-09-sequencer-p3b-canvas-editor.md.)*

38. **The pipeline canvas navigation layer (minimap + search) is client-only
    over the existing payload** (P3c, 2026-07-09, #367). Search highlights/dims
    and jumps by id/type/agent over `curDoc()`; the minimap is a scaled overview
    of the rendered cards with a draggable viewport rect that tracks the canvas
    **scroll**. **Read/navigation only** — no new payload field, no new
    `/api/control` action, no write surface (SD-37's editor and its
    `pipeline_save` path are untouched). **Canvas zoom is deferred**: a scale
    transform would break the editor's `getBoundingClientRect` gesture geometry
    (edge-draw, palette-drop, minimap measurement all assume unscaled
    coordinates). The minimap **gates on HORIZONTAL overflow only** — dagwrap has
    no bounded height, so a tall graph grows the page rather than scrolling
    inside the canvas, and a constant phantom vertical scrollHeight (glyphs + top
    padding) would otherwise show a map for a graph that fits. Navigation is
    available on **read-only viewers too** (not gated on `editable()`). Both
    re-apply only inside `render()` (payload-change/edit) or on operator events,
    so an idle canvas rebuilds nothing (prevention-log #13); the search input
    lives in the never-rebuilt header, so a live tick cannot freeze it (#16). The
    P3b optional follow-ons stay deferred: reset-shadow-to-committed (a write
    surface) and provenance diff (needs a new payload); full-brief-round-trip
    already shipped in P3b. *(#367; plans/2026-07-09-sequencer-p3c-minimap-search.md.)*

39. **Triggers are the dispatch unit** (Phase B of the pipeline+trigger
    model, 2026-07-10, #374). The supervisor enumerates first-class triggers
    (`.autonomy/triggers/<name>.json` + auto-shimmed `roles:` entries);
    SD-12/SD-36 generalise role→trigger verbatim — still one DISPATCH per
    loop iteration, round-robin, re-enumeration every tick, fan-out to the
    pipeline's enforced `caps.max_parallel` — with ONE explicit
    supersession: **SD-12's enumeration-failure→coder-only fallback is
    RETIRED.** Post-cutover an enumeration failure idles new starts for the
    tick (in-flight runs still advance); running coder past a
    config/trigger failure would be fail-open. SD-34's var-shadow extends
    to trigger FILES (`var/autonomy/triggers/<name>.json` beats committed;
    present-but-invalid shadow refuses; symlinked shadow ignored). The
    auto-shim keeps a shimmed trigger's name BYTE-EQUAL to its role name
    (ledger/fingerprint/state-file continuity until the trust re-key
    phase); event roles are NOT shimmed (the event bus keeps firing them
    through the legacy role path until event triggers land). A native
    trigger file supersedes its same-name loop/cron shim; a native name
    colliding with an enabled EVENT role refuses (double-dispatch); a
    refused/broken trigger NEVER falls back to role dispatch. Per-trigger
    pause (`enabled:false`, drain) / stop sentinel (freeze) / error
    backoff live under `var/trigger-ctl/`; the fleet PAUSE sentinel and
    account-level limit state are unchanged. Secrets have NO Phase B sink
    and refuse end-to-end (ref at validate, value/default at start).
    *(specs/2026-07-09-pipeline-trigger-model-design.md;
    plans/2026-07-10-pipeline-model-phaseB-triggers.md; #374.)*

40. **Child runs, event triggers and the secret env channel land as Phase C
    of the pipeline+trigger model** (2026-07-10, #376). A
    `call_pipeline` node spawns a CHILD run that dispatches as its own
    in-flight token (`<parent>.c<slot>.<node>`; SD-12/SD-36 untouched);
    parent and child signal through the `<child>.outcome.json` sidecar; the
    run cap counts call dispatches; depth ≤ 3, call cycles refuse; a failed
    child's projected outputs still return (the findings loop). Back-edge-
    visible node outputs are readable ONLY inside `default()`, whose missing-
    node-output tolerance is the one soft spot in the reference language;
    same-container EARLIER-sibling refs are now static-legal. Event firing is
    a trigger mode: event roles auto-shim onto the legacy per-role semantics
    verbatim, native event triggers fire one run per new token with payload→
    param mapping inside `start_run_trigger`, and TWO SD-39 rules retire
    WITH their reason in the same commit — the event-collision refusal and
    the legacy role-path event resolver (LEGACY-marked; deletion = Phase E).
    A broken native event trigger still never falls back to role dispatch.
    Secrets: a secret param's value is a credential LABEL (SD-8); the ONLY
    sink is a node's `secrets: {ENV_VAR: ${params.<name>}}` map; the value
    resolves supervisor-side (foreground, refuse-on-failure), exports
    subshell-scoped, and is scrubbed from the session log post-session; state,
    journal, briefs and ready-blocks carry labels only. Sidecar suffixes
    (`.outputs`/`.verdict`/`.outcome`) are RESERVED in the state-file glob
    namespace: the token scan skips them and the mint sites (node ids,
    trigger names) refuse them. Trust stays keyed per-assignment (Phase E
    re-keys); the dashboard keeps the role view (Phase D renders children).
    *(specs/2026-07-09-pipeline-trigger-model-design.md §3.1/§4/§5;
    plans/2026-07-10-pipeline-model-phaseC-call-events-secrets.md; #376.)*

41. **Trust keys per TRIGGER; run windows are per-trigger, graceful,
    new-starts-only; the legacy role-dispatch twins are DELETED** (2026-07-10,
    #380, Phase E of the pipeline+trigger model). The ledger counts a journal
    line for trigger T when `line.trigger == T`; a line with NO trigger field
    (or `""`) is grandfathered ONLY for a shim whose name byte-equals the
    line's `role` — a NATIVE trigger earns from zero (inheriting role-era
    evidence for a re-authored parameterisation would be fail-open). Child
    runs (`parent_run` set) are never trigger evidence. The journal is never
    rewritten; the additive `kind` field records shim/native provenance per
    line. The per-pipeline rollup is a fail-safe floor over ALL valid
    triggers (disabled/off-lane included — a pause never hides evidence):
    `auto` only when every trigger reads `auto`; unattributable refused
    trigger files surface as `REFUSED` rows on the `trust` CLI's stdout.
    Run windows: `run_windows: [{start, end, days?}]`, UTC (the cron
    parser's clock), start-inclusive/end-exclusive, wrap past midnight with
    `days` naming the START day, ≤16, explicit `[]` refused, junk fails
    CLOSED; enforced at the four dispatch-facing enumeration verbs
    (dispatch/cron/event/manual) so NEW starts are blocked while in-flight
    tokens advance; manual/queued markers defer while closed, a
    schedule fire that came due while closed fires once at window-open,
    events redeliver; accepted bounds = one-tick end-boundary precision +
    first-sight-at-window-open seeds without firing. The SD-39/SD-40 legacy
    twins (`resolve_dispatch_roles`/`inflight_roles`/`resolve_cron_due`/
    `resolve_event_wakes` + enumerator helpers + the roles.py
    enumerate/cron/events CLI surface) are deleted — the role-dispatch
    fallback is now structurally impossible. The state-file `role` key
    SURVIVES until the dashboard learns triggers (Phase D; supersedes the
    Phase B plan's rename note).
    *(specs/2026-07-09-pipeline-trigger-model-design.md §6/§9-E;
    plans/2026-07-10-pipeline-model-phaseE-trust-windows-retire.md; #380.)*

42. **Phase D1 scope: the dashboard's trigger lifecycle is MARKER-ONLY;
    everything file-shaped waits for D2's `trigger_save`** (2026-07-10, #383
    decisions comment + D1 build). The dashboard learns triggers as read
    surfaces (`/api/triggers`, the `/pipeline` tabs, the trigger-listing
    fleet rail, the rollup chip, REFUSED→needs-you) plus exactly three
    `/api/control` actions — `trigger_fire` / `trigger_stop` /
    `trigger_resume` — that write/remove the supervisor's EXISTING
    lane-scoped `var/trigger-ctl/{fire,stop}/` markers as EMPTY files
    (byte-parity with the consumer). Scope lines, all veto-able on #383:
    per-trigger pause is `enabled:false` in the trigger FILE, not a marker
    — D2; the run-now PARAMS payload channel (decision 3) ships with D2's
    typed-params form (its supervisor-side consumer does not exist yet;
    meanwhile run-now is DISABLED with the reason whenever a dry
    `resolve_params` would refuse — the read and write sides share
    `trigger_fire_ready`); run-now applies to MANUAL-mode triggers only
    (the supervisor WARN-removes other modes' fire markers); `queued/` and
    `backoff/` are supervisor-owned — the dashboard renders them read-only
    and a resume never clears a backoff. Marker writes route like
    `execute_control`: default lane → the managed repo, bare basename;
    non-default lane → `find_lane_service`'s verified worktree (own-service
    `None` keeps the repo, suffix stays), no/refusing service or an
    undeclared lane REFUSES — never guess a worktree, never mint a marker
    no supervisor will consume. `triggers.marker_basename` is the ONE
    python twin of `_trigger_ctl_path`'s naming rule.
    *(#383; specs/2026-07-10-pipeline-model-phaseD1-triggers-read.md;
    plans/2026-07-10-pipeline-model-phaseD1-triggers-read.md.)*

43. **Phase D2 scope: trigger authoring writes the SD-34 FILE shadow via
    `trigger_save`; run-now gains a validated params payload** (2026-07-11,
    #383 D2 build; decisions 2+3 of the 2026-07-10 comment). `trigger_save`
    is SD-29 for a single JSON file (validate_trigger-before with name==stem,
    gitignore guard, `allow_nan=False` canonical serialize + re-parse
    compare, O_EXCL no-follow atomic install; every refusal leaves the
    shadow byte-identical) writing ONLY `var/autonomy/triggers/<name>.json`.
    A missing pipeline binding or unresolvable saved params WARN on a
    successful save, never refuse — refusing would block DISABLING a
    trigger whose pipeline vanished (the fail-open direction). A shim
    edit/toggle MATERIALISES a native file — a deliberate ONE-WAY
    execution-semantics change (role settings stop applying; the doc's
    runs_as drives the run) confirmed in the browser before the first save;
    wrapped-role shims (no pipeline binding) and multi-event shims refuse
    honestly. The run-now payload rides the fire marker's BODY (empty =
    the D1 marker byte-identical): precedence pipeline default < trigger
    saved params < payload; secrets refused at write AND `firecheck` AND
    `start_run_trigger` (three layers, one rule; refusals name the key,
    never the value). The supervisor classifies a non-empty body via
    `triggers.py firecheck` — deterministically-bad payloads remove the
    marker LOUDLY (never an endless retry), transient failures defer with
    the marker kept; the verdict dry-runs `pipeline._resolve_run_params`
    (merged vs saved-only), so it is start-parity by construction. Still
    deferred: trigger delete / reset-shadow-to-committed (a different
    write-surface semantics — pairs with D3's gallery lifecycle), run-now
    on non-manual modes.
    *(#383; specs/2026-07-11-pipeline-model-phaseD2-trigger-save.md;
    plans/2026-07-11-pipeline-model-phaseD2-trigger-save.md.)*

44. **Phase D3 scope: pipeline creation is `pipeline_create` (blank/clone)
    into the SD-34 shadow with a provenance SIDECAR; provenance is display
    truth, never a doc field** (2026-07-11, #383 D3 build; decision 2 of the
    2026-07-10 comment — the LAST D slice). ONE control action: `source`
    absent = blank starter, present = clone of the source's EFFECTIVE doc
    (invalid source refuses — no laundering); collisions with a committed
    OR shadow name refuse (lexists — superseding a committed pack is
    `pipeline_save`'s EDIT semantics, not create); the mkdir-CLAIM install
    shape closes the check→rename race; the provenance record
    `var/autonomy/pipelines/<name>.provenance.json`
    (`pipeline.provenance_path`) installs LAST with rollback — a created
    pipeline exists WITH its sidecar or not at all. Provenance lives
    beside the dir, not in it (the writer's stale-prune owns the dir) and
    not in the document (`validate_doc`'s unknown-key honesty gate stays
    closed); the reader is total with an exact schema — junk is `None`,
    never a fabricated lineage; `diverged` is a canonical-serialize
    content compare against the clone-time fingerprint, absent on any
    doubt. `pipeline_save` edits shadow-only pipelines too; a name with
    NEITHER dir still refuses (create-by-save would bypass the
    discipline). Binding a new pipeline flows through D2's `trigger_save`
    — no new binding surface. Still deferred: pipeline/trigger delete +
    reset-shadow-to-committed (one future "shadow lifecycle" slice);
    save-back-to-template (SD-34 forbids dashboard writes to committed).
    *(#383; specs/2026-07-11-pipeline-model-phaseD3-pipeline-create.md;
    plans/2026-07-11-pipeline-model-phaseD3-pipeline-create.md.)*

45. **Shadow lifecycle: delete and reset-to-committed are ONE operation —
    remove the var shadow — and its guards are fail-closed** (2026-07-11,
    #388; the SD-43/SD-44 deferred pair). `trigger_delete` /
    `pipeline_delete` remove ONLY the SD-34 var-shadow asset (+ the D3
    provenance sidecar); what happens next is defined by the resolvers'
    own fallback order, never a second code path: a committed twin
    resurfaces (reset), a same-name role re-shims (D2's materialise flip
    reversed — the page confirm names it), a shadow-only asset is gone
    (bound triggers keep the honest missing-pipeline state). Committed
    assets are never dashboard-deletable. Guards run BEFORE any mutation
    (refusals byte-identical) and refuse on anything unprovable: in-flight
    tokens (filename over-match for triggers; content attribution for
    pipelines with malformed state refusing), pending fire/queued markers
    (bound, refused-stem and unattributable entries all refuse;
    stop/backoff never block — per-name state stays honest for a
    resurfaced twin), unlistable dirs (ENOENT alone is provably empty).
    Scan scope is the managed repo only — a separate lane service
    resolves from its OWN checkout, so this repo's shadow delete cannot
    affect it. Pipeline detach is an atomic rename into the delete-owned
    `.trash` reserved suffix (sharing the writers' `.staging` would race
    concurrent create/save under the ThreadingHTTPServer); the gallery
    skips reserved-suffix entries. *(#388;
    specs/2026-07-11-pipeline-model-shadow-lifecycle.md.)*

46. **The state-file `role` key is DROPPED from every mint; `trigger` is the
    ONE name field** (2026-07-11, #390 — SD-41's deferred drop, executed
    once Phase D completed). No mint (`start_run`, `start_run_trigger`,
    `start_child_run`) writes `role`; readers TOLERATE the key on states
    minted before the drop and never consult or require it (display keys
    `trigger`, then the parsed token name — the filename truth). Journal
    lines are never touched: `_journal_append` keeps its total
    `state.get("role", "")` read, so a post-drop state lands `role: ""`
    (the ledger keys `trigger`, present on every Phase-B+ state) while a
    LEGACY in-flight state finishing after the drop still lands its
    grandfatherable `role`; the dashboard's journal readers key
    trigger-first with the `role` fallback kept for immutable pre-Phase-B
    lines. Re-adding the key, or a reader that requires it, is a
    regression. *(#390;
    plans/2026-07-11-state-role-twin-drop.md.)*

## Adding an entry

A decision belongs here when the operator settled it and future work could
plausibly drift from it. Add: the rule, one line of why, the origin (spec /
plan / PR / date). Keep entries one paragraph max.
