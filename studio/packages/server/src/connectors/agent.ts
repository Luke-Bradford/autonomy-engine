import { z } from 'zod';
import {
  AGENT_CLI_CONNECTION_KIND,
  AGENT_TASK_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  agentTaskConfigSchema,
  agentStructuredInstruction,
  extractStructuredBlock,
  parseAndValidateStructured,
} from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import type { Supervisor, SupervisedResult } from '../workers/process-supervisor.js';
import {
  MAX_RETRY_AFTER_SECONDS,
  coerceStopReason,
  llmCallConfigSchema,
  normalizeLlmRequest,
  resolveModel,
} from './llm-shared.js';
import type { NormalizedLlmRequest } from './llm-shared.js';
import { redactSecrets } from './redact.js';
import { sha256Hex } from '../util/hash.js';
// The harness's own secret-bearing env vars — stripped from every spawned
// child (see the export's doc in `secrets/secrets.ts`; hoisted there so this
// list has ONE source across all child-process spawners, #3 G2).
import { MASTER_KEY_ENV_VARS } from '../secrets/secrets.js';

/**
 * The `agent_cli` connector adapter: runs an agent CLI (Claude Code, Codex, or
 * any command) as a supervised subprocess via the per-app `Supervisor` (the
 * `createSupervisor()` instance the host injects, whose `reapAllSupervised()` is
 * wired into graceful shutdown).
 *
 * ONE adapter, TWO invocation shapes (selected by `ctx.activityType`, the same
 * multi-activity seam the `fs` connector uses for `file_read`/`file_write`):
 * - `agent_task` — the agentic subprocess: `task` in, stdout + `exitCode` out,
 *   exit code is DATA the pipeline branches on (see OUTCOME MAPPING below).
 * - `llm_call` (#2 L14b) — a CLI/subscription SINGLE-SHOT (`claude -p`/
 *   `codex exec` → stdout): the `llm_call` config's prompt is folded into one
 *   string, appended as the final argv element, and the process stdout is the
 *   `text` completion. A non-zero exit is a `permanent` failure here (unlike
 *   `agent_task`): the LLM shape's contract is a completion, and an opaque CLI
 *   error is not something to hot-loop a retry on.
 *
 * BOTH shapes meter (#797), on success AND on the failure paths — a subprocess
 * that RAN burned the subscription's quota either way. The fact is `unpriced`
 * with no tokens; `cliSpendFact` below carries the full argument, and each call
 * site states the exclusions it applies (they differ, deliberately — see #799).
 *
 * The `agent_task` activity supplies the `task`
 * (and an optional `cwd`); the Connection's non-secret `config` supplies the
 * `command`, static `args`, non-secret `env`, an optional `cwd`, and — per the
 * secret discipline — the NAME of the env var (`secretEnv`) the resolved secret
 * is injected into. The secret (e.g. an `ANTHROPIC_API_KEY`) rides `secretRef`
 * and is placed ONLY in the child's environment, never in argv (which could be
 * logged) or the non-secret `config`. So the "config is non-secret for every
 * kind" assumption holds for `agent_cli` too. The child inherits the server's
 * environment (execa `extendEnv`), so — defense in depth — the harness's OWN
 * secrets master-key vars are stripped from it: an arbitrary agent binary must
 * never see the key that decrypts every connection secret. The run is bounded by
 * a default wall-clock timeout so a hung agent cannot permanently hold a shared
 * worker-pool slot.
 *
 * OUTCOME MAPPING (deliberate, mirroring the `http` adapter's "status is data"):
 * a subprocess that COMPLETES on its own — any exit code — is `succeeded{ output,
 * exitCode }`, so a pipeline can branch on `${nodes.x.output.exitCode}` and its
 * success/failure edges. ONE opt-in carve-out (#2 L14c / #799): when the
 * connection declares `quota.exhaustionPattern` and a non-zero exit MATCHES it,
 * the outcome is a `rate_limit` failure instead — the service refused to run the
 * agent, so there is no agent verdict to brand as data. Otherwise, only a failure
 * to complete is a `failed` event:
 * `cancelled` when the run's signal aborted OR the supervisor reaped the tree on
 * shutdown; `transient` on a timeout or an external kill signal (a retry
 * candidate); `permanent` when the process never started (a bad `command`, so a
 * `null` exit with no signal and no supervisor kill). Non-idempotent by catalog
 * definition: a crash mid-flight FREEZES the run (`interrupted`) rather than
 * risk re-running arbitrary side effects, and an `agent_cli` subprocess does not
 * survive a server restart (documented in the process-supervisor contract).
 */

/**
 * Default wall-clock bound (30 min) so a hung agent never permanently holds a
 * worker-pool slot. Agent runs are long, hence generous; overridable per
 * connection via `config.timeoutMs`.
 */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60_000;

