import { z } from 'zod';
import { MAX_RETRY_INTERVAL_SECONDS } from '../schemas/pipeline.js';
import { formatZodIssues } from '../schemas/zod-issues.js';
import { ConnectionKindSchema, type ConnectionKind } from '../schemas/connection.js';
import { AGENT_TASK_ACTIVITY_TYPE, LLM_CALL_ACTIVITY_TYPE } from './types.js';

/**
 * #1087 (U13b) — the CONNECTION-level (non-secret) `config` shape for every
 * `ConnectionKind`. This is the SINGLE SOURCE OF TRUTH for what keys a
 * connection of each kind carries, read by TWO independent sites that would
 * otherwise drift: the server connector adapters (`connectors/*.ts`, whose
 * `configSchema` re-parses `config` at DISPATCH) and the Manage › Connections
 * form (`web/src/pages/ConnectionsPage.tsx`, which derives its per-kind
 * controls from these schemas rather than showing one raw JSON textarea).
 *
 * This is the same shared→server consolidation `fs-activity-config.ts` (#578)
 * did for the `file_*` ACTIVITY shapes, for the same reason: before it, each
 * schema was a module-private `const` in one adapter and the web knew nothing
 * about any of them.
 *
 * These are byte-identical to the shapes they replaced — a pure consolidation,
 * no validation-behaviour change — so `CATALOG_VERSION` is deliberately NOT
 * bumped, even though `schemas/version.ts` records earlier bumps (19, 20) for
 * genuine `agent_cli` config SHAPE changes.
 *
 * ONE deliberate exception, and it is the only place server and shared differ:
 * an `fs` root must be ABSOLUTE, which is `node:path`'s platform-aware
 * `isAbsolute` and cannot live in a browser-safe package. So this file owns the
 * fs SHAPE and `connectors/fs.ts` re-applies that one check by refining
 * `fsConnectionConfigSchema.shape.roots` — see the note there. The check is
 * invisible to the form either way: a `.refine()` is a CHECK, not a wrapper, so
 * it does not change how `deriveConfigFields` classifies the field.
 */

/** Default per-request timeout (ms) for an LLM call — bounds a hung provider. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** The non-secret Connection config common to every LLM adapter. */
export const llmConnectionConfigSchema = z.object({
  /** Provider base URL override (self-hosted / gateway / local). */
  baseUrl: z.string().optional(),
  /** Default model, used when the node's activity config sets none. */
  model: z.string().optional(),
  /** Per-request timeout in ms (whole exchange). Defaults to 120s. */
  timeoutMs: z.number().int().positive().optional(),
});

/** `anthropic_api`: the LLM shape plus the API version header. */
export const anthropicConnectionConfigSchema = llmConnectionConfigSchema.extend({
  /** The `anthropic-version` header value. Defaults to `2023-06-01`. */
  anthropicVersion: z.string().optional(),
});

