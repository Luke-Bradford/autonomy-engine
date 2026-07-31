# Foundation Spec #2 — LLM-activity model

**Status:** proposed — brainstormed + engine-grounded 2026-07-14; pending Codex + self review.
**Scope:** the "**ADF for AI**" differentiator — make the LLM a first-class, **general-purpose**
pipeline activity (coding is ONE use), config-driven, producing **typed outputs that flow
downstream**. Builds ON Foundation Spec #1 (activity framework, policy, secure, `${}`).
**Non-goal:** re-designing the domain model (#1) or connections; no UI (UI epic renders this).

## Grounding (verified today)

- `llm_call` catalog entry: `connectionKinds:[anthropic_api, openai_api, ollama]`,
  `outputs:[text, stopReason]`, config `{prompt, system?, model?, maxTokens?, temperature?}`,
  `idempotent:false`. **No tools, no structured output, no reasoning knob, no cost/usage.**
- `agent_task` = a supervised **subprocess** (`command`, `args`, `task` appended, `cwd`, `env`,
  `timeoutMs`); `transient` on timeout/kill, `permanent` if never started. The agentic path.
- LLM connection config `{baseUrl?, model?, timeoutMs?}` + secret (API key). llm-shared resolves
  model: node.input.model < connection.config.model < adapter default.

## North star

An LLM node is **one flexible `llm_call` activity** whose *config* selects its shape, plus
`agent_task` for external-CLI agentic work. The palette offers **recipes** (presets) so common
shapes are one click, but the underlying activity + contract is uniform (composable, lean catalog).

### The invocation shapes (all one activity, config-driven)

| Shape | Config that selects it | Typed output | Pipeline use |
| --- | --- | --- | --- |
| **Generate** | `outputMode:text` | `text` | content, drafting, summarize |
| **Extract / structured** | `outputMode:structured` + `outputSchema` | typed fields → `${nodes.x.output.field}` | unstructured→data |
| **Classify / route** | `outputSchema` = enum | typed `category` OUTPUT (this node just succeeds); a **downstream `switch` routes on `${nodes.<id>.output.category}`** (T8, mandatory `default`) | decisioning |
| **Judge / score** | `outputSchema` = `{score, reason}` | `score` | eval, gates |
| **Advisor: think** | `reasoningEffort:high`, no tools | `text`/plan | plan, analysis |
| **Advisor: implement** | tools/agent, action-taking | `result` | execution |
| **Agent (external)** | `agent_task` (CLI subprocess) | `result` | coding, shell agents |

"Thinking vs implementing" = **reasoning-effort + tool-access config**, and composes as a
pipeline pattern (a high-reasoning *plan* node → an *implement* node), not one magic toggle.

## `llm_call` config v2 (the rich model)

```ts
LlmCallConfig = {
  // Prompt — role-tagged messages with ${} substitution (or a single `prompt` shorthand).
  system?: string,
  messages: { role: 'system'|'user'|'assistant', content: string /* ${} */ }[],
  // Model + sampling
  model?: string,                 // resolves node < connection < default (as today)
  temperature?, maxTokens?, topP?, stop?: string[], seed?: number,
  //   ^ #727/#730: `temperature`/`topP` are REFUSED AT DISPATCH (permanent, before
  //     any request) on Anthropic models that removed the sampling knobs, and on
  //     OpenAI reasoning models. The SCHEMA accepts them universally; the MODEL
  //     may not.
  //   ^ #739: `maxTokens` is not refused but RENAMED on the wire — OpenAI reasoning
  //     models take `max_completion_tokens`, which counts reasoning + visible
  //     output, where `max_tokens` counted visible output only. So one authored
  //     number MEANS different things per model, and a value tuned against a
  //     non-reasoning model can be consumed entirely by invisible reasoning.
  //     First-party OpenAI only; a gateway `baseUrl` keeps `max_tokens`.
  // Reasoning / "thinking"
  reasoningEffort?: 'low'|'medium'|'high'|'max',   // provider-mapped (extended thinking / effort)
  // Output
  outputMode: 'text'|'structured',
  outputSchema?: JsonSchema,       // structured: provider JSON/tool-mode enforced; validated → typed outputs
  // Tools (in-process tool-use; agentic single-node loop) — PHASE 2 (see roadmap)
  tools?: ToolDef[], toolChoice?: 'auto'|'required'|'none', mcpServers?: string[],
  maxToolIterations?: number,
}
```

- **Prompt** — `messages[]` role-tagged; every `content` runs the INERT `${}` pass
  (`${params}`/`${vars}`/`${nodes.x.output}`/`${global}`) from #1. `system` shorthand allowed.
- **Structured output** — `outputSchema` is a **restricted schema SUBSET** (object root, finite
  named properties, scalar/json/array/object types, required-vs-optional, NO open
  `additionalProperties` for addressable fields, NO `oneOf/anyOf` unless lowered to `json`).
  At **save-time it is LOWERED into `config.outputs` (`OutputSpec[]`)** — the SSOT `validateRefs`
  already understands — so `${nodes.x.output.field}` type-checks against declared outputs, NOT an
  arbitrary JSON-Schema path. Optional fields type as nullable/optional in the checker. Enforce
  via the provider's JSON/tool mode where available; else parse-and-validate. **Strict validation:
  strip unknown keys, no implicit coercion; store only the validated/normalized object in
  `node.succeeded.outputs`** (raw completion kept separately only if non-secure).
- **Repair is an INTERNAL sub-call, NOT a new engine attempt.** A parse-validate-repair re-prompt
  is another billed provider request *inside the same `attemptId = node#n`* (internal
  `repairIndex`). The node still terminalizes once. Usage/cost include BOTH calls.
- **Schema pinning:** the immutable `PipelineVersion` stores the exact `outputSchema` + generated
  `outputs`; old runs replay against their own contract. An edit makes a new version.
- **Reasoning** — `reasoningEffort` maps per provider (o-series effort, etc.); ollama/others:
  best-effort or ignored with a note. **AS BUILT (#724/#727):** the Anthropic mapping is the MODERN
  surface — `thinking:{type:'adaptive'}` + `output_config.effort`, emitted together — NOT the legacy
  extended-thinking `budget_tokens` budget this line originally named, which the connector never
  emits on any model. Models **known** to predate that surface are refused at dispatch rather than
  400d — the gate is a listed set, not a version comparison, so legacy ids it does not yet list still
  reach the provider and 400 as before (deliberate; `#729`). Note this line's "ignored with a note"
  is the OTHER providers' policy: Anthropic REFUSES rather than ignoring, because silently dropping
  an authored `reasoningEffort` is the defect #724 removed. That refusal is a behaviour change on the
  structured and `toolChoice:'required'` paths, which previously suppressed the keys and succeeded.

## Outputs, usage & cost (first-class)

Cost/usage are **immutable FACTS stamped in the event log**, never recomputed:
- An **`activity.metered` event PER provider response** (incl. repair calls AND failed calls that
  still bill), carrying `{ runId, nodeId, attemptId, provider, model, inputTokens, outputTokens,
  inUnitPrice, outUnitPrice, priceTableVersion, costEstimate, providerRequestId?, ts(driver),
  meteringStatus: 'metered'|'unknown' }`. Prices come from a **model price table** (built-in,
  updatable; per-connection override) captured AT run-time — a future price change never alters a
  past run's cost.
- The **run-cost projection** SUMS these events only (deterministic). Per-run + per-pipeline rollup
  → Monitor. **Crash-window residual (documented):** a provider may bill before `activity.metered`
  is appended; mitigate by appending immediately after each response + carrying `providerRequestId`
  for later reconciliation. Metering is best-effort absent external billing reconciliation.

## Logging / observability

- Full **prompt + completion capture** for debugging, **respecting #1 D8 secure**: prompt/
  completion are `secureInput`/`secureOutput`-eligible fields (redacted at emit-time when set).
- Structured per-activity log: messages, tool calls, reasoning-trace (optional/verbose), usage,
  stopReason — surfaced in the Monitor run-detail (UI epic).

## Error taxonomy (LLM-specific → #1's `kind`)

`errorMap` in the ActivityDefinition (#1 D6) maps provider errors to structured `{kind, code}`:
- **transient** (retry per #1 policy): 429 rate-limit (feed `retry-after`→`retryIntervalSeconds`),
  500/503 overload, network, timeout.
- **permanent**: 400 invalid-request, context-length-exceeded, content-filter, 401/403 auth.
- **cancelled**: run aborted.
A completed 2xx with an unparseable structured output → repair-retry, then `permanent`.
A completed 2xx carrying **no readable completion** → `permanent` (#461, settled in-loop):
absent/non-array response structure (`{}`, `choices:[]`, a non-array `content`) OR zero
text-type blocks means the provider returned no product, not an empty one — the same
response-shape class as an unparseable body, so it is NOT retried. A **present-but-empty**
completion (an explicit `content:''`, or an anthropic `[{type:'text',text:''}]`) is a real
result and **succeeds** — `stopReason` (e.g. `content_filter`, `length`) carries why and
downstream can branch on it. A tool-call-only 2xx (OpenAI `content:null`+`finish_reason:
'tool_calls'`, anthropic all-`tool_use` blocks) is text-mode-empty and fails `permanent`
**only on a node declaring NO tools** — with tools declared (L10a, built 2026-07-22) the
tool calls ARE the flow: the driver answers them and continues. The no-tools path stays
byte-identical (still `permanent`, the pre-L10a behaviour).

## Connections (workers) — reuse #1, extend config

LLM connection kinds unchanged (`anthropic_api`/`openai_api`/`ollama`/`agent`). Extend config
(non-secret) with an optional **price table** + default sampling. Secret = API key (encrypted).
Subscription/CLI auth via `agent_task` (a CLI that carries its own auth — e.g. the Claude/Codex
CLI). **BYO-LLM**: any provider key or local model or CLI plugs in as a connection.

## Roadmap (phased — each ≈ loop-sized; L-series)

| # | Ticket | Phase |
| --- | --- | --- |
| L1 | `llm_call` config v2: role `messages[]` + sampling + `${}` in content | 1 |
| L2 | Real adapters: anthropic/openai/ollama `llm_call` (text mode) + usage capture | 1 |
| L3 | `reasoningEffort` mapping per provider | 1 |

> **L2/L5 split (built 2026-07-18):** L2 introduces the **`activity.metered` engine
> event** — the durable, per-response carrier for the captured usage facts
> (`provider`/`model`/`inputTokens`/`outputTokens`/`meteringStatus`) — **price-less by
> design**. This is NOT a lane violation: `run_events` are immutable, so an L2-era
> run's usage must land in the summable event shape at capture time or be stranded
> forever (the "Outputs, usage & cost" section models usage AS this event, which
> governs over the roadmap's convenience of *introducing* it under L5). **L5 EXTENDS
> the same event additively** with the PRICE fields (`inUnitPrice`/`outUnitPrice`/
> `costEstimate`/`priceTableVersion`) + the price table; **L6** sums it. The event is
> folded INERT by the reducer (observability, like `node.output`), so it never enters
> `outputs`/`${}` and replay never re-calls the model. `providerRequestId` (a usage
> fact for crash-window reconciliation, not a price) is a conscious later addition —
> also additive.
| L4a | `outputSchema` subset + save-time lowering to `config.outputs` + validation | 2 |
| L4b | provider JSON/tool mode adapters + strict parse/validate | 2 |
| L4c | repair sub-call (internal, same attempt) + metering of both calls | 2 |
| L5 | Model **price table** + `costEstimate` + `activity.metered` event | 2 |
| L6 | **Run-cost projection** + rollup (per run / pipeline) | 2 |
| L7 | LLM `errorMap` (rate-limit→transient + `retry-after`) wired to #1 policy | 2 |
| L8 | Palette **recipes** (Generate/Extract/Classify/Judge presets) | 2 |
| L9 | Prompt/completion secure capture + verbose reasoning log | 2 |

> **L9a/L9b split (built 2026-07-18):** L9's "#1 D8 secure" dependency —
> `secureInputFields`/`secureOutputFields` (redacted-when-set) — is **F4 territory
> and NOT built yet** (`pipeline.ts` still *refuses* a `secureOutput` key). Since
> `run_events` are immutable, capturing RAW prompt/completion text absent that
> model would be an unrepairable fail-open leak. So the ticket split: **L9a ships
> the F4-independent, fail-closed METADATA capture** the telemetry-vs-content
> hardening prescribes ("log hash/length/token-count, not text") — a new inert
> `activity.captured` event carrying per-message `{role, chars, contentHash}` +
> `system` + `latencyMs` for TEXT-mode `llm_call`, emitted before every
> post-request terminal (success + each failure), completion OMITTED when absent
> (never `hash('')`). **L9b (#605)** carries the F4-gated remainder: raw-content
> `'full'` mode (+ keyed-HMAC hash to close the unsalted-sha256 oracle), verbose
> reasoning-trace (needs adapter thinking-block extraction too), and structured-
> mode capture (its completion is raw structured content; its request half is
> F4-independent but deferred with it for plumbing cohesion).

| L10a | local tool contract + single tool call (opaque driver-internal) | 3 |

> **L10a (built 2026-07-22):** `ToolDef = {name, description, parameters, expression}`
> — `parameters` is the SAME restricted schema subset as structured output;
> `expression` is a whole-value `${...}` over **`${tool.args.*}` only**, evaluated
> args-only in the inert expression language. That makes a v1 tool **pure +
> read-only BY CONSTRUCTION** (T11's binding decision) with no run-state/I/O/secret
> reach; the `tools` subtree is **deferred-eval** (excluded from dispatch-prep
> substitution; save-time scans each expression with the `tool` root
> context-scoped). One tool ROUND-TRIP per attempt (all parallel calls of one
> response are answered; a second tool-use response fails `permanent`), one
> terminal, per-response metering, one first-exchange L9a capture (continuation
> turns are #605's plumbing). `toolChoice: auto|required|none` — `required`
> downgrades to `auto` on the continuation (else it could never yield text);
> `none` sends no tools at all; Ollama has no forced-choice surface so
> `required` is best-effort there. **AS BUILT (#724):** `required` also used to SUPPRESS Anthropic
> adaptive thinking on a "forced-choice clash" whose premise was FALSE — a forced `tool_choice`
> errors only under MANUAL extended thinking (`thinking:{type:'enabled'}`), which this connector
> never emits, and adaptive thinking supports forced tool use. That suppression, and the structured
> path's identical one it cited as precedent, are DELETED; `reasoningEffort` is honoured on every
> path. Consequence: `max_tokens` caps thinking and output together, so on the structured path
> thinking now competes with the forced `tool_use` block for one budget.
> Tool-level defects (unknown name, invalid args,
> eval error, over-cap result) return **error tool_results the model can recover
> from**, never node failures. `tools`+`structured` is refused in v1 (structured
> rides a forced provider tool); `agent_cli` rejects tools at dispatch (no tool
> wire on a single-shot CLI). CATALOG_VERSION 14→15.

| L10b | bounded tool loop + telemetry (non-state observability events) + cancellation | 3 |

> **L10b (built 2026-07-22):** `maxToolIterations` (1–25, absent = 1 — the L10a
> single round-trip; coupled to `tools` at save) bounds how many tool ROUND-TRIPS
> one attempt may spend — `runTextWithTools` drives the bounded loop, still one
> attempt → one terminal. A toolUse response with the budget spent fails
> `permanent` ("tool budget") AFTER its `metered` — every billed exchange is
> metered, terminal or not. Telemetry = one inert `activity.toolCalled` engine
> event per EXECUTED call (0-based exchange `round`, executed name, provider call
> id, args/result chars + sha256; hashes OMITTED at 0 chars — fingerprints, not
> redaction; #605's keyed-HMAC covers them). Cancellation: the run signal is
> re-checked after each billed toolUse exchange BEFORE tool execution (abort
> outranks budget exhaustion) → `cancelled` terminal, no post-abort
> execution/telemetry (in-flight aborts stay `llmPost`'s). Continuation choice
> still downgrades to `auto`; capture stays first-exchange-only.
> CATALOG_VERSION 15→16.

| L10c | MCP servers + tool security policy — **DEFERRED to the event-modeled side-effecting sub-spec** (operator, 2026-07-23, #653: option B). A NO-OP in v1: local pure tools (L10a/L10b) are the ENTIRE v1 tool surface; MCP/external tools are never admitted under any v1 policy shape — purity stays machine-verified BY CONSTRUCTION, never operator-asserted inside the opaque loop. Re-open only on explicit operator instruction. | 3 |
| L11a | `agent_task` subprocess telemetry (output/exitCode/summary) | 3 |
| L11b | opt-in structured protocol (JSON-to-file / sentinel block) + schema validation | 3 |
| L12 | Multi-turn / conversation state (agentic loop owns history; single-shot stays stateless) | 3 |

> **L12 (built 2026-07-23):** multi-turn is **STATELESS DATAFLOW** — open question
> 5's v1 answer is *neither* option: conversation state lives nowhere; it is a
> VALUE threaded through node outputs. Two primitives: **`history`** (optional
> `llm_call` config; at save a whole-value `${...}` statically refused for
> definite scalars, at dispatch — via whole-value native-type preservation — a
> `llmMessageSchema[]` array prepended to the authored `prompt`/`messages`;
> history system-turns fold into the single system string after the node's own
> `system`) and **`emitMessages: true`** (lowers an appended `{messages, json}`
> output row at save — `lowerLlmEmitMessages`, append-only, after the seed pass —
> and the executor augments a successful text completion with the transcript:
> the request's non-system turns + the final assistant text, assembled at the
> single succeeded choke-point so all three API adapters + `agent_cli` + the
> L10b tool loop are covered uniformly). Tool exchanges are EXCLUDED by
> construction (the agentic loop owns its internal history — this ticket's own
> boundary; tool traffic is `activity.toolCalled` telemetry). An EMPTY completion
> appends no assistant turn (never a manufactured empty turn; `stopReason`
> carries why). `emitMessages`+structured is refused in v1 (the transcript's
> final turn IS the text completion; structured capture is deferred with L9b
> #605). A hand-declared `messages` row without the flag is refused at save (it
> could only ever fail `missing declared output`). Chains COMPOUND with no
> state: `history: '${nodes.a.output.messages}'` — and when F5 variables land,
> `${vars.history}` + `append_variable` feed the SAME input (the run-variable
> option needs no new llm surface, and the F5c parallel-mutation hard-reject
> covers its determinism). A cross-run **conversation object** is continuation
> state — deferred to the same event-modeled sub-spec as L10c (#653 precedent),
> not v1. Neither `history` nor the transcript carries a length cap in v1 —
> a self-threading loop re-embeds its whole past each round (quadratic growth);
> this rides the existing "prompt budgeting / truncation" deferral above, which
> owns the preflight-estimate fix. Toggling `emitMessages` OFF strips the exact
> machine-lowered row again (the lowering pass heals its own append; a
> hand-decorated row is refused, never silently removed). CATALOG_VERSION 16→17
> (a pre-17 build silently DROPS a resolved `history` — its adapter parse
> strips the unknown key — and never emits a declared transcript row).
| **L13** | **Connection parameterization + dynamic routing (T9):** non-secret **connection parameters** (expression-bound at dispatch); **`connectionId`/`model` as validated `${}` refs** (route Anthropic-vs-OpenAI by param in ONE node). Since `connectionId` is a top-level `Node` field, this ADDS an expression pass there (or the blessed fallback: `switch(${params.provider})` → fixed-connection nodes → converge). **DELIVERED in three parts.** (1) **L13a** (#612): `connectionId` as a dispatch-resolved `${}` ref — save-time ref scan, reducer `String(substitute(...))` in the same env as config, threaded ephemerally on `dispatchNode` as `resolvedConnectionId`; owner-authz hardened (a run-param-steered id folds cross-owner hits into NOT_FOUND). (2) **`model`**: already dynamic for free — it lives in `node.config`, which `prepInput` substitutes. (3) **L13b** (#611): connection parameters as an **owner-declared ALLOWLIST** — `Connection.parameters` lists which `config` keys a node may override via `${}`-bound top-level `Node.connectionParams`; the reducer resolves bindings TYPE-PRESERVINGLY (`resolvedConnectionParams`, ephemeral) and the EXECUTOR enforces (allowlist check + `{$secret}`-marker refusal over the RESOLVED value, over-depth fail-closed) then shallow-merges over static config — the static value is the default, the adapter's `configSchema` validates the effective config. Enforcement is dispatch-time by necessity (connections are mutable rows; `connectionId` may itself be `${}`). Settled invariants: declaration lives on the CONNECTION (a shared connection's borrower must not override `baseUrl` and redirect the credential — the owner opts in per key); parameters are NON-secret (markers refused at save AND dispatch); merge-not-interpolation (a `${}` inside `connection.config` stays INERT — retroactively activating stored text is the #473 corruption shape); write bodies re-declare `parameters` optional-no-default (Zod applies a `.default()` through `.partial()`, so a defaulted PATCH field would silently wipe stored allowlists); export strips `connectionParams` alongside a nulled literal `connectionId` (dynamic routes keep both); `CATALOG_VERSION` 17→18 (a pre-18 build strips the field and dispatches on unmodified static config — silent-wrong). | 2 |
| **L14** | **`cli`/subscription connection kind (T5):** a CLI-agent connection `llm_call` accepts + single-shot adapter (`claude -p`/`codex exec` → stdout); quota/reset-window primitive; `meteringStatus` metered/unpriced/unknown + run-cost completeness flag. **DELIVERED — the quota/reset-window primitive (L14c) spans BOTH invocation shapes on an `agent_cli` connection, not just `llm_call` (#799).** The optional per-connection `quota.exhaustionPattern` reclassifies a matching non-zero exit as `rate_limit` + `retryAfterSeconds` on `llm_call` and `agent_task` alike (metering differs by shape: `llm_call` EXCLUDES a refusal as never-served, `agent_task` still METERS it — a multi-turn session burns quota before it learns it is out); either shape can therefore ARM the persisted per-connection window that the dispatch-time admission gate reads. The gate itself always keyed on connection KIND, so it gated both shapes from the start — it was the WRITE side that only `llm_call` could reach, which left a connection consumed solely by `agent_task` nodes unable to ever learn it was exhausted. **#816 then made the opt-in per-ACTIVITY-TYPE** (`quota.classifyActivityTypes`, absent = both, `CATALOG_VERSION` 18→19): the two shapes match very different surfaces — a single completion vs the agent's own transcript — so an operator can scope `agent_task` out without disarming `llm_call` on the same connection. Scoping governs the WRITE side only; the gate still keys on connection kind. **#816 half 1 then narrowed WHAT the pattern reads** (`quota.matchSource`, `CATALOG_VERSION` 19→20): an opt-in `json-lines` source declares the CLI speaks JSON-per-line on stdout and names its error-envelope types, so the pattern sees stderr plus only those envelopes' decoded string leaves — never agent content it did not deliberately format AS a declared envelope. A `stderr`-only format is the sibling that needs no protocol at all. Absent = `text` = the #799 surface. | 1 |

## How it hangs together (with #1 and the rest)

- `llm_call` / `agent_task` are **execution activities in the #1 ActivityDefinition contract**:
  rich `configSchema`, typed `outputs` (incl. structured fields), `supportsPolicy:true`
  (transient retry), `secureInputFields:[messages]` / `secureOutputFields:[text,structured]`,
  `errorMap` (LLM taxonomy), `idempotent:false` (billed).
- Structured outputs feed the **`${}` language** (#1) — the composition superpower (LLM →
  classify → branch on `${nodes.c.output.category}`).
- Usage/cost → **audit + monitoring** (#1 D7 + UI Monitor).
- Reasoning/tools = the "advisor thinking/implementing" the operator asked for; general-purpose
  across content/data/decisioning/coding.

## Invariants & Codex-hardened decisions (folded from review)

- **Replay NEVER re-calls the model.** LLM output, parsed structured output, stopReason, usage,
  cost, tool-trace summaries are **facts in the log**; the reducer folds them. A model call happens
  only on a NEW dispatch attempt (policy retry or explicit rerun), never on replay.
- **Tools (L10) MVP = opaque driver-internal:** the multi-step tool loop runs inside the driver as
  ONE node attempt → one terminal `node.succeeded/failed`, plus **non-state observability events**
  (`tool.called` etc.) + per-response metering. Node stays non-idempotent. Resumable, event-modeled
  tool loops (`tool.requested/completed` + continuation state) = a separate sub-spec, not v1.
- **`agent_task` structured output needs an opt-in PROTOCOL** (JSON to a known file path OR a
  sentinel-delimited block OR a wrapper contract), validated after exit. Without it, expose only
  `output`/`exitCode`/`summary` — arbitrary CLI stdout is not typeable.
- **`agent_task`'s "any exit code is `succeeded`" (exit code is data) has exactly TWO carve-outs**,
  both opt-in per node/connection and neither weakening the default: (1) L11b structured mode, where
  the fenced block becomes the success contract; and (2) **L14c quota classification (#799)** — a
  non-zero exit matching the connection's `quota.exhaustionPattern` is a `rate_limit` failure, not a
  success. The rule that "exit code is data" exists so a graph can branch on the AGENT'S verdict, and
  a quota-refused agent produced none; left as a success, the CLI's refusal TEXT would flow into
  `${nodes.x.output}` and every downstream node would run on it. Note the consequence: with no
  `policy.retry` budget such a node settles to failure and fails its run, where it previously
  succeeded. Quota-aware RETRY is only reachable this way — `retryEligible` gates on the engine
  `transient` kind, which only a `failed` event can carry, so a success can never schedule one.
  **The opt-in is per-ACTIVITY-TYPE since #816:** `quota.classifyActivityTypes` names which invocation shapes the
  pattern produces a verdict on (absent = both, i.e. the #799 semantics unchanged), so keeping
  `agent_task`'s exit-code-is-data contract no longer costs `llm_call` its classification on the same
  connection. It scopes the WRITE side only — the admission gate keys on the CONNECTION, so a shape
  scoped out is still refused dispatch while a window armed by the other shape is live. That is the
  fail-safe reading: the window states the subscription ACCOUNT is exhausted, which is true for every
  shape spending it; scoping declares only whose output is trustworthy EVIDENCE of exhaustion.
  Scoping is not free, and the cost is the operator's to weigh: scoping `agent_task` out restores the
  silent-wrong data path above (the refusal text flows into `${nodes.x.output}`) AND leaves the window
  un-armed for sibling `llm_call` nodes. Absent = both is also the only safe default — flipping it to
  `llm_call` would silently re-open the #799 gap for `agent_task`-only connections — but the residue is
  that EXISTING connections keep the wide behaviour until hand-edited (a Connection row is mutable and
  unversioned, so there is no migration and no version signal).
  WHICH SURFACE `agent_task` matches is **ANSWERED by #816 half 1** (`CATALOG_VERSION` 19→20). A stdout
  TAIL cut was investigated and REJECTED: `bin/agents/claude.sh` classifies a Claude Code limit from a
  MID-STREAM `rate_limit_event` and treats a session that continues past one as not-blocked, and
  `bin/agents/codex.sh` is the same shape — so the signal is not positional in either CLI and a tail cut
  would miss real refusals. The evidence pointed at a better candidate and that is what shipped:
  **narrow by SOURCE.** Both engine adapters parse ONLY structured error envelopes and neither greps
  agent content ("an error envelope is API/CLI output, never model content" — `codex.sh`). So an
  `agent_cli` connection may now declare `quota.matchSource: {format:'json-lines', errorEnvelopeTypes}`
  — the CLI speaks JSON-per-line on stdout (`claude --output-format stream-json`, `codex … --json`), and
  the pattern is then matched against stderr IN FULL plus only the DECODED STRING LEAVES of the named
  envelopes. Keys and the top-level `type` value are excluded (the selector is not the evidence, or a
  `rate.?limit` pattern would fire on claude's routine ALLOWED heartbeat). Absent = `text` = the whole
  stderr+stdout join, byte-identical to #799. It is OPT-IN because studio never injects the format flag
  — the operator owns `args` — and it NARROWS rather than CLOSES: a stdout line that is not a declared
  envelope is dropped (a CLI breaking protocol onto stdout is missed; stderr, where such breaks land, is
  never narrowed), and an agent that PRINTS a well-formed envelope forges one. Parse work is bounded per
  line and per exit, consumed from the END backwards. A connection-level output-format contract that
  ALSO teaches `agent_task`'s success `outputs` and the sentinel-fenced structured-output mode to speak
  JSON-lines is deliberately NOT part of this (#830).
- **Telemetry vs content split for secure:** ALWAYS log usage/model/provider/latency/stopReason
  (non-sensitive). Prompt/completion are `secure*`-eligible → redacted at emit-time (log
  hash/length/token-count, not text). A **secure structured output cannot drive typed `${}`**
  (#1 D8) — prohibit the downstream ref or use the opaque handle.
- **Prompt budgeting / truncation:** preflight token estimate; fail `permanent` BEFORE the call
  when prompt/schema/tool-history clearly exceed the model window; treat `stopReason=length`
  (truncated output that fails schema validation) as a first-class non-success.
  **PARTLY ANSWERED, and DIVERGENTLY, by #750 (2026-07-31).** The "first-class non-success"
  half was NOT taken: it would reverse #461, which settled deliberately that a present-but-empty
  completion IS a real result carrying its `stopReason`. Instead an empty-AND-truncated
  completion still SUCCEEDS and now emits `activity.warned{code:'empty_truncated_completion'}` —
  a non-fatal advisory, inert in the reducer, ordered before the terminal. The preflight
  token-estimate half remains open. Still open too, all tracked in the #750 follow-up: the
  authoring-time hint for `maxTokens` on a reasoning model (blocked on a non-blocking
  `validatePipelineDoc` tier); a node-row marker for the warning (today it reads only in the
  run-detail event feed); a truncated but NON-empty completion, which stays silent by design;
  and — the SIBLING branch of the same budget scenario — a `null` content, which takes
  `noCompletionFailure`'s `malformed_block` path and terminalizes `permanent` with an error that
  never mentions the token budget. `openai-models.ts` declines to pin which shape OpenAI returns
  for a reasoning-model overrun, so the `activity.warned` fix covers an unknown fraction of the
  reported path and the `malformed_block` misattribution is still live.
- **Cost-on-retry / idempotency:** every policy retry is a NEW `attemptId`; every provider response
  under every attempt is metered; unknown billing → `meteringStatus:'unknown'`. Rerun/retry UI
  warns "may incur additional cost."
- **Reasoning-trace capture defaults OFF** (huge / provider-restricted / sensitive) — store
  summaries/metadata; full trace requires explicit verbose logging + secure redaction.

## Non-goals

- No fine-tuning / training. No vector-store/RAG activity here (a later activity in Spec #4's
  library). No provider beyond key/local/CLI connections. No UI.

## Open questions (for Codex / review)

1. Structured output when a provider lacks native JSON/tool mode (ollama models vary) —
   parse-validate-repair only, or refuse structured for such connections at save-time?
2. In-process tools (L10) vs `agent_task`: do we need BOTH agentic paths, or is CLI-agent
   enough for MVP and in-process tools deferred?
3. Cost price-table source of truth: hard-coded table (needs upkeep) vs per-connection required
   config vs optional (cost shown only when configured)?
4. Reasoning trace capture: store (debug value) vs drop (size/secure) by default?
5. Conversation state (L12): a run-variable message history vs a dedicated conversation object —
   interaction with #1's parallel-variable hard-reject. **ANSWERED (L12, 2026-07-23): neither, for
   v1 — multi-turn is stateless dataflow (node-output threading via `history`/`emitMessages`; see
   the L12 built-block). A run-variable history feeds the same `history` input once F5 lands; a
   cross-run conversation object is continuation state, deferred to the event-modeled sub-spec.**
