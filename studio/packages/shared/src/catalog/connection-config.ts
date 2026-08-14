import { z } from 'zod';
import { MAX_RETRY_INTERVAL_SECONDS } from '../schemas/pipeline.js';
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
};

/** The connection-config schema for `kind`. Total over the kind enum. */
export function connectionConfigSchema(kind: ConnectionKind): z.ZodObject {
  return CONNECTION_CONFIG_SCHEMAS[kind];
}

/** Every kind, in the enum's own order — the form's kind picker reads this. */
export const CONNECTION_KINDS: readonly ConnectionKind[] = ConnectionKindSchema.options;