/** The Connection-level (non-secret) config for an `http` connection. */
export const httpConnectionConfigSchema = z.object({
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Per-request timeout in ms (whole exchange). Defaults to 30s. */
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * The Connection-level (non-secret) config for an `fs` connection.
 *
 * `roots` carries its `.min(1)` here; the ABSOLUTE-path check on each element
 * lives in `connectors/fs.ts` (see this module's docblock) — a relative root
 * would resolve against the server's cwd (ambiguous + a traversal risk), so it
 * is a config error, but only the server can spell that check portably.
 */
export const fsConnectionConfigSchema = z.object({
  roots: z.array(z.string().min(1)).min(1, 'an fs connection needs at least one allowed root'),
  /** Per-read size cap in bytes. Defaults to 10 MiB. */
  maxBytes: z.number().int().positive().optional(),
  /** Per-`file_list` entry cap. Defaults to 10000. */
  maxEntries: z.number().int().positive().optional(),
});

/**
 * #1119 M4 — the Connection-level (non-secret) config for a `sqlite` STORE
 * connection (data-movement spec §2.6).
 *
 * `roots` is here, and §2.6's terse key list ("`path`, `readonly`") is not an
 * argument against it: the same row says the path is "confined by the same
 * `roots` allowlist model as `fs` — a SQLite file is a file, and an unconfined
 * path is the same traversal risk". `roots` IS that model. Reusing the key name
 * `fs` already uses is deliberate — the connections form carries same-named
 * fields across a kind change, so retyping an `fs` connection as `sqlite` keeps
 * the allowlist it was already confined to.
 *
 * `writable` rather than `readonly`, and the inversion is load-bearing on TWO
 * counts:
 *   - **It renders truthfully.** The authoring form seeds an absent boolean as
 *     `false` and omits the key when the box is unchecked (`configForm.ts`), so
 *     a `readonly` key defaulting `true` would display an UNCHECKED "readonly"
 *     box on a connection that genuinely is read-only — the form would state
 *     the opposite of the fact.
 *   - **It fails closed.** Absent means "not writable", so a store nobody
 *     declared writable cannot be written. That withholds a permission rather
 *     than manufacturing a fact — the same polarity `parameters: []` takes, and
 *     the opposite of the `.default([])` that #473 turned into data loss.
 *
 * It has NO effect on reading: the M4 reader opens read-only unconditionally
 * (there is no reason for a source scan to hold a write lock). `writable` is
 * what M5's copy SINK will consult before it opens the same file for writing.
 */
export const sqliteConnectionConfigSchema = z.object({
  roots: z.array(z.string().min(1)).min(1, 'a sqlite connection needs at least one allowed root'),
  /** The database file, confined to `roots` at dispatch by the SAME extracted
   * `resolveWithinRoots` guard the `fs` connector uses — not a second copy. */
  path: z.string().min(1),
  /** Whether this store may be used as a copy SINK (M5). Absent = read-only. */
  writable: z.boolean().optional(),
});

/** True iff `pattern` compiles as a `RegExp` (a boundary guard so a malformed
 * `quota.exhaustionPattern` is refused at config-save, never thrown at emit). */
function isCompilableRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `agent_cli` (subscription CLI) connection config.
 *
 * `MAX_RETRY_AFTER_SECONDS` was the server-side alias this schema used to read;
 * it is `MAX_RETRY_INTERVAL_SECONDS` (`schemas/pipeline.ts`), imported directly
 * here so shared never depends on a server re-export.
 */
export const agentConnectionConfigSchema = z.object({
  /** The executable to run (e.g. `claude`, `codex`). */
  command: z.string().min(1),
  /** Static leading args; the `task` is appended as the final argv element. */
  args: z.array(z.string()).optional(),
  /** Non-secret environment for the child. */
  env: z.record(z.string(), z.string()).optional(),
  /** The env var NAME the resolved secret is injected into (never in argv). */
  secretEnv: z.string().optional(),
  /** Default working directory; the activity `cwd` overrides it. */
  cwd: z.string().optional(),
  /**
   * #2 L14b — the default model this CLI connection reports for any metered
   * invocation (node `config.model` < this < the `cli` fallback). An `agent_task`
   * has no node-level leg — `agentTaskConfigSchema` declares no `model` — so for
   * that shape this IS the label (#797). Purely a metering LABEL:
   * an `unpriced` subscription call has no price to resolve, and the operator
   * configures any real `--model` flag statically via `args`; this only names
   * the model for observability/audit.
   */
  model: z.string().optional(),
  /** Hard wall-clock timeout (ms). Exceeding it tree-kills the process. */
  timeoutMs: z.number().int().positive().optional(),
  /** Combined stdout+stderr byte cap before output is truncated. */
  maxOutputBytes: z.number().int().positive().optional(),
  /**
   * #2 L14c — the subscription/quota reset-window hint. A subscription CLI's
   * usage quota resets on a rolling window; when a non-zero-exit's combined
   * stderr+stdout matches `exhaustionPattern`, the failure is a THROTTLE (quota
   * exhausted), NOT a permanent error. The adapter then emits `rate_limit`
   * (→ engine transient + `code:'rate_limit'`) carrying `resetWindowSeconds` as
   * the L7 `retryAfterSeconds`, so the EXISTING retry-alarm path arms a retry at
   * reset time instead of hot-looping a doomed subprocess — the reset window IS
   * the alarm's `dueAt`. Both fields required when present; a per-CLI hint because
   * exhaustion output is not standardised across CLIs (claude/codex differ).
   *
   * Applies to BOTH invocation shapes since #799 — `llm_call` and `agent_task`
   * alike. That is also what makes either shape able to ARM the persisted
   * per-connection window the admission gate reads.
   *
   * `resetWindowSeconds` is capped at the engine retry-alarm ceiling
   * (`MAX_RETRY_INTERVAL_SECONDS`, 24h): the L7 alarm cannot schedule further out, so
   * a > 24h window (e.g. a weekly quota) is REFUSED here at save-time rather than
   * silently clamped down (a clamp would fire the retry while still exhausted).
   * The persisted per-connection window + admission gate (#609) HAS since shipped
   * (`executor.ts`, the L14c pre-flight), so a > 24h window is no longer blocked
   * on a missing MECHANISM. It is blocked on TWO caps, and lifting this one alone
   * would not do it: the window reaches the persister solely via
   * `node.failed.retryAfterSeconds`, which the durable event schema caps at the
   * same 24h — the SAME `MAX_RETRY_INTERVAL_SECONDS` this cap reads, which is
   * why lifting one does nothing. (Before #1087 this file read the server-side
   * `MAX_RETRY_AFTER_SECONDS` alias; the two were always one constant.) Raising
   * only this one mints an event that fails validation at append. A weekly quota
   * needs a window carried independently of the L7 retry hint.
   */
  quota: z
    .object({
      /**
       * A regular expression (compiled with `new RegExp`, no implicit flags)
       * tested against the combined stderr+stdout of a non-zero exit. Validated
       * compilable at the boundary so the runtime match never throws. Matching is
       * CASE-SENSITIVE (no flags): bake any case-insensitivity into the pattern
       * itself (e.g. `[Uu]sage limit`) rather than relying on a flag.
       */
      exhaustionPattern: z.string().min(1).refine(isCompilableRegex, {
        message: 'exhaustionPattern must be a valid regular expression',
      }),
      /** Conservative reset window (whole seconds) to wait before a retry. */
      resetWindowSeconds: z.number().int().positive().max(MAX_RETRY_INTERVAL_SECONDS),
      /**
       * #816 — which INVOCATION SHAPES `exhaustionPattern` is classified on.
       * ABSENT = both, i.e. exactly the #799 behaviour, so this field changes
       * nothing on upgrade.
       *
       * It exists because the opt-in was per-CONNECTION and the two shapes carry
       * very different risk. On `llm_call` the matched stdout is a single
       * completion; on `agent_task` it is the agent's own transcript, so a
       * session that merely DISCUSSES a usage limit can trip the pattern — and
       * the resulting `rate_limit` both fails the node and arms a
       * CONNECTION-WIDE admission window. Before this field, the only way to
       * stop that was to unset `quota` entirely, which also disarmed the shape
       * the operator actually wanted classified.
       *
       * SCOPE, not immunity: this governs which shape may PRODUCE a quota
       * verdict, never which dispatches the resulting window GATES. The
       * executor's admission gate keys on the CONNECTION (`executor.ts`), so a
       * shape scoped out here is still refused dispatch while a window armed by
       * the other shape is live. That is deliberate and it is the fail-safe
       * reading: the window states that the underlying subscription account is
       * exhausted, which is true for every shape spending it — scoping only
       * declares which shape's output is trustworthy EVIDENCE of that.
       *
       * ABSENT = both is also the only safe DEFAULT: flipping it to `llm_call`
       * would silently re-open the #799 gap for every connection consumed solely
       * by `agent_task` nodes, which is the bug #799 existed to fix. The residue
       * of that choice, stated rather than sold as pure virtue: an existing
       * connection keeps the wide behaviour until an operator hand-edits it —
       * there is no migration and no version signal, because a Connection row is
       * mutable and unversioned (a PipelineVersion is not).
       *
       * EMPTY is REFUSED rather than honoured as "classify nothing". That reading
       * is legible, but it produces a `quota` block that looks armed and is not,
       * and the operator already has an unambiguous way to spell it: omit `quota`.
       * Note WHERE the refusal lands — this adapter `configSchema` is NOT run when
       * a Connection is saved (`routes/connections.ts` parses only the generic
       * write body); it is re-parsed at DISPATCH. So an empty array saves cleanly
       * and then fails every node bound to the connection, loudly and permanently,
       * exactly as an un-compilable `exhaustionPattern` already does. Loud-and-late
       * beats a guard that quietly does nothing, but it is late, not a save gate.
       */
      classifyActivityTypes: z
        .array(z.enum([LLM_CALL_ACTIVITY_TYPE, AGENT_TASK_ACTIVITY_TYPE]))
        .min(1, {
          message:
            'classifyActivityTypes must name at least one activity type (omit it to mean both)',
        })
        .optional(),
      /**
       * #816 — WHICH TEXT of a non-zero exit `exhaustionPattern` is matched
       * against. ABSENT = `text` = the combined stderr+stdout, i.e. exactly the
       * #799 behaviour, so this field changes nothing on upgrade.
       *
       * THREE formats, narrowest last:
       *
       * - `text` — the whole stderr+stdout join. The default, spelled explicitly.
       * - `stderr` — stderr ONLY. The cheapest real narrowing and the one that
       *   works on the DEFAULT invocation (`claude -p`, `codex exec`), because it
       *   needs no protocol from the CLI at all. #816 listed it first; what was
       *   refuted on evidence was the stdout-TAIL cut, never the CHANNEL cut. Its
       *   cost is stated plainly: a CLI whose only refusal channel is stdout is
       *   missed, which is why it is opt-in and not the default.
       * - `json-lines` — the CLI speaks a JSON-per-line protocol on stdout
       *   (`claude --output-format stream-json`, `codex … --json`). Studio never
       *   injects that flag — the operator owns `args` — so this is an ASSERTION
       *   about a command they configured. It also has a PRECONDITION worth
       *   knowing before choosing it: on such a connection `agent_task`'s success
       *   `outputs.output` is raw JSONL and the sentinel-fenced structured-output
       *   mode is incoherent, because neither is taught the protocol here (#830).
       *   On a plain `claude -p` connection, `stderr` is the format that applies.
       *
       * Under `json-lines` the match surface becomes: stderr IN FULL, plus, from
       * stdout, ONLY the decoded string values carried by envelopes whose
       * top-level `type` is a member of `errorEnvelopeTypes`. Agent content
       * (`assistant`/`item.*`/tool output) is excluded, which is #816's whole
       * point: on `agent_task` stdout is the agent's own transcript, so a session
       * that merely DISCUSSES a usage limit could produce a `rate_limit` verdict
       * that fails the run and arms a CONNECTION-WIDE admission window.
       *
       * This is the principle both in-repo agent adapters already follow —
       * `bin/agents/claude.sh` reads `rate_limit_event`, `bin/agents/codex.sh`
       * reads `error`/`turn.failed`/`stream_error`, and codex.sh states it
       * outright: "an error envelope is API/CLI output, never model content.
       * Agent CONTENT (item.* events) is never parsed."
       *
       * The residuals, ALL of them, stated rather than sold as pure virtue. Note
       * that every one of 2-6 fails in the EXPENSIVE direction — a real refusal
       * missed is #799's hot loop, which costs real money — so a `matchSource` is
       * a deliberate trade, not a free win:
       *
       * 1. NARROWED, NOT CLOSED. An agent that PRINTS a well-formed error
       *    envelope on raw stdout (a passthrough tool, an `echo`, a `cat` of
       *    codex.sh itself) forges one. The filter cuts the accidental mention,
       *    which is the archetype; it cannot cut a deliberate forgery.
       * 2. A stdout line that is not a declared envelope is DROPPED, so a CLI
       *    that breaks its own protocol to print a bare refusal on stdout is
       *    missed. stderr is never narrowed and is where such a break lands, and
       *    the alternative (admit unparseable lines) degrades to the old
       *    behaviour exactly on the transcripts this exists for — a truncated
       *    `maxOutputBytes` capture ends in an unparseable CHUNK OF CONTENT.
       * 3. A leaf nested deeper than `MAX_ENVELOPE_LEAF_DEPTH` is dropped.
       * 4. Only STRING leaves are matched. A refusal carried by a number or a
       *    boolean (`{"status":429}`, `"isUsingOverage":false`) is invisible, and
       *    a rule that is a CONJUNCTION over two fields is not expressible by one
       *    regex over a leaf join at all.
       * 5. Once `MAX_ENVELOPE_PARSE_CHARS` is exhausted the EARLIEST envelopes are
       *    dropped — at that point, and only there, this does degrade into the
       *    positional cut #816 refuted. Said plainly rather than papered over; the
       *    budget is sized so it bites orders of magnitude past a real stream.
       * 6. METERING follows the verdict. A refusal whose evidence this filter
       *    drops stays `kind:'permanent'`, so it is METERED (see the metering
       *    comment on `runAgentTask`), no retry fires, and the connection window
       *    is never armed — the same mislabel `classifyActivityTypes` documents.
       * 7. The top-level `type` VALUE is excluded from the matched text: it is
       *    the SELECTOR, not the evidence. Otherwise `errorEnvelopeTypes:
       *    ['rate_limit_event']` with a `rate.?limit` pattern would fire on
       *    claude's routine ALLOWED heartbeat, which carries that literal in the
       *    very field that selected it. Envelope KEYS are excluded for the same
       *    reason — only string LEAVES are matched — so a pattern sees `usage
       *    limit reached`, not `"type":"error"`, and needs no JSON escaping.
       *
       * WORKED EXAMPLE. codex: `{format:'json-lines', errorEnvelopeTypes:
       * ['error','turn.failed','stream_error']}`. There is deliberately NO claude
       * `rate_limit_event` example: `claude.sh` classifies on a CONJUNCTION —
       * `status == "rejected"` AND NOT `isUsingOverage` — and `isUsingOverage` is
       * a boolean, so residual 4 makes the second half unexpressible. A pattern
       * matching only `rejected` would classify an overage-SERVED request as
       * exhaustion. Whatever you declare, do NOT add claude's `result` type —
       * `result.result` IS the model's final message, which re-opens the hole this
       * field closes.
       *
       * SCOPED TO QUOTA MATCHING ON PURPOSE. It is named for what it governs and
       * lives where it is honoured. A connection-level `outputFormat` would be a
       * broader promise than this delivers: `agent_task`'s success `outputs` and
       * the sentinel-fenced structured-output mode also read this stdout and are
       * NOT taught the protocol here (#830).
       *
       * Applies to both shapes uniformly. A `json-lines` connection's `llm_call`
       * completion is raw JSONL rather than prose, so declaring it effectively
       * declares an agent-shaped connection — but the filter is not special-cased
       * by shape, because a per-shape carve-out is what `classifyActivityTypes`
       * already is and two overlapping scopes would be a worse contract.
       */
      matchSource: z
        .discriminatedUnion('format', [
          z.object({ format: z.literal('text') }).strict(),
          z.object({ format: z.literal('stderr') }).strict(),
          z
            .object({
              format: z.literal('json-lines'),
              // Bounded because the pre-filter walks EVERY stdout line once per
              // declared type before any budget applies, so an unbounded list (or
              // an unbounded member) is a config-authored multiplier on a 10 MB
              // transcript. The ceilings are far past any real CLI's protocol.
              errorEnvelopeTypes: z
                .array(z.string().min(1).max(200))
                .min(1, {
                  message:
                    'errorEnvelopeTypes must name at least one envelope type (a json-lines source with no declared error envelope can never classify)',
                })
                .max(32),
            })
            .strict(),
        ])
        .optional(),
    })
    .optional(),
});

/**
 * Every kind's connection-config schema, keyed by kind.
 *
 * Typed `Record<ConnectionKind, …>` on purpose: adding a kind to
 * `ConnectionKindSchema` without giving it a config schema is then a TYPE
 * ERROR, not a form that silently renders nothing for the new kind.
 */
export const CONNECTION_CONFIG_SCHEMAS: Record<ConnectionKind, z.ZodObject> = {
  anthropic_api: anthropicConnectionConfigSchema,
  openai_api: llmConnectionConfigSchema,
  ollama: llmConnectionConfigSchema,
  agent_cli: agentConnectionConfigSchema,
  http: httpConnectionConfigSchema,
  fs: fsConnectionConfigSchema,
  sqlite: sqliteConnectionConfigSchema,
};

/**
 * What each kind DOES with a connection-level secret, in the operator's words.
 *
 * Whether a secret is REQUIRED is not spelt here — that is
 * `connectionKindRequiresSecret` (`schemas/connection.ts`), the G8a readiness
 * SSOT, and this map must never restate it. What this adds is the other half
 * the form could otherwise only guess at: a kind that requires no secret is not
 * automatically a kind that IGNORES one. `agent_cli` injects it into the env var
 * named by `config.secretEnv` (`connectors/agent.ts`) and `http` sends it as an
 * `Authorization: Bearer` header (`connectors/http.ts`), so telling an operator
 * either kind has no use for a secret would be false.
 *
 * Lives beside the schemas so a change in what an adapter does with its secret
 * has ONE place to be reflected, next to the shape it is described against.
 */
export const CONNECTION_SECRET_USE: Record<ConnectionKind, string> = {
  anthropic_api: 'Sent as the `x-api-key` header on every call.',
  openai_api: 'Sent as the `Authorization: Bearer` header on every call.',
  ollama: 'Not used by this kind — a local Ollama server takes no credential.',
  agent_cli: 'Injected into the environment variable named by `secretEnv`, never into argv.',
  http: 'Sent as an `Authorization: Bearer` header, under any header the request sets itself.',
  fs: 'Not used by this kind — an fs connection is credential-less; `roots` is its guard.',
  sqlite: 'Not used by this kind — a local SQLite file takes no credential; `roots` is its guard.',
};

/**
 * #1119 M4 — the connection kinds whose `config.roots` is a PATH-CONFINEMENT
 * ALLOWLIST rather than ordinary settings.
 *
 * Named once because two things key off it: this module's advisory (a relative
 * root is a config error the form can say before dispatch), and
 * `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS` below, which is what stops the
 * allowlist being rewritten by the thing it confines.
 */
export const ROOT_CONFINED_CONNECTION_KINDS: ReadonlySet<ConnectionKind> = new Set<ConnectionKind>([
  'fs',
  'sqlite',
]);

/**
 * #1119 M4 — config keys a node may NEVER override per dispatch, whatever the
 * connection's `parameters` allowlist says.
 *
 * `Connection.parameters` (#2 L13b) lets an owner declare which config keys a
 * node may set per dispatch, and the executor merges the resolved values over
 * the stored config. That is right for a model name or a base URL. It is NOT
 * right for a SECURITY BOUNDARY: `fs`'s adapter docblock states its own trust
 * model as "the connection `config.roots` is ADMIN-authored, server-side, never
 * pipeline-supplied", and an allowlist the confined party can rewrite is not an
 * allowlist. With `roots` overridable, a node could dispatch `roots: ['/']` and
 * confine itself to the entire filesystem; with `path` overridable, a `sqlite`
 * node could repoint the whole store.
 *
 * The hole is PRE-EXISTING for `fs` — M4 closes it rather than inheriting it,
 * because `sqlite`'s confinement rests on exactly the same field. It is an
 * exhaustive `Record`, so a kind added without a decision is a compile error;
 * `[]` is the honest answer for every kind whose config carries no boundary.
 *
 * Enforced at the MERGE (`run/executor.ts`), not only at the allowlist write
 * path, because a row authored before this rule existed could already carry one
 * of these keys — a gate that only guards new writes would not gate those.
 */
export const CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS: Record<ConnectionKind, readonly string[]> = {
  anthropic_api: [],
  openai_api: [],
  ollama: [],
  agent_cli: [],
  http: [],
  fs: ['roots'],
  // `writable` joins the two path keys even though NOTHING consumes it yet (the
  // M4 reader opens read-only unconditionally). It is a PERMISSION, not a
  // setting: once M5's copy sink reads it, an overridable `writable` would let a
  // node grant itself write access to a store its owner marked read-only. Closing
  // it now costs one entry and cannot break a consumer that does not exist;
  // closing it after M5 would mean closing it after it was reachable.
  sqlite: ['roots', 'path', 'writable'],
};

/** Whether `key` is a security-boundary config key that no per-dispatch
 * override may set for `kind` (the `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`
 * predicate — never a bare string comparison at a call site). */
export function isNonOverridableConnectionConfigKey(kind: ConnectionKind, key: string): boolean {
  return CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS[kind].includes(key);
}

/**
 * Advisory-only: does this look like an absolute path?
 *
 * NOT the authority — `connectors/fs.ts` runs `node:path`'s platform-aware
 * `isAbsolute` and that is what actually refuses a dispatch. This exists so the
 * authoring form can WARN about a relative root, which the shared schema
 * deliberately cannot (see this module's docblock).
 *
 * Deliberately PERMISSIVE: it accepts a Windows drive prefix as well as a
 * POSIX leading slash, so it never warns about a path the server would accept.
 * An advisory that cries wolf is worse than one that occasionally stays quiet —
 * the server check is still there either way.
 */
export function looksAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * What a kind's own rules say about a config, as ONE operator-facing string —
 * or `null` when there is nothing to say.
 *
 * Advisory, never a gate: `routes/connections.ts` runs no per-kind validation,
 * so every shape this reports is one the server stores TODAY. It exists so the
 * authoring form can say it BEFORE dispatch rather than after.
 *
 * Lives here rather than in the form because it is the schema's own knowledge,
 * and because the `fs` clause below is the OTHER HALF of the divergence this
 * module documents: the shared schema cannot carry the absolute-root check, so
 * without this the one path-safety-relevant key in the whole catalog would be
 * the only one the form said nothing about.
 */
export function connectionConfigAdvisory(
  kind: ConnectionKind,
  config: Record<string, unknown>,
): string | null {
  const notes: string[] = [];

  const parsed = CONNECTION_CONFIG_SCHEMAS[kind].safeParse(config);
  if (!parsed.success) notes.push(formatZodIssues(parsed.error.issues));

  if (ROOT_CONFINED_CONNECTION_KINDS.has(kind) && Array.isArray(config.roots)) {
    const relative = config.roots.filter(
      (root): root is string => typeof root === 'string' && !looksAbsolutePath(root),
    );
    if (relative.length > 0) {
      notes.push(`roots: every ${kind} root must be an absolute path (${relative.join(', ')})`);
    }
  }

  // A sqlite `path` is resolved against the first root when it is relative, so a
  // relative path is legal — but it is very often a mistake, and the server-side
  // guard is the only thing that would say so, at dispatch. Advisory, as the
  // whole function is.
  if (kind === 'sqlite' && typeof config.path === 'string' && !looksAbsolutePath(config.path)) {
    notes.push(`path: '${config.path}' is relative, so it resolves against the first allowed root`);
  }

  return notes.length === 0 ? null : notes.join('; ');
}

/** The connection-config schema for `kind`. Total over the kind enum. */
export function connectionConfigSchema(kind: ConnectionKind): z.ZodObject {
  return CONNECTION_CONFIG_SCHEMAS[kind];
}

/** Every kind, in the enum's own order — the form's kind picker reads this. */
export const CONNECTION_KINDS: readonly ConnectionKind[] = ConnectionKindSchema.options;
