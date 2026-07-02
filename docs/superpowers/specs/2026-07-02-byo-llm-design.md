# BYO-LLM — point a role at a local OpenAI-compatible endpoint (design spec)

> Status: **approved in direction** by the operator (2026-07-02) via a brainstorming session.
> Sub-project 1 of two. Sub-project 2 (dynamic model discovery in the config UI) is decomposed out
> and specced separately later. Issue: #78.

## What this is

Let the engine point a `roles:` agent at a **local (or any) OpenAI-compatible LLM endpoint**. The
repo ships the **plug-in mechanism, not the model** — the operator brings their own endpoint
(Ollama, LM Studio, a remote gateway, whatever speaks the OpenAI `/v1` API). The goal is a
**background prep / basic-jobs worker that saves cloud subscription tokens**: cheap groundwork
(triage, summaries, first-pass grooming, simple mechanical jobs) runs on the local model, while the
cloud models keep doing the real coding, detailed planning, and testing.

This is explicitly **not** about shipping or managing an LLM for users — they bring their own. The
repo deliverable is: **the function and ability to point a role at a local endpoint works**,
proven end-to-end, plus documentation of how to plug in.

## Principles (inherit the engine's existing invariants)

- macOS `/bin/bash` 3.2.57; Python 3 stdlib only; source-guarded scripts; `shellcheck -S warning`
  clean incl. `tests/*.sh`.
- **Fail-safe, never fail-open:** an unresolvable endpoint / malformed URL REFUSES the session, the
  same way an unresolvable `account:` does today (increment 3).
