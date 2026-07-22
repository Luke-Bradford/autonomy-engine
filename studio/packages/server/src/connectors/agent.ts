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
 *   `text` completion. The response is metered `unpriced` — a flat/covered seat
 *   pays for it, so there is NO per-token dollar price BY DESIGN (the executor
 *   suppresses all price fields on `unpriced`; L6 counts it as a known
 *   zero-marginal, not a measurement gap). A non-zero exit is a `permanent`
 *   failure here (unlike `agent_task`): the LLM shape's contract is a completion,
 *   and an opaque CLI error is not something to hot-loop a retry on.
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
 * success/failure edges. Only a failure to complete is a `failed` event:
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

/**
 * The harness's own secret-bearing env vars (the secrets master key — see
 * `secrets/secrets.ts` → `resolveMasterKey`). Stripped from every `agent_cli`
 * child so a subprocess can never read the key that decrypts all connection
 * secrets.
 */
const MASTER_KEY_ENV_VARS = ['AUTONOMY_MASTER_KEY', 'AUTONOMY_MASTER_KEY_FILE'] as const;

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
   * #2 L14b — the default model this CLI connection reports for an `llm_call`
   * (node `config.model` < this < the `cli` fallback). Purely a metering LABEL:
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
   * `resetWindowSeconds` is capped at the engine retry-alarm ceiling
   * (`MAX_RETRY_AFTER_SECONDS`, 24h): the L7 alarm cannot schedule further out, so
   * a > 24h window (e.g. a weekly quota) is REFUSED here at save-time rather than
   * silently clamped down (a clamp would fire the retry while still exhausted).
   * Windows > 24h need the persisted per-connection window + admission-gate — the
   * deferred remainder of #609, a different mechanism than this L7-reuse slice.
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

/** The `provider` field on an `llm_call` CLI response's metering fact — the
 * Connection kind, per the `activity.metered` contract. Derived from the shared
 * kind constant so the metering label cannot drift from the adapter's `kind`. */
const AGENT_CLI_PROVIDER: string = AGENT_CLI_CONNECTION_KIND;

/** The metering model LABEL when neither the node nor the connection names one.
 * An `unpriced` call has no price to resolve, so this is descriptive only. */
const CLI_MODEL_FALLBACK = 'cli';

/** Bound on the CLI diagnostic excerpt folded into a non-zero-exit failure
 * message, so a verbose CLI cannot bloat the durable `node.failed` event. Over
 * the cap, the head and tail (half each) are kept with a middle elision. */
const MAX_STDERR_DETAIL_CHARS = 1000;

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
  label: string,
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
  const { result, stdout } = await spawnAndCollect(
    supervisor,
    config,
    task,
    input.data.cwd ?? config.cwd,
    secret,
    ctx.signal,
  );
  const latencyMs = Date.now() - started;
  const classification = classifyCliOutcome(result, config.command, 'agent_task');
  const output = stdout.join('\n');
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
  if ('failed' in classification.terminal) {
    yield classification.terminal.failed;
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
  yield { type: 'succeeded', outputs: { output, exitCode: classification.terminal.exitCode } };
}

/**
 * #2 L14b — the `llm_call` invocation shape on a CLI/subscription connection: a
 * single-shot subprocess whose stdout is the `text` completion. The response is
 * metered `unpriced` (emitted BEFORE the terminal, mirroring the API adapters);
 * a non-zero exit is a `permanent` failure (an opaque CLI/model error the LLM
 * contract cannot express as a completion, and not one to hot-loop). NO metering
 * fact is emitted on ANY failure — we cannot know whether a billable response
 * occurred (a spawn failure definitely did not), and fabricating one would
 * misreport spend.
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
  const { terminal } = classifyCliOutcome(result, config.command, 'llm_call');
  if ('failed' in terminal) {
    yield terminal.failed;
    return;
  }
  if (terminal.exitCode !== 0) {
    // Some CLIs (e.g. `codex exec`) print their error/diagnostic to STDOUT, not
    // stderr — fold BOTH into the detail so a failure is never a bare "exited N"
    // with no context. stderr first (the conventional error channel).
    // REDACT the resolved secret out of that text BEFORE it lands in the durable
    // `node.failed` event — a CLI commonly echoes the injected key in an
    // auth/quota error, and this string is persisted to `run_events` and served
    // over the API. Redact the FULL text first, then truncate, so a secret
    // straddling the truncation boundary is still fully scrubbed. Same never-leak
    // discipline every sibling adapter upholds (http/llm-shared → `redactSecrets`).
    const diagnostic = [stderr.join('\n'), stdout.join('\n')]
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .join('\n');
    const raw = redactSecrets(diagnostic, [secret]);
    // Keep BOTH ends when over the cap: a CLI may print the real error EARLY (then
    // trail off in progress noise) OR summarise it at the END, so preserving only
    // one end can bury the signal. Head + tail with a middle elision covers both.
    const half = Math.floor(MAX_STDERR_DETAIL_CHARS / 2);
    const detail =
      raw.length > MAX_STDERR_DETAIL_CHARS ? `${raw.slice(0, half)}…${raw.slice(-half)}` : raw;
    // #2 L14c — a subscription-quota exhaustion is a THROTTLE, not a permanent
    // error. Match the connection's `quota.exhaustionPattern` against the
    // PRE-redaction diagnostic (detection accuracy; the emitted `error` stays the
    // redacted+truncated `detail`). On a hit, emit `rate_limit` (→ engine transient
    // + `code:'rate_limit'`) carrying the reset window as the L7 `retryAfterSeconds`
    // so the existing retry-alarm path waits out the window instead of hot-looping.
    // The pattern is boundary-validated compilable, so `new RegExp` cannot throw.
    // NOTE: whether an alarm actually ARMS is the reducer's call — a `rate_limit`
    // (transient) failure only schedules a retry when the node carries a
    // `policy.retry` budget. With no retry policy the node settles to a plain
    // terminal failure (now merely tagged `code:'rate_limit'`) — correct: there is
    // nothing to retry against, so there is no hot-loop to wait out.
    const quota = config.quota;
    if (quota !== undefined && new RegExp(quota.exhaustionPattern).test(diagnostic)) {
      yield {
        type: 'failed',
        kind: 'rate_limit',
        error: `llm_call CLI exited ${terminal.exitCode} (quota exhausted)${detail !== '' ? `: ${detail}` : ''}`,
        retryAfterSeconds: quota.resetWindowSeconds,
      };
      return;
    }
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `llm_call CLI exited ${terminal.exitCode}${detail !== '' ? `: ${detail}` : ''}`,
    };
    return;
  }
  // A billable (subscription-covered) response occurred: meter it `unpriced` with
  // NO tokens (a CLI gives none) — the executor keeps ALL price fields absent, and
  // L6 folds it into the run-cost's `unpriced` bucket (not the incompleteness gap).
  yield {
    type: 'metered',
    usage: { provider: AGENT_CLI_PROVIDER, model, meteringStatus: 'unpriced' },
  };
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