const agentConnectionConfigSchema = z.object({
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
   * (`MAX_RETRY_AFTER_SECONDS`, 24h): the L7 alarm cannot schedule further out, so
   * a > 24h window (e.g. a weekly quota) is REFUSED here at save-time rather than
   * silently clamped down (a clamp would fire the retry while still exhausted).
   * The persisted per-connection window + admission gate (#609) HAS since shipped
   * (`executor.ts`, the L14c pre-flight), so a > 24h window is no longer blocked
   * on a missing MECHANISM. It is blocked on TWO caps, and lifting this one alone
   * would not do it: the window reaches the persister solely via
   * `node.failed.retryAfterSeconds`, which the durable event schema caps at the
   * same 24h (`MAX_RETRY_INTERVAL_SECONDS`, of which `MAX_RETRY_AFTER_SECONDS`
   * here is an alias). Raising only this one mints an event that fails validation
   * at append. A weekly quota needs a window carried independently of the L7
   * retry hint.
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
      resetWindowSeconds: z.number().int().positive().max(MAX_RETRY_AFTER_SECONDS),
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
       * EMPTY is refused rather than honoured: it is an oblique spelling of
       * "delete the quota block" that silently disarms the hot-loop guard on
       * both shapes, and a config whose intent cannot be read should not run.
       */
      classifyShapes: z
        .array(z.enum([LLM_CALL_ACTIVITY_TYPE, AGENT_TASK_ACTIVITY_TYPE]))
        .min(1, { message: 'classifyShapes must name at least one shape (omit it to mean both)' })
        .optional(),
    })
    .optional(),
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

type AgentConnectionConfig = z.infer<typeof agentConnectionConfigSchema>;

/** The `provider` field on an `agent_cli` metering fact (BOTH invocation shapes
 * since #797) — the Connection kind, per the `activity.metered` contract.
 * Derived from the shared kind constant so the metering label cannot drift from
 * the adapter's `kind`. */
const AGENT_CLI_PROVIDER: string = AGENT_CLI_CONNECTION_KIND;

/** The metering model LABEL when neither the node nor the connection names one.
 * An `unpriced` call has no price to resolve, so this is descriptive only. */
const CLI_MODEL_FALLBACK = 'cli';

/**
 * #2 L14 / #797 — the metering FACT for one `agent_cli` invocation: `unpriced`
 * with NO token counts, because a subscription CLI has no per-response dollar
 * price BY DESIGN and reports no usage. `run-cost` folds it into the `unpriced`
 * bucket, which (unlike `unknown`) never flips a run's cost to INCOMPLETE.
 *
 * Emitted for a subprocess that RAN, whether or not it produced a completion —
 * a tree-killed CLI burned the subscription's quota just the same, and that is
 * the only spend signal there is on this transport. The two call sites do NOT
 * apply an identical predicate — `llm_call` also excludes a quota refusal and
 * `agent_task` does not, because single-shot and multi-turn-session refusals are
 * opposite evidence about whether spend occurred (#799 restated this asymmetry on
 * its real cause; see each site).
 *
 * The rule deliberately DIVERGES from the HTTP adapters' (#725 `spendFact`),
 * which leave a timeout unmarked because a timeout cannot distinguish a slow
 * generation from a dropped SYN. Two things differ here and both point the same
 * way: (1) their fact would be `costUnknown`, which flips a run permanently
 * INCOMPLETE, so over-marking is expensive — ours is `unpriced`, so over-marking
 * costs one extra `responseCount` and nothing else; (2) a SPAWNED process is at
 * least SOME evidence the call was issued, which `llmPost` has no per-request
 * channel to establish at all. Leg (2) is deliberately weak and (1) carries the
 * design on its own: a spawn proves a PROCESS started, not that a request
 * reached the provider — a CLI that hangs on DNS and is killed at the ceiling
 * burned nothing. Note the
 * evidence is the SPAWN, not stdout: a single-shot CLI flushes its completion at
 * the END, so gating on stdout would miss precisely the longest, most expensive
 * run — the one killed at the ceiling.
 *
 * The `responseCount` this feeds is per INVOCATION, not per provider response:
 * one `agent_task` drives an agent that may make many model calls internally and
 * the CLI reports none of them, so the number is a floor, not a census.
 */
function cliSpendFact(model: string): Extract<ActivityEvent, { type: 'metered' }> {
  return {
    type: 'metered',
    usage: { provider: AGENT_CLI_PROVIDER, model, meteringStatus: 'unpriced' },
  };
}

/** Bound on the CLI diagnostic excerpt folded into a non-zero-exit failure
 * message, so a verbose CLI cannot bloat the durable `node.failed` event. Over
 * the cap, the head and tail (half each) are kept with a middle elision.
 *
 * Named for the DIAGNOSTIC, not for stderr (#799): it bounds the COMBINED
 * stderr+stdout text, so the old `MAX_STDERR_DETAIL_CHARS` spelling named the
 * wrong half of what it measures. (Plain accuracy — it was never referenced from
 * `runAgentTask`, so it played no part in the gap #799 fixed.) */
const MAX_CLI_DIAGNOSTIC_CHARS = 1000;

/**
 * The cap on how much diagnostic text the operator's `quota.exhaustionPattern`
 * is matched against. Deliberately MUCH larger than the persisted excerpt: this
 * is an availability bound, not the evidence bound.
 *
 * Why it exists (#799 review): on `llm_call` the matched text is a single
 * completion, but on `agent_task` it is the whole transcript, up to the
 * connection's `maxOutputBytes` (10 MB by default), and the match is a
 * SYNCHRONOUS `RegExp.test` on the server's only thread. Scanning megabytes per
 * failed node is an event-loop stall the `llm_call` shape never had.
 *
 * Be honest about what this does and does not buy. It bounds the INPUT, so it
 * bounds the cost of a well-behaved pattern and of polynomial backtracking. It
 * does NOT make a catastrophically-backtracking pattern safe — `(a+)+$` blows up
 * on a few dozen characters, so no input cap saves it. That residual risk is
 * bounded elsewhere, by the pattern being operator-authored rather than
 * agent-influenced; it is the TEXT that grew by orders of magnitude here, and
 * the text is what this caps.
 *
 * 64k chars ≈ 160× smaller than the default transcript ceiling while staying far
 * wider than any real CLI refusal. The head keeps stderr (which leads the joined
 * diagnostic) and the tail keeps the end of stdout, where a CLI that exits
 * non-zero prints the reason it is exiting.
 *
 * This is a SIZE bound only. WHICH CHANNELS/POSITIONS `agent_task` should match —
 * stderr only, or stderr plus a stdout tail — still stands with #816: the tail
 * narrowing was tried and refuted on in-repo evidence (see `diagnoseCliExit`),
 * and the SHAPE scope that DID ship is `quota.classifyShapes`, not a channel cut. */
const MAX_CLI_MATCH_CHARS = 64_000;

/**
 * `text` bounded to `cap` characters, keeping BOTH ends with a middle elision.
 *
 * Head + tail rather than either alone because a CLI may print the real error
 * EARLY (then trail off in progress noise) OR summarise it at the END, so
 * preserving only one end can bury the signal.
 *
 * The elision marker is load-bearing, not decoration: splicing the head directly
 * onto the tail could FORGE a match across the seam (`…usage li` + `mit
 * reached…`), inventing a quota refusal out of two unrelated fragments. */
function headTailExcerpt(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

/** The validated `quota` block of an `agent_cli` connection config. */
type AgentQuotaHint = NonNullable<AgentConnectionConfig['quota']>;

/** The two invocation shapes this adapter serves. A closed union rather than a
 * bare `string` so the label a failure is built with cannot drift from the one
 * `classifyCliOutcome` was given. */
type CliShapeLabel = 'llm_call' | 'agent_task';

/** The terminal half of a `classifyCliOutcome` result: either a ready-made
 * `failed` event, or the exit code of a subprocess that completed on its own. */
type CliTerminal = CliClassification['terminal'];

/**
 * #2 L14c — the combined stderr+stdout diagnostic for a COMPLETED non-zero exit,
 * plus the quota verdict computed from it. Shared by BOTH invocation shapes
 * (#799) so they cannot drift: before #799 only `llm_call` did this, inline,
 * which is precisely why `agent_task` could never classify a quota refusal.
 *
 * stderr first (the conventional error channel), then stdout — some CLIs (e.g.
 * `codex exec`) print their error to STDOUT, so a failure is never a bare
 * "exited N" with no context. Matched PRE-redaction, for detection accuracy.
 *
 * A COMPLETED NON-ZERO EXIT is the only outcome that carries a verdict, and that
 * is a CORRECTNESS rule, not an optimization: a clean (exit 0) run whose
 * transcript merely discusses rate limits is not a refusal, and neither is a CLI
 * that printed its refusal and then hung until the wall-clock kill (that one is a
 * timeout, and is deliberately still metered). Returning `''` early also happens
 * to spare the success path a join it would never read, but do not re-derive the
 * gate from that: the laziness is the by-product, the rule is the point.
 *
 * FALSE-POSITIVE SURFACE, stated where the matching lives: on `llm_call` the
 * stdout half is a single completion, but on `agent_task` it is the agent's own
 * transcript — tool output, file contents it printed, its own prose. So a
 * non-zero exit whose transcript merely MENTIONS the pattern both fails the node
 * and arms a connection-wide window that admission-gates every other run bound to
 * that connection until it elapses. A self-referential agent (one reading logs
 * that discuss quota) is a plausible trip.
 *
 * TWO bounds apply, and neither is the CHANNEL question:
 *  - SIZE: the pattern is tested against a `MAX_CLI_MATCH_CHARS` excerpt, not the
 *    whole (up to `maxOutputBytes`, 10 MB) transcript, because the `test` is
 *    synchronous and scanning megabytes on the server's only thread is an
 *    event-loop stall. Note what this ALSO buys: the transcript's mid-body — the
 *    intuitive home of a false positive — is already outside the matched window.
 *  - SHAPE: `quota.classifyShapes` (#816) lets an operator declare which shapes
 *    may produce a verdict at all, so `agent_task` can be scoped out without
 *    disarming `llm_call` on the same connection.
 *
 * WHICH CHANNELS/POSITIONS `agent_task` should match REMAINS OPEN (#816), and the
 * tempting narrowing was investigated and REJECTED on evidence rather than left
 * unexamined. Matching only a stdout TAIL looks safe — "a CLI that dies of quota
 * prints the reason last" — but `bin/agents/claude.sh` (this repo's only reader of
 * a real agent CLI) classifies a Claude Code limit from a MID-STREAM
 * `rate_limit_event`, and scans for the LAST of several, explicitly handling a
 * session that continues and even succeeds after one. Under `--output-format
 * stream-json` the refusal can therefore sit arbitrarily far from the end, behind
 * fallback turns and teardown. A tail cut would miss it and reopen #799's
 * hot-loop, while leaving the likelier false positive (the agent's closing summary
 * "I stopped: usage limit reached") untouched — worse on both axes.
 *
 * The pattern is boundary-validated compilable by `agentConnectionConfigSchema`
 * (re-parsed on every dispatch), so `new RegExp` here cannot throw.
 */
function diagnoseCliExit(
  quota: AgentQuotaHint | undefined,
  shape: CliShapeLabel,
  terminal: CliTerminal,
  stderr: readonly string[],
  stdout: readonly string[],
): { diagnostic: string; quotaHit: AgentQuotaHint | undefined } {
  if ('failed' in terminal || terminal.exitCode === 0)
    return { diagnostic: '', quotaHit: undefined };
  const diagnostic = [stderr.join('\n'), stdout.join('\n')]
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n');
  // #816 — the SHAPE gate, evaluated before the excerpt and the regex (both are
  // pure waste once the verdict is scoped out). ABSENT `classifyShapes` = both
  // shapes, so an untouched config behaves exactly as it did under #799. Note
  // the `diagnostic` is still built and returned: scoping decides whether a
  // failure carries a QUOTA VERDICT, never what a failure is allowed to SAY.
  if (quota === undefined || !(quota.classifyShapes ?? [shape]).includes(shape))
    return { diagnostic, quotaHit: undefined };
  // Match against a BOUNDED excerpt (`MAX_CLI_MATCH_CHARS`) — an `agent_task`
  // transcript can be megabytes and this `test` is synchronous. The FULL
  // `diagnostic` is still returned: the excerpt bounds what the pattern scans,
  // not what the failure event reports.
  const quotaHit = new RegExp(quota.exhaustionPattern).test(
    headTailExcerpt(diagnostic, MAX_CLI_MATCH_CHARS),
  )
    ? quota
    : undefined;
  return { diagnostic, quotaHit };
}

/**
 * The redacted, length-bounded excerpt of a CLI diagnostic, safe to fold into a
 * durable `node.failed` event. Shared by both shapes (#799).
 *
 * REDACT the resolved secret out of that text BEFORE it lands in the event — a
 * CLI commonly echoes the injected key in an auth/quota error, and this string
 * is persisted to `run_events` and served over the API. Redact the FULL text
 * first, THEN truncate, so a secret straddling the truncation boundary is still
 * fully scrubbed. Same never-leak discipline every sibling adapter upholds
 * (http/llm-shared → `redactSecrets`).
 *
 * Bounding is `headTailExcerpt` (which keeps both ends, for the reason stated
 * there). The ORDER is what is specific to this function: redact first, bound
 * second.
 */
function cliFailureDetail(diagnostic: string, secret: string | null): string {
  return headTailExcerpt(redactSecrets(diagnostic, [secret]), MAX_CLI_DIAGNOSTIC_CHARS);
}

/**
 * #2 L14c — the `rate_limit` terminal for a subscription-quota refusal, built
 * identically for both invocation shapes (#799), so the message FORMAT cannot
 * drift between them; `label` names the shape (mirroring `classifyCliOutcome`'s
 * `label`, and closed to the same union so the two cannot disagree on spelling).
 *
 * A quota exhaustion is a THROTTLE, not a permanent error: `rate_limit` maps to
 * an engine transient + `code:'rate_limit'` and carries the reset window as the
 * L7 `retryAfterSeconds`, so the existing retry-alarm path waits the window out
 * instead of hot-looping a doomed subprocess.
 *
 * NOTE: whether an alarm actually ARMS is the reducer's call — a transient
 * failure only schedules a retry when the node carries a `policy.retry` budget.
 * With no retry policy the node settles to a plain terminal failure (merely
 * tagged `code:'rate_limit'`). Persisting the connection's quota WINDOW does not
 * depend on that: the driver's writer runs on every fold, unconditioned by the
 * reducer's retry decision, so an un-retried refusal still arms the admission
 * gate for every later dispatch on that connection.
 */
function quotaRefusedFailure(
  label: CliShapeLabel,
  exitCode: number,
  detail: string,
  quotaHit: AgentQuotaHint,
): Extract<ActivityEvent, { type: 'failed' }> {
  return {
    type: 'failed',
    kind: 'rate_limit',
    error: `${label} CLI exited ${exitCode} (quota exhausted)${detail !== '' ? `: ${detail}` : ''}`,
    retryAfterSeconds: quotaHit.resetWindowSeconds,
  };
}

/**
 * #2 L14b — flatten a normalized `llm_call` request into the SINGLE prompt string
 * a CLI single-shot (`claude -p <prompt>`) takes. A lone user turn with no system
 * reduces to its raw content (the common Generate shape); anything richer folds
 * to a role-labelled transcript with the system prompt first, so a multi-turn
 * conversation reaches the CLI unambiguously. Pure + exported for direct tests.
 */
export function renderCliPrompt(req: NormalizedLlmRequest): string {
  // The production caller (a `safeParse`d config) always has ≥1 non-system
  // message, but this is exported — stay defensive for a direct caller rather
  // than index into an empty array.
  if (req.messages.length === 0) return req.system ?? '';
  const body =
    req.messages.length === 1 && req.messages[0]!.role === 'user'
      ? req.messages[0]!.content
      : req.messages
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
  return req.system !== undefined ? `${req.system}\n\n${body}` : body;
}

/**
 * Spawn the CLI single-shot (shared by both invocation shapes) and collect its
 * output. `finalArg` (the `task` or the folded prompt) is the LAST argv element,
 * never a place a secret rides — the secret goes ONLY into the child env, and the
 * harness master-key vars are stripped (defense in depth: an arbitrary agent
 * binary must never see the key that decrypts every connection secret). stdout
 * and stderr are each collected line-by-line (bounded by the supervisor's byte
 * budget); the supervisor closes the stream once the child exits, so the drain
 * terminates and is `await`ed rather than raced.
 */
async function spawnAndCollect(
  supervisor: Supervisor,
  config: AgentConnectionConfig,
  finalArg: string,
  cwd: string | undefined,
  secret: string | null,
  signal: AbortSignal,
): Promise<{ result: SupervisedResult; stdout: string[]; stderr: string[] }> {
  const env: Record<string, string | undefined> = { ...(config.env ?? {}) };
  // The secret (if any) is injected ONLY into the child env, never argv.
  if (secret !== null && config.secretEnv !== undefined) {
    env[config.secretEnv] = secret;
  }
  // Defense-in-depth: STRIP the harness's own secrets master-key vars from the
  // child (`undefined` unsets an inherited var). These win over any operator
  // `config.env` collision — correct, since no agent needs the harness key.
  for (const masterKeyVar of MASTER_KEY_ENV_VARS) env[masterKeyVar] = undefined;

  const proc = supervisor.spawnSupervised({
    command: config.command,
    args: [...(config.args ?? []), finalArg],
    cwd,
    env,
    // A default upper bound so a hung agent can never PERMANENTLY hold a shared
    // worker-pool slot; generous, since agent runs are long. Per-connection
    // overridable via `config.timeoutMs`.
    timeoutMs: config.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes,
    signal,
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const collect = (async () => {
    for await (const ev of proc.events) {
      if (ev.stream === 'stdout') stdout.push(ev.line);
      else stderr.push(ev.line);
    }
  })();
  const result = await proc.result;
  await collect;
  return { result, stdout, stderr };
}

/**
 * The single classification of a subprocess RESULT, shared by BOTH invocation
 * shapes AND the L11a telemetry. `summary` is the outcome class; `terminal` is a
 * discriminated union (a `failed` event for the not-completed outcomes, or a
 * completed `exitCode` so the caller's exit-code narrowing is type-checked).
 * Deriving both from ONE partition is deliberate: `summary` and the terminal it
 * accompanies CANNOT disagree.
 */
interface CliClassification {
  /**
   * The L11a `summary`. `completed` ⟺ `terminal.exitCode` present; the rest ⟺
   * `terminal.failed`. The precedence below is load-bearing: the supervisor sets
   * `killed:true` ALONGSIDE `timedOut`/`aborted` (a tree-kill is how it enforces
   * a timeout / cancel), so `killed` must be checked AFTER the more specific
   * `aborted`/`timedOut`, else every timeout/cancel misclassifies as `killed`.
   */
  summary: 'completed' | 'timedOut' | 'aborted' | 'killed' | 'signalled' | 'spawnFailed';
  /** The exit code, VERBATIM from the result (`null` on any non-completion). */
  exitCode: number | null;
  /** The terminating signal, VERBATIM from the result (`null` if none). */
  signal: NodeJS.Signals | null;
  terminal: { failed: Extract<ActivityEvent, { type: 'failed' }> } | { exitCode: number };
}

/**
 * Classify a subprocess RESULT (see `CliClassification`). The not-completed
 * outcomes BOTH invocation shapes map identically — abort/timeout/shutdown-reap/
 * spawn-failure/external-signal. The run's own cancel wins over a coincident
 * timeout, and both win over the `killed` superset flag (see the precedence note).
 */
function classifyCliOutcome(
  result: SupervisedResult,
  command: string,
  label: CliShapeLabel,
): CliClassification {
  const base = { exitCode: result.exitCode, signal: result.signal };
  if (result.aborted)
    return {
      ...base,
      summary: 'aborted',
      terminal: { failed: { type: 'failed', kind: 'cancelled', error: `${label} aborted` } },
    };
  if (result.timedOut)
    return {
      ...base,
      summary: 'timedOut',
      terminal: { failed: { type: 'failed', kind: 'transient', error: `${label} timed out` } },
    };
  if (result.killed)
    return {
      ...base,
      summary: 'killed',
      terminal: {
        failed: { type: 'failed', kind: 'cancelled', error: `${label} killed (server shutdown)` },
      },
    };
  if (result.exitCode === null) {
    // No exit code and we didn't kill it: a spawn failure (bad command →
    // `permanent`) or an external kill signal (→ `transient`).
    if (result.signal !== null) {
      return {
        ...base,
        summary: 'signalled',
        terminal: {
          failed: {
            type: 'failed',
            kind: 'transient',
            error: `${label} killed by signal ${result.signal}`,
          },
        },
      };
    }
    return {
      ...base,
      summary: 'spawnFailed',
      terminal: {
        failed: {
          type: 'failed',
          kind: 'permanent',
          error: `${label} failed to start (is '${command}' on PATH?)`,
        },
      },
    };
  }
  return { ...base, summary: 'completed', terminal: { exitCode: result.exitCode } };
}

/**
 * The `agent_task` invocation shape: `task` in, stdout + `exitCode` out. OUTCOME
 * MAPPING (mirroring the `http` adapter's "status is data"): a subprocess that
 * COMPLETES on its own — any exit code — is `succeeded{ output, exitCode }`, so a
 * pipeline can branch on `${nodes.x.output.exitCode}`. Only a failure-to-complete
 * is a `failed` event.
 *
 * #2 L14c / #799 — the ONE carve-out, opt-in per connection: a non-zero exit whose
 * combined stderr+stdout matches `quota.exhaustionPattern` is a `rate_limit`
 * failure carrying `resetWindowSeconds`, NOT a success. That is what lets it ARM
 * the connection's quota window through the driver's existing writer — the point
 * of #799: before it, only `llm_call` could arm that window, so a connection
 * consumed solely by `agent_task` nodes never learned it was spent and hot-looped
 * refused spawns. Note the read side was never the gap: the L14c admission gate
 * keys on connection KIND, so `agent_task` nodes were always THROTTLED by a window
 * a sibling `llm_call` had armed.
 *
 * The refusal is STILL METERED, unlike `llm_call`'s — a multi-turn session usually
 * burns real quota before it learns it is out (see the metering site).
 *
 * #2 L11b — OPT-IN STRUCTURED output: when the node declares an `outputSchema`, the
 * `task` gains an appended instruction directing the agent to emit its final result
 * as a JSON object fenced by the `AGENT_STRUCTURED_*` sentinels, and the
 * self-completed branch changes — the FENCED BLOCK becomes the success contract
 * (its exit code stays observable only via telemetry): a schema-valid block →
 * `succeeded{ ...typedFields }`; a missing / non-JSON / schema-failing block →
 * `permanent` (the structured contract the operator asked for was not met, and the
 * identical CLI call won't fix a response-content problem). The failure-to-COMPLETE
 * branch (timeout/kill/spawn) is unchanged — structured mode only reinterprets a
 * process that finished.
 */
async function* runAgentTask(
  supervisor: Supervisor,
  ctx: ActivityContext,
  secret: string | null,
  config: AgentConnectionConfig,
): AsyncIterable<ActivityEvent> {
  const input = agentTaskConfigSchema.safeParse(ctx.input);
  if (!input.success) {
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `invalid agent_task activity config: ${input.error.message}`,
    };
    return;
  }
  const outputSchema = input.data.outputSchema;
  // The structured protocol rides the TASK (the CLI prompt): the agent is told to
  // fence its final JSON result between the sentinels. Appended in the adapter,
  // AFTER `${}` substitution, so it is never itself re-substituted; the telemetry
  // hashes the child's STDOUT, so the appended arg never perturbs L11a fixtures.
  const task =
    outputSchema !== undefined
      ? `${input.data.task}\n\n${agentStructuredInstruction(outputSchema)}`
      : input.data.task;
  // Time the subprocess wall clock in the (impure) adapter — the L11a `latencyMs`
  // telemetry fact, stamped once here and frozen into the log (the reducer never
  // reads a clock).
  const started = Date.now();
  const { result, stdout, stderr } = await spawnAndCollect(
    supervisor,
    config,
    task,
    input.data.cwd ?? config.cwd,
    secret,
    ctx.signal,
  );
  const latencyMs = Date.now() - started;
  // One `shape` binding per runner (#816): the label reaches `classifyCliOutcome`,
  // `diagnoseCliExit` and `quotaRefusedFailure`, and a literal repeated at three
  // sites is three chances for them to disagree about which shape they are.
  const shape: CliShapeLabel = AGENT_TASK_ACTIVITY_TYPE;
  const classification = classifyCliOutcome(result, config.command, shape);
  const output = stdout.join('\n');
  // #2 L14c / #799 — the quota verdict, computed HERE (ahead of every yield)
  // because the terminal branch further down keys off it — the same hoist
  // `llm_call` makes. `diagnoseCliExit` decides for itself which outcomes can
  // carry a verdict, so neither shape restates that rule.
  const { terminal } = classification;
  const { diagnostic, quotaHit } = diagnoseCliExit(config.quota, shape, terminal, stderr, stdout);
  // #2 L11a — emit the subprocess TELEMETRY fact BEFORE the terminal (mirroring
  // `metered`/`captured`), so the exit code + summary + latency + stdout SHAPE are
  // observable regardless of outcome — including the FAILURE paths, where the
  // terminal `node.failed` carries none of this today. Shape only (`outputChars` +
  // fingerprint), never raw text; the fingerprint is OMITTED for empty stdout
  // (fail-closed — no `hash('')`).
  yield {
    type: 'agentTelemetry',
    telemetry: {
      latencyMs,
      exitCode: classification.exitCode,
      summary: classification.summary,
      ...(classification.signal !== null ? { signal: classification.signal } : {}),
      outputChars: output.length,
      ...(output.length > 0 ? { outputHash: sha256Hex(output) } : {}),
    },
  };
  // #797 — meter the invocation BEFORE any terminal (see `cliSpendFact` for why
  // a subprocess that merely RAN is marked). Sited ahead of the terminal branch
  // so it covers every outcome uniformly: a completed run, a structured-mode
  // block that fails validation after a clean exit, and an abnormal termination.
  //
  // THIS SHAPE'S PREDICATE — `spawnFailed` is the ONE exclusion: no subprocess
  // ever started, so nothing was billed and marking it would manufacture spend
  // (the pre-spawn config failures return earlier still and never reach here).
  //
  // It deliberately does NOT exclude a quota refusal, where `llm_call` does — and
  // #799 corrected the REASON for that asymmetry rather than removing it. The old
  // reason ("this shape discards stderr and never classifies a refusal") was pure
  // plumbing and is gone: this shape now classifies the refusal, immediately
  // below. The real reason is the SHAPE difference, and it survives:
  //
  //   `llm_call` is SINGLE-SHOT — one prompt in, one completion out. A refusal
  //   means the service declined at t=0, which positively establishes no exchange
  //   was served, so metering it would invent spend.
  //
  //   `agent_task` drives a whole multi-turn agent SESSION. It typically hits the
  //   usage limit MID-SESSION, after real turns have been served — that is HOW it
  //   learns it is exhausted. A refusal here establishes the opposite: quota was
  //   burned, and burning it is what produced the refusal.
  //
  // The adapter cannot tell a mid-session exhaustion from an already-exhausted
  // t=0 refusal (both are a regex hit on the diagnostic), so it must choose which
  // way to err. `cliSpendFact`'s doctrine settles it: an over-mark costs exactly
  // one spurious `unpriced` response and can never flip a run's cost to
  // INCOMPLETE or produce a wrong dollar figure, whereas an under-mark silently
  // hides real spend on the one transport that has no other spend signal. Mark.
  //
  // `resolveModel` (not `??`) so an empty-string connection `model` resolves to
  // the fallback exactly as it does on the `llm_call` path — one precedence rule,
  // one label, whichever shape ran. `agent_task` has no node-level model leg.
  if (classification.summary !== 'spawnFailed') {
    yield cliSpendFact(resolveModel({}, config, CLI_MODEL_FALLBACK) ?? CLI_MODEL_FALLBACK);
  }
  if ('failed' in terminal) {
    yield terminal.failed;
    return;
  }
  // #2 L14c / #799 — the ONE carve-out to this shape's "any exit code is
  // `succeeded`" mapping: a subscription-quota refusal is not the agent's work
  // product, it is the service declining to run the agent at all. Sited BEFORE
  // the structured-mode branch deliberately — a quota-refused structured run has
  // no fenced block, so leaving it to fall through would misdiagnose a throttle
  // as `permanent` ("no valid structured output block found"), the worst of the
  // three readings.
  //
  // Why this OVERRIDES the exit-code-is-data contract rather than bending to it:
  // that contract exists so a graph can branch on the AGENT'S verdict, and a
  // refused agent produced none. Left as `succeeded`, the CLI's refusal TEXT
  // flows into `${nodes.x.output}` for every downstream node and the pipeline
  // runs to completion on garbage — a silent-wrong data path. A classified,
  // retryable failure is loud. It is also the ONLY way to get quota-aware retry
  // here at all: `retryEligible` gates on the engine `transient` kind, which only
  // a `failed` event can carry, so a node left `succeeded` could never schedule
  // one and the hot-loop would survive.
  //
  // OPT-IN, and since #816 the granularity is per-SHAPE: nothing changes unless
  // the operator set `quota.exhaustionPattern`, and `quota.classifyShapes` scopes
  // WHICH shapes that pattern is classified on. Omitting it means both (the #799
  // behaviour), so keeping `agent_task`'s exit-code-is-data contract no longer
  // costs `llm_call` its classification on the same connection. What scoping does
  // NOT buy is immunity from the admission gate, which keys on the connection —
  // see `classifyShapes` for why that asymmetry is the fail-safe reading.
  if (quotaHit !== undefined) {
    yield quotaRefusedFailure(
      shape,
      terminal.exitCode,
      cliFailureDetail(diagnostic, secret),
      quotaHit,
    );
    return;
  }
  // #2 L11b — STRUCTURED mode: the fenced block is the success contract, not the
  // exit code. `parseAndValidateStructured` returns ONLY the schema-declared, typed
  // fields (unknown keys stripped, optionals present-null), which is exactly the
  // `succeeded.outputs` the reducer's `validateOutputs` accepts against the
  // schema-lowered `config.outputs`. A missing block is a DISTINCT reason (not the
  // misleading "not valid JSON" of an empty parse). The reason names fields/types,
  // never the raw payload, so no child content — secret or otherwise — is echoed
  // into the durable `node.failed`.
  if (outputSchema !== undefined) {
    const block = extractStructuredBlock(output);
    if (block === null) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error:
          'agent_task structured output invalid: no valid structured output block found in stdout',
      };
      return;
    }
    const validated = parseAndValidateStructured(outputSchema, block);
    if (!validated.ok) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `agent_task structured output invalid: ${validated.reason}`,
      };
      return;
    }
    yield { type: 'succeeded', outputs: validated.value };
    return;
  }
  yield { type: 'succeeded', outputs: { output, exitCode: terminal.exitCode } };
}

