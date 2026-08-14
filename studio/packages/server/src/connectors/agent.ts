import { z } from 'zod';
import {
  agentConnectionConfigSchema,
  AGENT_CLI_CONNECTION_KIND,
  AGENT_TASK_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  agentTaskConfigSchema,
  agentStructuredInstruction,
  extractStructuredBlock,
  parseAndValidateStructured,
  WARNING_CODES,
} from '@autonomy-studio/shared';
import type { WarningCode } from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import type { Supervisor, SupervisedResult } from '../workers/process-supervisor.js';
import { DEFAULT_MAX_OUTPUT_BYTES } from '../workers/process-supervisor.js';
import {
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

// #1087 — the shape moved to `shared/catalog/connection-config.ts` (with its
// `isCompilableRegex` boundary guard) so the Manage › Connections form derives
// its controls from the schema this adapter parses at dispatch. The quota
// block's full rationale moved with it. Imported, never re-declared.

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
 * This is a SIZE bound only, and it is the LAST gate, not the only one. WHICH
 * text reaches it is now the operator's to declare (#816): `quota.matchSource:
 * stderr` drops stdout entirely, and `json-lines` narrows stdout to declared
 * error envelopes, both BEFORE this cap applies — so content can no longer CROWD
 * OUT the envelopes. Not the stronger claim: a narrowed surface can still exceed
 * 64k (stderr is never narrowed, and the envelope budget permits far more), so
 * mid-surface elision remains possible; what changes is that agent prose no longer
 * competes for the room. ABSENT a declaration this still caps the whole
 * stderr+stdout join, exactly as under #799. The stdout-TAIL cut was tried and refuted on in-repo
 * evidence (see `diagnoseCliExit`); the SHAPE scope is `quota.classifyActivityTypes`. */
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

/**
 * The per-line ceiling on what `json-lines` narrowing will hand to `JSON.parse`
 * (#816). A refusal envelope is a few hundred bytes in every CLI this repo reads,
 * so this is an AVAILABILITY bound of the same family as `MAX_CLI_MATCH_CHARS` —
 * parsing is synchronous on the server's only thread.
 *
 * An over-cap line is NOT dropped: it already matched in the `type` position, so
 * dropping it would silently lose a real refusal (a provider error body that
 * echoes the request can exceed this). It degrades to a bounded RAW excerpt
 * instead — see `narrowedQuotaSurface`. The cap is on the PARSE, not on whether
 * the line counts. */
const MAX_ENVELOPE_LINE_CHARS = 16_000;

/**
 * The total ceiling on characters handed to `JSON.parse` while narrowing ONE
 * exit (#816).
 *
 * Without it the narrowing would be a worse stall than the one `MAX_CLI_MATCH_CHARS`
 * exists to prevent: a 10 MB `agent_task` transcript whose every line names a
 * declared type (this repo's own workload literally discusses `rate_limit_event`)
 * would be parsed in full, and `JSON.parse` over megabytes costs far more than the
 * bounded `RegExp.test` it feeds.
 *
 * Candidate lines are consumed from the END of the stream BACKWARDS, so the
 * envelopes nearest the exit are the ones that survive an exhausted budget.
 *
 * Be exact about what that means rather than selling it: ONCE EXHAUSTED, THIS IS
 * THE POSITIONAL CUT #816 REFUTED — the earliest envelopes are dropped, and the
 * refuting evidence (a limit signal sitting arbitrarily far from the end, behind
 * recovery turns) applies to it. What makes it acceptable is WHERE it bites: only
 * past 1 MB of text that is already `{"type":"<declared>"` — orders of magnitude
 * past any real refusal stream — where the alternative is a synchronous
 * multi-megabyte parse on the server's only thread. Below that it never triggers,
 * and the kept envelopes are re-ordered into stream order before matching. */
const MAX_ENVELOPE_PARSE_CHARS = 1_000_000;

/** Recursion ceiling for the string-leaf walk of one envelope (#816), counted
 * from 0 as `deepRedactSecrets` does. Bounds a pathological nesting depth; no
 * real envelope approaches it. `JSON.parse` cannot mint a cycle, so this is a
 * depth bound only, not a cycle guard. */
const MAX_ENVELOPE_LEAF_DEPTH = 8;

/** The separator between collected leaves and between envelopes (#816).
 *
 * NOT a bare `\n`. Narrowing deletes the text between two survivors, so joining
 * them directly would let a pattern match across a seam that never existed in the
 * output — the same forgery `headTailExcerpt`'s elision marker exists to prevent
 * (`…usage li` + `mit reached…`), and here it can invent a match that plain `text`
 * matching would NOT have produced. Same marker, same reason. */
const ENVELOPE_SEAM = '\n…\n';

/** Every string LEAF reachable in `value`, depth-bounded. Keys are never
 * collected — the pattern should see the CLI's words, not the protocol's. */
function collectStringLeaves(value: unknown, depth: number, out: string[]): void {
  if (depth >= MAX_ENVELOPE_LEAF_DEPTH) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, depth + 1, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) collectStringLeaves(nested, depth + 1, out);
  }
}

/**
 * Whether a trimmed stdout line is worth handing to `JSON.parse` at all (#816):
 * it must open an object AND already carry a declared type in the `type` POSITION.
 *
 * Matching `"type":"<t>"` rather than a bare `"<t>"` token matters for the budget,
 * not just for speed: `"error"` is an ordinary key in unrelated protocol events
 * (`{"type":"item.completed","error":null,…}`), so the looser form would charge a
 * whole transcript of non-envelopes against `MAX_ENVELOPE_PARSE_CHARS` and starve
 * the real envelopes it exists to keep.
 *
 * It can only REJECT, never admit: the parsed `type` is what actually decides. A
 * conservatively-formatted producer (`"type" : "error"`, or an escaped `e`)
 * is therefore dropped unparsed — accepted, and the reason the format is opt-in. */
function isCandidateEnvelopeLine(trimmed: string, types: readonly string[]): boolean {
  if (!trimmed.startsWith('{')) return false;
  return types.some(
    (type) => trimmed.includes(`"type":"${type}"`) || trimmed.includes(`"type": "${type}"`),
  );
}

/**
 * The matchable text of ONE candidate stdout line under a `json-lines` source
 * (#816), or `undefined` if it is not in fact a declared error envelope.
 *
 * The parse guards are TYPE-LEVEL, and labelled as such rather than sold as a
 * runtime defence: `isCandidateEnvelopeLine`'s `{` prefix already makes a
 * non-object parse unreachable from the only caller, and `types.includes(type)`
 * compares with `===`, so a non-string `type` is rejected by identity whether or
 * not the `typeof` narrowing is written. They exist so the cast below is sound. */
function errorEnvelopeText(trimmed: string, types: readonly string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const envelope = parsed as Record<string, unknown>;
  const type = envelope.type;
  if (typeof type !== 'string' || !types.includes(type)) return undefined;
  const leaves: string[] = [];
  for (const [key, value] of Object.entries(envelope)) {
    // The selector is not the evidence — see residual 7 on `quota.matchSource`.
    if (key === 'type') continue;
    collectStringLeaves(value, 0, leaves);
  }
  return leaves.join(ENVELOPE_SEAM);
}

/**
 * The text `exhaustionPattern` is matched against under a `json-lines` source
 * (#816): stderr IN FULL (it is CLI/API output, never model content), plus the
 * decoded string leaves of stdout's declared error envelopes, in stream order.
 *
 * The FULL diagnostic is unaffected — this bounds what the pattern SCANS, never
 * what the failure event REPORTS, exactly as `MAX_CLI_MATCH_CHARS` does. */
function narrowedQuotaSurface(
  stderr: readonly string[],
  stdout: readonly string[],
  types: readonly string[],
): string {
  const envelopes: string[] = [];
  let budget = MAX_ENVELOPE_PARSE_CHARS;
  for (let i = stdout.length - 1; i >= 0 && budget > 0; i -= 1) {
    const trimmed = (stdout[i] ?? '').trim();
    if (!isCandidateEnvelopeLine(trimmed, types)) continue;
    // Charged for every line handed to the parser. The candidacy WALK above is
    // deliberately uncharged and linear in the whole stream — it is string
    // scanning, not parsing, and `errorEnvelopeTypes` is length-bounded so it
    // cannot be multiplied out by config.
    budget -= trimmed.length;
    if (trimmed.length > MAX_ENVELOPE_LINE_CHARS) {
      // An over-cap line is a DECLARED envelope (it matched in the `type`
      // position) that is too big to parse — an API error body echoing the
      // request, say. Dropping it would miss a real refusal, so degrade to the
      // SAFE direction: match a bounded raw excerpt of that one line. Raw means
      // JSON-escaped and key-inclusive, i.e. weaker than a leaf match — but
      // weaker beats absent when the fail direction is #799's hot loop.
      envelopes.push(headTailExcerpt(trimmed, MAX_ENVELOPE_LINE_CHARS));
      continue;
    }
    const text = errorEnvelopeText(trimmed, types);
    if (text !== undefined && text !== '') envelopes.push(text);
  }
  envelopes.reverse();
  return [stderr.join('\n'), envelopes.join(ENVELOPE_SEAM)]
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join(ENVELOPE_SEAM);
}

/** The two invocation shapes this adapter serves. A closed union rather than a
 * bare `string` so the label a failure is built with cannot drift from the one
 * `classifyCliOutcome` was given. */
type CliShapeLabel = 'llm_call' | 'agent_task';

/**
 * #1101 — the ADVISORY for a child whose output collection hit the supervisor's
 * byte cap. `ProcessSupervisor` has always computed `truncated` (a shared
 * stdout+stderr budget, `DEFAULT_MAX_OUTPUT_BYTES` unless the connection sets
 * `maxOutputBytes`); nothing read it, so a clipped transcript flowed into
 * `${nodes.x.output.output}` indistinguishable from a whole one. That is the
 * silent-truncation class `limits.ts` states outright and `fs.ts`'s `file_read`
 * refuses — the only path that did it silently had already computed the marker.
 *
 * ADVISORY, not a failure, and the asymmetry with `file_read` is deliberate: a
 * partial FILE is useless, whereas an over-long agent transcript is a normal
 * outcome whose prefix is usually exactly what the operator wanted. So state the
 * clipping and let the run stand.
 *
 * PRECISION MATTERS IN THE SENTENCE. The budget is ONE allowance shared by both
 * streams (`SharedByteBudget`), so this says COLLECTION stopped at the cap — a
 * chatty stderr can exhaust it while stdout is complete. It must not claim the
 * `output` value was cut. It names the shape and the cap and NO child content:
 * the durable `activity.warned.reason` is passed through unredacted, so the
 * producer is the only guard.
 */
function truncationWarning(shape: CliShapeLabel, maxOutputBytes: number | undefined): ActivityEvent {
  const cap = maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    type: 'warned',
    code: WARNING_CODES.OUTPUT_TRUNCATED satisfies WarningCode,
    reason:
      `${shape}: the agent CLI wrote more than the ${cap}-byte output budget, so collection ` +
      `stopped there and the transcript kept is a prefix (the budget is shared by stdout and ` +
      `stderr, so stdout may itself be complete)`,
  };
}

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
 * TWO bounds apply, and neither is the SURFACE question:
 *  - SIZE: the pattern is tested against a `MAX_CLI_MATCH_CHARS` excerpt, not the
 *    whole (up to `maxOutputBytes`, 10 MB) transcript, because the `test` is
 *    synchronous and scanning megabytes on the server's only thread is an
 *    event-loop stall. Note the limit of what this buys: `headTailExcerpt` returns
 *    the text UNMODIFIED below the cap, so for a transcript under 64k — plenty of
 *    real sessions — the mid-body is matched in full. Only an OVER-cap transcript
 *    has its middle elided.
 *  - ACTIVITY TYPE: `quota.classifyActivityTypes` (#816) lets an operator declare
 *    which invocation shapes may produce a verdict at all, so `agent_task` can be
 *    scoped out without disarming `llm_call` on the same connection. Scoping it
 *    out also removes this connection's megabyte-input exposure to a
 *    backtracking-prone operator pattern — the residual event-loop hazard #816
 *    notes, which the size bound caps but does not eliminate.
 *
 * WHICH SURFACE `agent_task` should match REMAINS OPEN (#816). One candidate was
 * investigated and REJECTED, and the evidence pointed at a better one:
 *
 * REJECTED — a stdout TAIL cut. It looks safe ("a CLI that dies of quota prints
 * the reason last"), but this repo reads two real agent CLIs and BOTH contradict
 * it. `bin/agents/claude.sh` classifies a Claude Code limit from a MID-STREAM
 * `rate_limit_event`, scans for the LAST of several, and treats a session that
 * continues and even SUCCEEDS after one as not-blocked. `bin/agents/codex.sh` is
 * the same shape (`limited and not completed`), with a `turn.completed` after the
 * error meaning recovery. So the limit signal is not POSITIONAL in either CLI: it
 * can sit arbitrarily far from the end, behind recovery turns and teardown, and a
 * tail cut would miss it and reopen #799's hot-loop.
 *
 * SHIPPED — narrow by SOURCE, not by position or channel: `quota.matchSource:
 * json-lines` (#816), where the operator declares that their CLI speaks a
 * JSON-per-line protocol and names its error-envelope types. stdout then
 * contributes ONLY those envelopes' decoded string leaves; agent content is
 * excluded. Both engine adapters converged on this principle independently —
 * claude.sh reads `rate_limit_event`, codex.sh reads `error`/`turn.failed`/
 * `stream_error`, and codex.sh states it outright ("an error envelope is API/CLI
 * output, never model content. Agent CONTENT (item.* events) is never parsed").
 *
 * It is OPT-IN and it NARROWS rather than CLOSES: studio never injects the format
 * flag (the operator owns `args`), an agent that PRINTS a well-formed envelope
 * forges one, and an un-declared connection matches the flat blob exactly as it
 * did under #799. The residuals are enumerated on the `matchSource` field.
 *
 * A JUDGEMENT, not a measurement: the false positive a tail cut WOULD have
 * suppressed is mid-transcript tool output (#816's own archetype — an agent
 * reading logs that discuss quota), whereas an agent's closing summary ("I
 * stopped: usage limit reached") sits in the tail and would survive it. So the cut
 * is not obviously a win on the false-positive axis either. The miss-a-real-
 * refusal leg above is what actually decides it.
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
  // pure waste once the verdict is scoped out). ABSENT `classifyActivityTypes` = both
  // shapes, so an untouched config behaves exactly as it did under #799. Note
  // the `diagnostic` is still built and returned: scoping decides whether a
  // failure carries a QUOTA VERDICT, never what a failure is allowed to SAY.
  if (quota === undefined) return { diagnostic, quotaHit: undefined };
  const scope = quota.classifyActivityTypes;
  if (scope !== undefined && !scope.includes(shape)) return { diagnostic, quotaHit: undefined };
  // #816 — the SOURCE narrowing, built LAZILY here rather than alongside the
  // `diagnostic`: everything above returns before it, so a connection with no
  // quota hint (or a scoped-out shape) never pays for a parse it cannot use.
  // ABSENT/`text` reuses the `diagnostic` verbatim — the default path is
  // provably byte-identical to #799's, not merely equivalent.
  const source = quota.matchSource;
  const surface: string =
    source?.format === 'json-lines'
      ? narrowedQuotaSurface(stderr, stdout, source.errorEnvelopeTypes)
      : source?.format === 'stderr'
        ? stderr.join('\n').trim()
        : diagnostic;
  // Match against a BOUNDED excerpt (`MAX_CLI_MATCH_CHARS`) — an `agent_task`
  // transcript can be megabytes and this `test` is synchronous. The FULL
  // `diagnostic` is still returned: the excerpt bounds what the pattern scans,
  // not what the failure event reports.
  const quotaHit = new RegExp(quota.exhaustionPattern).test(
    headTailExcerpt(surface, MAX_CLI_MATCH_CHARS),
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
  // #1101 — and if collection hit the byte cap, SAY SO, on the same
  // before-the-terminal footing as the telemetry fact and for the same reason:
  // the fact is known here, ahead of the outcome, and a clipped transcript on an
  // attempt that went on to time out is exactly when it is worth knowing.
  if (result.truncated) yield truncationWarning(shape, config.maxOutputBytes);
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
  // the operator set `quota.exhaustionPattern`, and `quota.classifyActivityTypes` scopes
  // WHICH shapes that pattern is classified on. Omitting it means both (the #799
  // behaviour), so keeping `agent_task`'s exit-code-is-data contract no longer
  // costs `llm_call` its classification on the same connection. What scoping does
  // NOT buy is immunity from the admission gate, which keys on the connection —
  // see `classifyActivityTypes` for why that asymmetry is the fail-safe reading.
  //
  // NAME THE COST, because scoping this shape out is not free. THREE things come
  // back, all of them the pre-#799 behaviour:
  //  - the silent-wrong data path the paragraph above argues against — the CLI's
  //    refusal TEXT flows into `${nodes.x.output}` and downstream nodes run on it;
  //  - the connection window stays un-armed, so sibling `llm_call` nodes keep
  //    hot-looping until one of THEM is refused;
  //  - and on a STRUCTURED node it is worse than "exit code is data", because that
  //    contract never applied there: a refused run emits no fenced block, so it
  //    falls through to the structured branch below and is reported `permanent`
  //    ("no valid structured output block found") — precisely the misdiagnosis
  //    this branch is sited above to prevent. Pinned in `agent.test.ts`.
  // It is the right lever for an operator whose agent transcripts trip the
  // pattern; it is not a free upgrade.
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
  // #1101 — `truncated` rides the TEXT-mode outputs as well as the advisory, so a
  // pipeline can BRANCH on `${nodes.x.output.truncated}` the way it already
  // branches on `exitCode`. Only text mode: a structured node's contract is
  // derived from its `outputSchema` (`lowerAgentTaskStructuredOutputs`), so an
  // extra key there would be filtered out — the advisory is that mode's channel.
  // Reaches only nodes SAVED on catalog >= 21, since `lowerNodeOutputs` seeds a
  // contract once and never rewrites one; an older node's declared
  // `[output, exitCode]` simply drops the key (`storeOutputs`) and still succeeds.
  yield {
    type: 'succeeded',
    outputs: { output, exitCode: terminal.exitCode, truncated: result.truncated },
  };
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
  // #1101 — this shape emits NO telemetry fact (that one is `agent_task`-only) and
  // its outputs are the SHARED llm contract `[text, stopReason]`, which the three
  // API adapters also fill — so neither of `agent_task`'s channels exists here and
  // the advisory is the whole of it. Yielded first, before the metering fact and
  // every terminal branch, so it is present on abnormal terminations too.
  if (result.truncated) yield truncationWarning(shape, config.maxOutputBytes);
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
  //    `quota.classifyActivityTypes` leaves `quotaHit` undefined, so a genuine
  //    refusal here is METERED. There is nothing to except once the operator has
  //    declared this shape's output is not trustworthy evidence of exhaustion, and
  //    the over-mark direction is the one `cliSpendFact` already prefers — an
  //    `unpriced` fact is carved out of the run-cost completeness count
  //    (`pricing/run-cost.ts`), so it can never flip a run to INCOMPLETE nor move a
  //    dollar figure. The OTHER two consequences of scoping this shape out are
  //    sharper and are the operator's to weigh: a real throttle is recorded
  //    durably as `permanent` (factually wrong for a transient condition, and no
  //    retry can ever fire off it), and if every `llm_call` consumer of a
  //    connection is scoped out, that shape can no longer arm the window at all —
  //    the #799 hot-loop guard is configuration-disabled for it.
  //    `quota.matchSource` (#816 half 1) reaches the same three consequences by a
  //    different route: a refusal whose EVIDENCE the narrowing drops (an over-depth
  //    or non-string leaf, an exhausted parse budget) also leaves `quotaHit`
  //    undefined, so it is metered, recorded `permanent`, and arms no window. Same
  //    trade, and the operator opted into it the same way.
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
