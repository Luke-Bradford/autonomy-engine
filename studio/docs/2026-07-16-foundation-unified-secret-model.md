# Foundation spec — the unified secret model (item 7)

**Owns:** work-order **item 7** — the unified secret model. Consolidates #1 **D8** (secure
handling) + **F15** (`SecretRef` config-field sink, T10) and #4 **A10** (connection
secret-config split) into ONE contract, as the overview's interlock #4 already directs:
`2026-07-14-foundation-overview.md:51-55` and `:94-96`.

**Status: DESIGN SETTLED. No code in this PR** — this is a spec-only fire, the same shape as
the D4/F1b joint spec (`2026-07-15-foundation-run-outcome-and-retry.md`, PR #476) that preceded
its build. The four build slices land in later fires (build order at the end).

**Why this document exists.** The work order and the loop's own memory frame item 7 as
"F15 + A10" — a SINK plus a connection split. Scoping it revealed that **F15's SOURCE does not
exist**: a `SecretRef` sink is a *reference* to a stored secret addressable independently of any
connection, and today the only secret in the system is a connection-owned row minted as a side
effect of a connection write. So the phase is not two tickets; it is a **source → sink →
redaction → consumer** chain, most of whose links are unbuilt. This spec is the SSOT for that
chain. #1 D8/F15 and #4 A10 point here.

**Provenance.** Direction confirmed by the item-7 planning gate (2026-07-16): key finding
correct, no irreducible operator fork, reuse the existing `secrets` table rather than build a
greenfield store, F4 emit-time redaction is a co-requisite the "F15 + A10" framing dropped, and
A10 is already satisfied for the single-secret connection. Every claim marked *(probed)* was
verified against the real code — see [Evidence](#evidence-probed-not-argued).

---

## The finding that reshapes the phase

**F15 cannot be read as "reference the bound connection's secret."** The spec forecloses it:

- T10 (`overview.md:182-184`): "secrets reach a non-connection activity … **without a bespoke
  connection kind**." The whole point is *decoupling the secret from a connection binding*.
  Referencing the node's bound connection secret would still require a connection and still route
  through the adapter's one fixed credential slot — it satisfies neither clause.
- D3 (`domain-activity-framework.md:88-92`): "Secure globals route to the **secret store** …
  refused in substitution except at **approved secret sinks (D8)**." The architecture is: a
  *named, standalone* secure source, referenced only at a declared sink field. The source is not
  a connection credential.

So F15 (the SINK) has a hard prerequisite — a secret **SOURCE** addressable independently of any
connection binding — **and that source does not exist** *(probed)*:

- No `global_params` table, no `secret_store` table (grep: zero hits).
- No standalone secrets REST route. Secrets are minted ONLY as a side effect of a connection
  write (`server/src/routes/connections.ts:53,99`) or a webhook-trigger write
  (`server/src/routes/triggers.ts:216`). `listSecrets` exists at the repo layer
  (`server/src/repo/secrets.ts:40`) but no route surfaces it.
- No user-facing secret NAME and no ownership: refs are opaque server ids (`newId('secref')`);
  the `secrets` table (`server/src/db/schema.ts:260-269`) is `{id, ref (unique), ciphertext,
  createdAt}` — no `ownerId`, no `name`.

**The encrypted STORAGE, however, already exists and is the right foundation** — do NOT build a
greenfield store. `secrets` table + XChaCha20-Poly1305 via libsodium (`server/src/secrets/
secrets.ts`) + `getSecretByRef` (unique `ref`) already give name-addressable ciphertext at rest.
What is missing is only the *surface*: a standalone create/list/delete REST, owner-scoping, a
user-meaningful name, and `validateRefs` resolution of a secret name.

**A SECOND co-requisite the "F15 + A10" framing dropped: emit-time redaction (F4).** F15 puts a
plaintext secret into an *arbitrary config field* of the activity input at dispatch. The
executor's load-bearing invariant is that plaintext "never enters a persisted event,
`preparedInput`, or `ActivityContext`" (`server/src/run/executor.ts:24-26`, `connectors/
types.ts:30-35`); the connection secret is a side-channel arg to `adapter.runActivity(ctx,
secret)`. F15 must preserve that invariant on the input side AND ensure no adapter echoes a
resolved secret into a `node.output` or an error message — which is exactly F4 (secureOutput /
error redaction), NOT built (only adapter-error `connectors/redact.ts` exists). F15 and the F4
output/error slice are one delivery.

---

## The four decisions this spec settles

| # | Decision | Verdict |
|---|----------|---------|
| (1) | **Source** — new table vs reuse `secrets`; addressing; namespace vs `global_params` | **SETTLED — §1.** Reuse `secrets`; add `ownerId` + `name`; new `/api/secrets` REST; F15 addresses a secret **name** in one namespace; `global_params`/secure-globals (F7) is a *later* layer that also resolves to it. |
| (2) | **Marker shape** — how a config field carries a `SecretRef` | **SETTLED — §2.** A structured JSON marker `{ "$secret": "<name>" }`, deliberately NOT a `${}` string. A field is EITHER a `${}` expression OR a `$secret` marker, never both; the marker's value is a literal name, never an expression. |
| (3) | **Save-time gating** — `secretSinkFields` catalog metadata + `validateRefs` | **SETTLED — §3.** Declare `secretSinkFields` on `ActivityCatalogEntry` (the reserved slot); a `$secret` marker is valid ONLY at a declared sink field of that activity, rejected everywhere else. No `validateRefs` call-site change. |
| (4) | **Dispatch resolution + redaction** — plaintext-out contract | **SETTLED — §4.** Markers resolve just-in-time at dispatch into a transient side channel; the version/config/events store only the marker; F4 output/error redaction ships with the sink. |

**A10 disposition** (§5) and the **slice/build order** (§6) follow.

**No irreducible operator fork.** The overview's master build order already names item 7 as the
consolidated unified-secret phase including source-addressing, redaction, and git-import
(`overview.md:94-96`), so delivering source + sink + redaction + A10 together is *on-plan*, not an
operator scope call. The globals-store-vs-secrets-table and marker-shape questions are design
details this spec settles, not product forks — the loop's own lesson (probe the recommended
option before escalating; memory #475) applies: resolved, not escalated.

---

## §1 — the SOURCE: a standalone, name-addressable secret **[SETTLED]**

**Reuse the `secrets` table, add a surface. Do NOT create a new table.**

### 1.1 Schema delta

`secrets` gains two nullable-safe columns, mirroring `connections`:

- **`ownerId TEXT` (nullable)** — single-principal/local-workspace today (RBAC is a deliberate v1
  limitation, `overview.md:118`); the column is the future-safe boundary, indexed like
  `connections.owner_id`.
- **`name TEXT`** — a user-chosen, human-addressable handle. **Unique per owner**
  (`UNIQUE(owner_id, name)`), so `{ "$secret": "stripe-key" }` resolves deterministically.

`ref` stays the opaque machine id and the FK target for `connections.secret_ref` — **unchanged**,
so connection-owned secrets are untouched. A standalone secret is simply a `secrets` row with a
`name` and no connection pointing at it. A connection-owned secret has a `name` of `NULL`
(minted internally, not user-addressable) — this keeps the two provenances distinct and stops a
node from referencing a connection's private credential by guessing its name.

> **Migration posture.** `name`/`ownerId` are additive + nullable → old rows parse
> (back-compat table, `domain-activity-framework.md:354-364` house rule). No re-fold of run logs:
> secrets are workspace state, not event-sourced run state (contrast #443).

### 1.2 REST — `/api/secrets`

`POST` (create: write-only plaintext `{name, secret}` → encrypt → row; returns the PUBLIC
projection, **never the plaintext or the ciphertext**), `GET` (list: public projection only),
`DELETE`. The public projection is `SecretPublicSchema = { id, name, ownerId, createdAt }` —
mirrors `ConnectionPublicSchema.omit({ secretRef })` (`shared/src/schemas/connection.ts:50`) and
the invariant "must never be reachable from any client-returned schema"
(`shared/src/schemas/secret.ts` header). `DELETE` must refuse a secret still referenced by a
connection (the FK is `onDelete: restrict`) OR by any stored pipeline-version sink — the second
is a soft check (report, don't cascade); a version is immutable, so a dangling `$secret` is a
run-time `SECRET_NOT_FOUND`, never silent success.

### 1.3 Namespace reconciliation with `global_params` (F7)

D3 (`:88-92`) frames secure values as *secure globals* routing to a *secret store*. This spec
makes the **secret name the single namespace F15 addresses now**; secure globals (F7c) become a
*later* layer whose `${global.secureX}` resolves to a secret name. **Do not build `global_params`
in this phase.** F7 references this store; this store does not wait on F7.

---

## §2 — the MARKER: `{ "$secret": "<name>" }` **[SETTLED]**

A config field carries a `SecretRef` as a structured JSON object, `{ "$secret": "<name>" }`, NOT
as a `${}` string. Reasons, all load-bearing:

- **It must stay out of the inert expression language.** D8: "a secure value can't drive typed
  `${}`". The engine invariant is "`${}` stays INERT" (`executor.ts:24`). A `${secret.x}` string
  would drag secret resolution into `substitute`/the typer/the evaluator — the exact coupling D8
  forbids. A distinguished object sidesteps the whole language.
- **`substitute` already passes it through inert** *(probed)*. `substitute` recurses into objects
  (`params.ts:560-566`); the marker's value `"<name>"` is a plain string with no `${}`, so it
  survives substitution byte-for-byte and reaches dispatch as `preparedInput.<field> = {$secret:
  "<name>"}`. No plaintext, no resolution, in the pure path — resolution is dispatch-only (§4).
- **`SecretRefSchema`** (new, `shared/src/schemas/secret-ref.ts`): `z.object({ $secret:
  z.string().min(1) }).strict()`. A helper `isSecretRef(v)` for the walkers.

**Rules `validateRefs` enforces on the marker itself (§3):**

- The `$secret` value is a **literal name**, never an expression — a `${...}` inside it is
  refused (else `{$secret:"${params.x}"}` would let `substitute` interpolate it, defeating the
  "out of the language" guarantee).
- A field is **EITHER** a `${}` expression **OR** a `$secret` marker — never a string that mixes
  them and never a marker nested inside a larger interpolated string. Whole-value only.

---

## §3 — save-time gating: `secretSinkFields` + `validateRefs` **[SETTLED]**

### 3.1 Catalog metadata

`ActivityCatalogEntry` (`shared/src/catalog/types.ts`) declares the reserved-and-named slot
(`:85-90` already earmarks `secure*Fields` for F15):

```ts
/** Config field NAMES at which a `{$secret}` marker is permitted (a "sink"). */
secretSinkFields?: readonly string[];
```

Default `undefined` = no sinks (every existing activity, unchanged). `http_request` declares its
sink in the consumer slice (§6 S4), not now.

### 3.2 The gate

`validateRefs` (`params.ts:808-836`) reads the per-node activity via `getActivity(node.type)`
(`catalog/registry.ts:80`) — the catalog is in **shared**, so this needs **no signature change**
to `validateRefs`/`validatePipelineDoc`/either call site *(probed)*. A new walk over `node.config`
(parallel to the existing `${}` `scan`):

- Every `{$secret}` marker at a field NOT in the activity's `secretSinkFields` → error
  (`nodes.<id>.config.<path>: secret reference is not allowed here`).
- A marker at a declared sink → accepted.
- The two marker-shape rules from §2 (literal name; no mix with `${}`).
- The existing rule stays: a **secret-typed PARAM** ref anywhere is still refused
  (`params.ts:804`) — that is a *different* mechanism (a connection credential LABEL) and is not
  loosened.

Because both gates call `validatePipelineDoc` (`params.ts:872`), the canvas badge and the server
write-gate refuse an ill-placed marker identically — by construction, the #473 lesson.

### 3.3 Secure OUTPUT — prohibit-first (resolved-Q-2, already decided)

`domain-activity-framework.md:412-416` already settled: MVP `validateDoc` **hard-prohibits** a
`${nodes.x.output}` ref where `x` declares `secureOutput`. The opaque-handle target is later. This
spec does not reopen it; it notes the sink work must land alongside the F4 secureOutput slice so
the prohibition and the redaction are one contract, not two half-built halves.

---

## §4 — dispatch resolution + redaction: plaintext-out contract **[SETTLED]**

### 4.1 Resolution (server, dispatch-only)

At `performDispatch` (`executor.ts:232-326`), AFTER the pure pre-flight and `node.dispatched` is
emitted, walk the activity's `secretSinkFields` in `command.preparedInput`; for each `{$secret:
name}` marker: resolve `name → secrets` row (owner-scoped) → `decrypt(ciphertext, masterKey)`
(reuse the exact path at `executor.ts:158`). Collect into a **side-channel** structure that is
passed to the adapter alongside the existing connection `secret` — NEVER merged into `ctx.input`
(loggable) or `preparedInput` (which, though transient, is the command). New failure codes,
distinct like the connection ones (`SECRET_NOT_FOUND` already exists; add
`CONFIG_SECRET_NOT_FOUND` / `CONFIG_SECRET_UNDECRYPTABLE`), all `permanent` (a config mistake does
not self-heal on retry — same reasoning as `resolveConnection`, `executor.ts:96-104`).

**Adapter contract change (backward-compatible):** `runActivity(ctx, secret, secretFields?)` — a
new optional third arg `Record<string, string>` (field name → plaintext). Adapters that declare no
sink ignore it; their existing tests pass unchanged (extra optional arg). Only the sink-declaring
adapter (`http_request` first) reads it. This mirrors the existing "secret is a distinct arg, not
in `ctx`" discipline (`connectors/types.ts:8-10`) rather than inventing a second pattern.

### 4.2 Redaction (F4 co-requisite)

The version/config stores the MARKER; `node.dispatched` carries none of the input *(probed:
`executor.ts:305-311` emits only `{runId,nodeId,attemptId,idempotent}`)*; `preparedInput` is
transient and never persisted. So the INPUT side is safe by the same construction that makes the
connection secret safe today. The OUTPUT/error side is F4: an adapter must never surface a
resolved secret in a `node.output` or a failure message — reuse and extend `connectors/
redact.ts::redactSecrets` to include the resolved sink values, exactly as `http.ts:105` already
does for the connection secret. Ship the redaction with the consumer, not after it.

### 4.3 Fail-closed until the consumer exists

Until an activity declares a `secretSinkField`, `validateRefs` refuses EVERY marker, so no stored
version can contain one → dispatch never sees one. The resolution walk is defence-in-depth. There
is no window in which a saved marker silently does nothing (the F13a fail-open shape): the sink
declaration (S4), the resolution (S3), and the http consumer (S4) land together, so the first
version that can *hold* a marker is also the first that can *resolve* it.

---

## §5 — A10 disposition: already satisfied; the marker subsumes the rest **[SETTLED]**

The public/secret **split A10 asks for already exists** for a single-secret connection *(probed)*:
`config` is a non-secret record, `secretRef` is a separate nullable pointer,
`ConnectionPublicSchema` strips it (`connection.ts:23-24,50`), plaintext lives encrypted in
`secrets`. **Do not re-build it.**

A10's only genuine *remaining* scope is multi-secret-per-connection / a secret INSIDE `config` —
explicitly the deferred decision at `connection.ts:42-48` ("whether `config` itself can carry
secret-adjacent values … is NOT resolved here"). That bites only when the `fs`/S3 connectors
(A11/A14 — **NOT in item 7**) land.

**Resolution:** when it does bite, adopt the **same `{$secret}` marker** inside a connection's
`config` — one unified mechanism across node config and connection config, rather than adding
more `secret_ref` columns. This is what makes item 7 genuinely *unified*. It is a one-line
note here and a real slice when A11/A14 arrive; item 7 does not build it.

---

## §6 — build order (source before sink)

Four slices, each a bounded, safe, mergeable fire:

- **S1 — SOURCE.** `secrets` gains `ownerId` + `name` (+ `UNIQUE(owner_id, name)`); repo
  create/list/delete by name; `/api/secrets` REST with a write-only plaintext input and a public
  projection that never returns plaintext/ciphertext; `SecretPublicSchema`. Self-contained,
  testable, valuable on its own (store a secret not tied to a connection).
- **S2 — MARKER + GATE.** `SecretRefSchema` + `isSecretRef`; `secretSinkFields` on
  `ActivityCatalogEntry`; `validateRefs` marker walk + the §2 rules. Shared-only; fail-closed
  (no activity declares a sink yet, so every marker is refused — the gate is tested against a
  synthetic sink-declaring catalog entry).
- **S3 — DISPATCH + REDACTION.** Executor resolves markers into the side channel; the
  backward-compatible `runActivity(ctx, secret, secretFields?)` arg; new `permanent` failure
  codes; extend `redactSecrets` to the resolved sink values (F4 output/error slice).
- **S4 — CONSUMER + A10 note.** `http_request` declares a `secretHeaders` sink field (header name
  → `{$secret}`); the http adapter merges resolved sink headers LAST, never echoed; end-to-end
  browser/integration proof (author a secret → reference it in a header → fire → the header is
  sent, never appears in the run log). Record the A10 marker-subsumption note in the connection
  schema comment.

S1 → S2 → S3 → S4. Source before sink; gate before resolution; resolution before consumer.

---

## Security model

- **Secrets live only as encrypted ciphertext at rest** (`secrets.ciphertext`, XChaCha20-Poly1305,
  master key resolved from env/keyfile, `secrets/secrets.ts`). No plaintext column, ever.
- **Plaintext exists only in two transient places:** the `POST /api/secrets` request body (encrypted
  immediately, never stored/returned/logged) and the dispatch-time side-channel arg to an adapter
  (never in `ctx`, `preparedInput`, or any event). Both mirror the existing connection-secret
  discipline.
- **A stored version and the event log hold only the `{$secret:name}` MARKER** — a pointer, not a
  secret. Safe to persist, export, diff, and log.
- **The name namespace is owner-scoped** (`UNIQUE(owner_id, name)`); a node cannot reference a
  connection's private credential (those rows have `name = NULL`).
- **`validateRefs` is a save-time gate, not the only defence** — dispatch resolution fails
  `permanent` on a missing/undecryptable secret, and the FK `onDelete: restrict` plus the
  soft-reference check on `DELETE` prevent dangling references.
- **Redaction (F4) closes the output/error echo path** — the only remaining way a resolved
  plaintext could reach the log — by extending the existing `redactSecrets`.
- **RBAC is out of scope** (v1 single-principal, `overview.md:118`); `ownerId` is the future-safe
  boundary only.

## Blast radius (when the slices build, not this PR)

- `shared`: `+schemas/secret-ref.ts`, `+SecretPublicSchema`; `catalog/types.ts` (+`secretSinkFields`);
  `engine/params.ts` (`validateRefs` marker walk); `catalog/registry.ts` (S4, http sink); `secrets`
  schema in `db/schema.ts` (server) + Drizzle migration.
- `server`: `+routes/secrets.ts`; `repo/secrets.ts` (create-by-name/list/delete + owner scope);
  `run/executor.ts` (dispatch resolution + codes); `connectors/types.ts` (+`secretFields?` arg);
  `connectors/http.ts` (sink consumer) + `connectors/redact.ts` (extend).
- `web`: a Secrets management surface is a UI-epic ticket (browser-verify gated), NOT item 7 —
  item 7 delivers the REST + engine; the UI epic renders it.
- Tests: `secrets` repo/route, `secret-ref` schema, `validateRefs` sink-gating (synthetic +
  http), executor dispatch resolution + redaction, http adapter sink.

## Non-goals

- `global_params` / secure globals (F7) — a later layer that resolves TO this store.
- The opaque-secret-handle target for secureOutput (D8) — MVP is prohibit-first (resolved-Q-2).
- Multi-secret-per-connection / secret-in-connection-config (A10 remainder) — deferred to the
  A11/A14 connectors that need it; resolved *mechanism* recorded (§5).
- `SecureString` run-scoped params (resolved-Q-1, deferred, own ticket).
- A Secrets management UI — the UI epic renders it.
- RBAC / multi-user secret permissions — a later spec.

## Evidence (probed, not argued)

- **No standalone secret source exists.** grep for `global_params`/`secret_store`: zero.
  `createSecret` call sites are `routes/connections.ts:53,99`, `routes/triggers.ts:216`, and tests
  only — never a standalone route. `secrets` table (`db/schema.ts:260-269`) has no `name`/`ownerId`.
- **`substitute` passes the marker through inert.** `params.ts:556-567` recurses into objects and
  returns non-`${}` strings as literals — `{$secret:"x"}` survives to dispatch unchanged.
- **`preparedInput` is not persisted; `node.dispatched` carries no input.** `executor.ts:305-311`.
- **The connection-secret side-channel + "never in `ctx`/events" invariant.** `connectors/
  types.ts:8-10,30-35`; decrypt at `executor.ts:158`; passed to `runActivity(ctx, secret)` at
  `executor.ts:187`.
- **`validateRefs` takes only the doc; the catalog is in shared.** `params.ts:808`;
  `catalog/registry.ts:80` (`getActivity`). No call-site signature change needed.
- **A10's split already exists.** `connection.ts:23-24,50` (non-secret `config` + stripped
  `secretRef`); the deferred multi-secret decision is flagged at `connection.ts:42-48`.