- **No secrets in the registry:** the accounts index stores names / kinds / labels / the base URL
  (a URL is not a secret); any API key stays in the Keychain (the #51 store) and is exported
  session-scoped only.
- **Repo-agnostic:** nothing here hardcodes a model name, an endpoint, or a provider in `bin/`/
  `lib/`. The endpoint + model are per-repo config; the model itself is never in the repo.
- Reuse increment 3's dispatch machinery unchanged: `account:` → `accounts.py resolve` → env
  exported in the session subshell → the adapter reads it.

## Layer 1 — a new account kind: `openai_compatible`

Extends `lib/accounts.py` (which already has `claude_subscription`, `codex_subscription`,
`anthropic_api`, `openai_api`). The new kind represents "an OpenAI-compatible endpoint I call from":

```yaml
# ~/.config/autonomy/accounts  (stdlib JSON; still no secrets in here)
accounts:
  local-llm:  { kind: openai_compatible, base_url: "http://localhost:11434/v1" }
  remote-oai: { kind: openai_compatible, base_url: "https://gw.example/v1", credential: gw-key }
```

- **Fields:** `base_url` (required, must be a well-formed `http(s)://…` URL) + optional
  `credential` label (a Keychain key from the #51 store, for endpoints that need auth; local Ollama
  needs none).
- **`resolve(name)` → `{kind, env}`** exports:
  - `OPENAI_BASE_URL=<base_url>` (always),
  - `OPENAI_API_KEY=<secret>` if a credential is set, **else a harmless dummy** (`OPENAI_API_KEY=local`)
    because some OpenAI clients refuse an empty key — Ollama ignores the value.
- **Validation (fail-safe):** `set` refuses a malformed / non-`http(s)` base URL; `resolve` raises
  (never returns a partial/empty env) if the account is missing or the base URL is gone — a caller
  must never run against a broken endpoint silently, exactly like the existing API kinds.
- **CLI:** `accounts.py set <name> openai_compatible <base_url> [credential]`; `resolve` prints the
  `VAR=value` lines the supervisor already consumes. `list`/`get` surface `base_url`.
- **A `list-models <name>` hook** (thin): GET `<base_url>/models`, print the model ids. Local Ollama
  answers this natively. This is the seam sub-project 2 (config-UI model discovery) builds on; here
  it is just a CLI convenience + the proof the endpoint is reachable.

## Layer 2a — per-role agent type

The `prep` role must run a **different adapter** (`codex`, which speaks the OpenAI/Ollama wire API
natively) than the cloud `coder` (`claude`) **in the same repo**. Today the supervisor uses one
global `agent.type` for every role. So this spec adds a per-role `agent:` field:

- `lib/roles.py`: `role_settings` gains `agent` (values `claude` | `codex`, validated like the
  existing per-role fields); it flows out through the `roles.py dispatch <repo> <role>` CLI as an
  extra `AGENT=…` line.
- `bin/supervisor.sh`: `run_session` sources the role's adapter
  (`${AUTONOMY_AGENTS_DIR:-…}/${ROLE_AGENT:-$AGENT_TYPE}.sh`) — the role's `agent:` when set, else
  the global `agent.type` (today's behaviour). This is a direct extension of increment 3's
  per-role resolution (which already does per-role account/model/effort), not new machinery.
- **No regression:** a config with no per-role `agent:` behaves exactly as today (global type).

## Layer 2b — the codex adapter honors the endpoint

`bin/agents/codex.sh` already runs `codex exec -m <model> …`. Codex has **native local-provider
support** (verified against the installed CLI): `--oss --local-provider ollama` points it at a
local Ollama endpoint, and `-c model_providers.<name>.base_url=…` / `-c model_provider=<name>`
points it at an arbitrary OpenAI-compatible endpoint (`wire_api = "chat"`).

- When `OPENAI_BASE_URL` is present in the environment (i.e. the role's account is
  `openai_compatible`), the adapter configures codex to use that endpoint via the `-c
  model_providers.*` override set (base_url + `wire_api="chat"` + `env_key="OPENAI_API_KEY"`),
  selecting it with `-c model_provider=…`. The default-Ollama case may use the simpler `--oss
  --local-provider ollama`; the exact flag set is pinned in the implementation plan after a live
  smoke test.
- When `OPENAI_BASE_URL` is absent (a subscription / API account), the adapter behaves exactly as
  today — **no regression** to the existing Claude/Codex cloud paths.
- The adapter's usage-limit classification + engine-level fallback (the reset-epoch split) are
  untouched. A local endpoint has no rate limit; a connection failure surfaces as an ordinary
  session error → the supervisor's normal error backoff.

**Fallback (documented, not expected):** if a future endpoint can't be driven through codex, a
minimal `bin/agents/openai_api.sh` adapter doing `/v1/chat/completions` directly is the escape
hatch — better suited to a purely non-agentic prep worker anyway. The design does not build it now;
codex's native support covers the local-Ollama case.

## Layer 3 — a background-prep role

Add a role to autonomy-engine's **own** `.autonomy/config.yaml` (the self-loop pack), so the engine
dogfoods the capability:

```yaml
roles:
  coder:                      # unchanged — the cloud account does the real work
    enabled: true
  prep:                       # the local-LLM background worker
    enabled: true
    account: local-llm        # the openai_compatible endpoint above
    agent: codex              # codex adapter, pointed at the local model
    model: qwen3:14b          # the benchmarked winner (see below)
    trigger: { type: loop }
    scope: { labels: [prep] } # only works items explicitly marked for it
    prompt: .autonomy/roles/prep.md
```

- **`prep.md` rails scope it to light work only:** triage / summarize open issues, draft first-pass
  groomings, tidy issue descriptions, simple mechanical chores — and **hand off** anything needing
  real coding / detailed planning / testing to the cloud coder (never attempt those itself). It
  opens PRs / comments like any role but is expected to produce groundwork, not finished features.
- **Token-saving is the point:** the prep role runs on the (free, local) model; the cloder/QA work
  stays on the metered cloud accounts. A role's account is already a first-class per-role choice
  (increment 3), so this is pure configuration on top of Layers 1-2 — no new dispatch code.
- **Proof of done:** one real `prep` session runs against the local model end-to-end (resolves the
  `local-llm` account → codex against `qwen3:14b` → produces a groundwork artifact).

## The local model (environment, NOT the repo)

Chosen empirically per the operator's "install both, benchmark, keep the winner":

- **Serving:** Ollama (`brew install ollama`; OpenAI-compatible at `http://localhost:11434/v1`).
- **Benchmarked on the target M4 / 24 GB** (both fully GPU-offloaded at ~9 GB, ~10 tok/s — half an
  M4 Pro, fine for background work):
  - **`qwen3:14b` — WINNER / default.** Strong general instruction-follower, structured output,
    thinking mode **toggleable** (off = fast for routine prep; on = deeper for harder groundwork).
  - `deepseek-r1:14b` — retained as an optional reasoning model; its chain-of-thought is inherent
    (slower / more verbose for simple prep), so it's the pick only when reasoning depth matters.
- This lives on the operator's machine, documented but never committed. A different operator brings
  a different endpoint/model; the repo capability is identical.

## Documentation

`docs/byo-llm.md` — how to plug in: register a local OpenAI-compatible endpoint as an
`openai_compatible` account (`accounts.py set …` or the config page), optionally link a Keychain
credential, assign it to a role, pick a model. States plainly: **the repo ships the plug-in, you
bring the endpoint and the model.** Includes the concrete Ollama recipe as the reference example
(not a requirement).

## eBull handoff ticket

After the capability lands + a real prep session is proven, file an issue on the **eBull** repo:
"a local OpenAI-compatible LLM endpoint is available at `<url>` for thesis generation — plug in the
same way (OpenAI `/v1` API); it is **not** part of the eBull repo, and eBull's docs should assume
the operator brings the endpoint." eBull consumes the endpoint directly from its own code (thesis
generation is an app-level LLM call, not an engine role) — the shared contract is only the
OpenAI-compatible API + the "bring your own" posture.

## Constraints & invariants (CI-enforced)

- bash 3.2.57; Python 3 stdlib only; source-guards; `shellcheck -S warning` clean incl. `tests/*.sh`.
- Tests source the real scripts; the only new stub boundary is the local HTTP endpoint (mock a
  tiny `/v1/models` / `/v1/chat/completions` responder, or the `curl`/`gh` seam), never the code
  under test. `accounts.py` resolve/validate is unit-tested with an injected credentials fake, same
  as today.
- Fail-safe never fail-open; reset-epoch split untouched; repo-agnostic `bin/`/`lib/`; no secrets
  in the accounts index; the existing cloud adapter paths must stay byte-for-byte behaviourally
  unchanged when `OPENAI_BASE_URL` is unset.

## Build increments (one plan)

1. `openai_compatible` account kind in `accounts.py` (fields, resolve→env, validation, CLI,
   `list-models`) + tests.
2. Per-role `agent:` (Layer 2a): `roles.py` `role_settings`/dispatch CLI + `run_session` sources
   the role's adapter, defaulting to the global `agent.type` + tests (incl. no-regression when
   unset).
3. Codex adapter honors `OPENAI_BASE_URL` (config-override wiring) + a live smoke test pinning the
   exact `-c`/`--oss` flags + a unit test that the cloud path is unchanged when the var is unset.
4. The `prep` role + `prep.md` rails in the self-pack; prove one real session runs.
5. `docs/byo-llm.md`.
6. File the eBull handoff ticket.

## Open questions (resolve at plan time, not blocking)

- Exact codex flag set for a custom endpoint (`--oss --local-provider ollama` vs the full
  `-c model_providers.*` override) — pin with a live smoke test.
- Whether the `prep` role uses its own label (`prep`) or a milestone to avoid contending with the
  cloud coder for the same issues. (Lean: a dedicated `prep` label the operator/PM applies.)
- Keep `deepseek-r1:14b` installed or remove it — operator preference; disk is not a constraint.