/**
 * #2 L14b — the `llm_call` invocation shape on a CLI/subscription connection: a
 * single-shot subprocess whose stdout is the `text` completion. The response is
 * metered `unpriced` (emitted BEFORE the terminal, mirroring the API adapters);
 * a non-zero exit is a `permanent` failure (an opaque CLI/model error the LLM
 * contract cannot express as a completion, and not one to hot-loop). Since #797
 * an ABANDONED invocation is metered too — a tree-killed or cancelled CLI burned
 * the subscription's quota just the same. The rule is simply "a subprocess that
 * RAN spent quota", with two exclusions that each positively establish no
 * exchange was served: a spawn failure (no subprocess ran at all) and a quota
 * EXHAUSTION (the service refused the call). Marking either would misreport
 * spend. A plain non-zero exit is NOT excluded — see the metering site below for
 * why the HTTP adapters' unmarked-non-2xx rule does not carry over to it.
 *
 * SHAPE LIMITS (a CLI single-shot cannot carry the full `llm_call` config, so the
 * operator drives these via the connection's static `args`, NOT the node config):
 * - `sampling` (`temperature`/`maxTokens`/`topP`/`stop`/`seed`) and
 *   `reasoningEffort` are NOT forwarded — a generic CLI has no portable flag for
 *   them. An author who needs e.g. `temperature: 0` for a deterministic Judge
 *   must set the CLI's own flag in `args`; the node-config value is inert here.
 *   (Called out rather than silently assumed, matching the price/token honesty.)
 * - The folded prompt is the FINAL argv element (never shell-interpolated). If a
 *   prompt can begin with `-`/`--`, add a `--` end-of-options terminator to the
 *   connection's `args` where the target CLI supports it, so the prompt is never
 *   parsed as a flag.
 */
