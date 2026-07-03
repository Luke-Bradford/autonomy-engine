# Bring-your-own LLM

The engine can point a role at a **local OpenAI-compatible** LLM endpoint — a
model you run yourself (Ollama, LM Studio) — so cheap background groundwork
(triage, summaries, drafts) offloads to a free local model and saves cloud
subscription tokens. The engine ships the plug-in, **not** the model: you bring
the endpoint.

Best for a light `prep`-style worker. Keep the real coding, planning, and
testing on a cloud account — a 14B local model is groundwork help, not the
delivery agent.

## 1. Stand up an endpoint (example: Ollama, local)

    brew install ollama && brew services start ollama
    ollama pull qwen3:14b        # a 14B fits a 24GB Mac with headroom

Ollama serves the OpenAI API at `http://localhost:11434/v1`. LM Studio serves
one at `http://localhost:1234/v1`.

## 2. Register it as an account

    python3 lib/accounts.py set local-llm openai_compatible http://localhost:11434/v1
    # a remote endpoint that needs a key: store the key in the credentials
    # manager first, then pass its LABEL (the registry never stores the secret):
    #   python3 lib/accounts.py set remote openai_compatible https://gw.example/v1 <cred-label>

`resolve` exports `OPENAI_BASE_URL` (+ `OPENAI_API_KEY` — the real key when a
credential label is set, otherwise the dummy `local`). The index stores the URL
and the credential **label** only, never a secret (mode 600, atomic writes). A
malformed base_url is refused at `set` and again at `resolve` (fail-safe).

    python3 lib/accounts.py list-models local-llm   # what the endpoint advertises

## 3. Point a role at it

    roles:
      prep:
        enabled: true
        account: local-llm      # the endpoint above
        agent: codex            # the adapter that speaks to local models
        model: qwen3:14b
        trigger: { type: loop }
        scope: { labels: [prep] }
        prompt: .autonomy/roles/prep.md

The role's `account:` resolves to `OPENAI_BASE_URL` in the session subshell; the
role's `agent:` selects the adapter that runs it. One repo can therefore run
`coder` on a cloud agent and `prep` on the local one at the same time.

## codex + local models: what actually works today

The verified path (codex-cli **0.136.0**) is codex's **native local provider**:

    codex exec --oss --local-provider ollama -m qwen3:14b   # (adapter does this for you)

When a role resolves to a local endpoint (`OPENAI_BASE_URL` is set), the codex
adapter runs codex with `--oss --local-provider <ollama|lmstudio>` (picked from
the endpoint's default port — 11434 → ollama, 1234 → lmstudio) **and** exports
`CODEX_OSS_BASE_URL=$OPENAI_BASE_URL` so codex targets the real host:port rather
than the provider's hardcoded default — a **non-default-port** local endpoint is
therefore reached, not silently missed (#94). The var is scoped to that single
codex invocation (via an `env` prefix), so it never leaks into a later cloud
role in the supervisor's round-robin. With `OPENAI_BASE_URL` unset, the cloud
invocation is byte-for-byte unchanged. (The port heuristic still only chooses
*which* provider default applies, so an LM-Studio endpoint on a non-1234 port is
detected as ollama — an explicit provider knob is deferred; see #94.)

**Constraint (codex 0.136.0):** codex dropped custom-provider
`wire_api = "chat"` — it now demands the OpenAI *Responses* API, which Ollama and
LM Studio don't implement. So an **arbitrary remote** OpenAI-compatible *chat*
gateway is **not** routable through codex on this version; the supported
bring-your-own path is a **local** Ollama / LM Studio endpoint via `--oss`. The
account layer (`OPENAI_BASE_URL` + credential label + `list-models`) is generic
and already stored, ready for a future adapter — or a codex version that speaks
chat-wire to any endpoint — to use a non-local gateway without a schema change.

## Activating a `prep` role on a repo

Adding the `prep` role and its `.autonomy/roles/prep.md` rails is a per-repo
step in that repo's `.autonomy/` pack. For **autonomy-engine's own** pack this
is an operator action, not an unattended-loop one — `.autonomy/**` is a loop
guardrail (see `.autonomy/hard_rules.md`), so the self-hosting loop does not
edit it on its own.
