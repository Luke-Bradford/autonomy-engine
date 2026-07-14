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
- **Reasoning** — `reasoningEffort` maps per provider (Claude extended-thinking budget, o-series
  effort, etc.); ollama/others: best-effort or ignored with a note.

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
| L4a | `outputSchema` subset + save-time lowering to `config.outputs` + validation | 2 |
| L4b | provider JSON/tool mode adapters + strict parse/validate | 2 |
| L4c | repair sub-call (internal, same attempt) + metering of both calls | 2 |
| L5 | Model **price table** + `costEstimate` + `activity.metered` event | 2 |
| L6 | **Run-cost projection** + rollup (per run / pipeline) | 2 |
| L7 | LLM `errorMap` (rate-limit→transient + `retry-after`) wired to #1 policy | 2 |
| L8 | Palette **recipes** (Generate/Extract/Classify/Judge presets) | 2 |
| L9 | Prompt/completion secure capture + verbose reasoning log | 2 |
| L10a | local tool contract + single tool call (opaque driver-internal) | 3 |
| L10b | bounded tool loop + telemetry (non-state observability events) + cancellation | 3 |
| L10c | MCP servers + tool security policy | 3 |
| L11a | `agent_task` subprocess telemetry (output/exitCode/summary) | 3 |
| L11b | opt-in structured protocol (JSON-to-file / sentinel block) + schema validation | 3 |
| L12 | Multi-turn / conversation state (agentic loop owns history; single-shot stays stateless) | 3 |
| **L13** | **Connection parameterization + dynamic routing (T9):** non-secret **connection parameters** (expression-bound at dispatch); **`connectionId`/`model` as validated `${}` refs** (route Anthropic-vs-OpenAI by param in ONE node). Since `connectionId` is a top-level `Node` field, this ADDS an expression pass there (or the blessed fallback: `switch(${params.provider})` → fixed-connection nodes → converge). | 2 |
| **L14** | **`cli`/subscription connection kind (T5):** a CLI-agent connection `llm_call` accepts + single-shot adapter (`claude -p`/`codex exec` → stdout); quota/reset-window primitive; `meteringStatus` metered/unpriced/unknown + run-cost completeness flag. | 1 |

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
- **Telemetry vs content split for secure:** ALWAYS log usage/model/provider/latency/stopReason
  (non-sensitive). Prompt/completion are `secure*`-eligible → redacted at emit-time (log
  hash/length/token-count, not text). A **secure structured output cannot drive typed `${}`**
  (#1 D8) — prohibit the downstream ref or use the opaque handle.
- **Prompt budgeting / truncation:** preflight token estimate; fail `permanent` BEFORE the call
  when prompt/schema/tool-history clearly exceed the model window; treat `stopReason=length`
  (truncated output that fails schema validation) as a first-class non-success.
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
   interaction with #1's parallel-variable hard-reject.