async function* runLlmCall(
  supervisor: Supervisor,
  ctx: ActivityContext,
  secret: string | null,
  config: AgentConnectionConfig,
): AsyncIterable<ActivityEvent> {
  const llm = llmCallConfigSchema.safeParse(ctx.input);
  if (!llm.success) {
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `invalid llm_call config: ${llm.error.message}`,
    };
    return;
  }
  if (llm.data.outputMode === 'structured') {
    // A CLI's stdout is opaque text — there is no provider JSON/tool mode to
    // ENFORCE a schema against, and parse-and-validate on arbitrary stdout is an
    // opt-in agent protocol (L11b), not this shape. Reject at dispatch (the bound
    // connection kind is not reliably known at save-time).
    yield {
      type: 'failed',
      kind: 'permanent',
      error:
        'structured output is not supported on an agent_cli (CLI) connection — bind a provider connection (anthropic/openai/ollama) or use agent_task',
    };
    return;
  }
  if (llm.data.tools !== undefined && llm.data.toolChoice !== 'none') {
    // #2 L10a — same shape limit as structured: a single-shot CLI exchange has
    // no tool_use/tool_result wire to drive the local tool round-trip through.
    // Reject LOUD at dispatch rather than silently run the prompt without the
    // author's tools (the connection kind is not reliably known at save-time —
    // L13a routes `connectionId` dynamically). `toolChoice:'none'` is exempt,
    // mirroring the provider adapters: "tools off" means running without them
    // IS the author's intent, so a dynamically-routed node parked on 'none'
    // behaves identically on every connection kind.
    yield {
      type: 'failed',
      kind: 'permanent',
      error:
        'tools are not supported on an agent_cli (CLI) connection — bind a provider connection (anthropic/openai/ollama)',
    };
    return;
  }
  const prompt = renderCliPrompt(normalizeLlmRequest(llm.data));
  // Model is a metering LABEL only (an unpriced call resolves no price): node <
  // connection < the `cli` fallback.
  const model = resolveModel(llm.data, config, undefined) ?? CLI_MODEL_FALLBACK;

  const { result, stdout, stderr } = await spawnAndCollect(
    supervisor,
    config,
    prompt,
    config.cwd,
    secret,
    ctx.signal,
  );
  // One `shape` binding per runner — rationale at `agent_task`'s (#816).
  const shape: CliShapeLabel = LLM_CALL_ACTIVITY_TYPE;
  const classification = classifyCliOutcome(result, config.command, shape);
  const { terminal } = classification;
  // #2 L14c — the combined stderr+stdout diagnostic and the quota verdict read
  // off it, both LAZY. Computed HERE rather than inside the non-zero-exit branch
  // because the metering decision below needs the quota match. Shared with
  // `agent_task` since #799 (rationale: `diagnoseCliExit`).
  const { diagnostic, quotaHit } = diagnoseCliExit(config.quota, shape, terminal, stderr, stdout);
  // #797 — meter BEFORE any terminal, so an abnormal termination is accounted for
  // rather than silently free (rationale: `cliSpendFact`).
  //
  // THE PREDICATE — two exclusions, the SAME two `agent_task` applies since #799:
  //  - `spawnFailed` — no subprocess ran at all, so nothing was billed.
  //  - a quota EXHAUSTION — the service refused the call, the one CLI outcome
  //    that positively establishes no exchange was served. Note its narrowness:
  //    `quotaHit` requires a COMPLETED non-zero exit, so a CLI that prints its
  //    quota refusal and then hangs until the wall-clock kill is still metered —
  //    correct-by-policy (an over-mark costs one `unpriced` response), not a hole.
  //    #816 narrows it once more, and deliberately: scoping this shape out of
  //    `quota.classifyShapes` leaves `quotaHit` undefined, so a genuine refusal
  //    here is METERED. There is nothing to except once the operator has declared
  //    this shape's output is not trustworthy evidence of exhaustion, and the
  //    over-mark direction is the one `cliSpendFact` already prefers.
  // A plain non-zero EXIT is deliberately NOT excluded. It is tempting to read it
  // as the HTTP adapters' unmarked non-2xx, but the analogy breaks: a non-2xx is
  // the PROVIDER stating it did not serve the request, whereas an exit code is the
  // client wrapper's verdict on its whole job — routinely non-zero AFTER a
  // completed generation (a post-hoc parse/hook failure, a broken pipe on write).
  if (classification.summary !== 'spawnFailed' && quotaHit === undefined) {
    yield cliSpendFact(model);
  }
  if ('failed' in terminal) {
    yield terminal.failed;
    return;
  }
  if (terminal.exitCode !== 0) {
    // `diagnostic` folds BOTH channels (built above, since the metering decision
    // needed it): some CLIs (e.g. `codex exec`) print their error to STDOUT, not
    // stderr, so a failure is never a bare "exited N" with no context.
    // `cliFailureDetail` redacts the resolved secret out of it BEFORE truncating,
    // so nothing leaks into the durable `node.failed` (rationale there).
    const detail = cliFailureDetail(diagnostic, secret);
    // #2 L14c — a subscription-quota exhaustion is a THROTTLE, not a permanent
    // error (rationale + the no-retry-policy note: `quotaRefusedFailure`). The
    // match ran PRE-redaction, above, because that verdict also drives the
    // metering exclusion — a refused call was never served.
    if (quotaHit !== undefined) {
      yield quotaRefusedFailure(shape, terminal.exitCode, detail, quotaHit);
      return;
    }
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `llm_call CLI exited ${terminal.exitCode}${detail !== '' ? `: ${detail}` : ''}`,
    };
    return;
  }
  // The `metered` fact for this exchange was emitted above, before the terminal
  // branches (#797) — it is no longer reachable only from the success path.
  //
  // A present-but-empty completion (exit 0, empty stdout) is a real result — like
  // an API adapter's explicit `content:''` — so it succeeds with `text:''`. There
  // is no provider stop-reason for a CLI, so `coerceStopReason(undefined)` stamps
  // the honest `unknown` sentinel (NOT a fabricated `'stop'`, which is a real
  // OpenAI finish_reason a `${...stopReason} == 'stop'` branch would confuse).
  yield {
    type: 'succeeded',
    outputs: { text: stdout.join('\n'), stopReason: coerceStopReason(undefined) },
  };
}

/**
 * Build the `agent_cli` adapter bound to a specific `Supervisor` (per-app, so
 * this app's shutdown reap tree-kills only its own subprocesses).
 */
export function createAgentAdapter(supervisor: Supervisor): ConnectorAdapter {
  return {
    kind: AGENT_CLI_CONNECTION_KIND,
    configSchema: agentConnectionConfigSchema,

    async testConnection(config) {
      // Deliberately does NOT spawn: running an arbitrary command as a liveness
      // probe would be an unsafe, costly side effect. Assert a valid config only.
      const parsed = agentConnectionConfigSchema.safeParse(config);
      if (!parsed.success) {
        return { ok: false, error: `invalid agent_cli connection config: ${parsed.error.message}` };
      }
      return { ok: true };
    },

    async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
      const config = agentConnectionConfigSchema.safeParse(ctx.connectionConfig);
      if (!config.success) {
        yield {
          type: 'failed',
          kind: 'permanent',
          error: `invalid agent_cli connection config: ${config.error.message}`,
        };
        return;
      }
      // ONE adapter, two invocation shapes (the `fs` multi-activity seam). A
      // mis-routed third type fails LOUDLY rather than being silently treated as
      // one of the two.
      if (ctx.activityType === LLM_CALL_ACTIVITY_TYPE) {
        yield* runLlmCall(supervisor, ctx, secret, config.data);
        return;
      }
      if (ctx.activityType === AGENT_TASK_ACTIVITY_TYPE) {
        yield* runAgentTask(supervisor, ctx, secret, config.data);
        return;
      }
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `agent_cli adapter cannot serve activity '${ctx.activityType}'`,
      };
    },
  };
}
