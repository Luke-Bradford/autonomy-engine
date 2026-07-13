import { z } from 'zod';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import type { Supervisor } from '../workers/process-supervisor.js';

/**
 * The `agent_cli` connector adapter: runs an agent CLI (Claude Code, Codex, or
 * any command) as a supervised subprocess via the per-app `Supervisor` (the
 * `createSupervisor()` instance the host injects, whose `reapAllSupervised()` is
 * wired into graceful shutdown). The `agent_task` activity supplies the `task`
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
  /** Hard wall-clock timeout (ms). Exceeding it tree-kills the process. */
  timeoutMs: z.number().int().positive().optional(),
  /** Combined stdout+stderr byte cap before output is truncated. */
  maxOutputBytes: z.number().int().positive().optional(),
});

const agentRequestInputSchema = z.object({
  task: z.string().min(1),
  cwd: z.string().optional(),
});

/**
 * Build the `agent_cli` adapter bound to a specific `Supervisor` (per-app, so
 * this app's shutdown reap tree-kills only its own subprocesses).
 */
export function createAgentAdapter(supervisor: Supervisor): ConnectorAdapter {
  return {
    kind: 'agent_cli',
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
      const input = agentRequestInputSchema.safeParse(ctx.input);
      if (!input.success) {
        yield {
          type: 'failed',
          kind: 'permanent',
          error: `invalid agent_task activity config: ${input.error.message}`,
        };
        return;
      }

      const env: Record<string, string | undefined> = { ...(config.data.env ?? {}) };
      // The secret (if any) is injected ONLY into the child env, never argv.
      if (secret !== null && config.data.secretEnv !== undefined) {
        env[config.data.secretEnv] = secret;
      }
      // Defense-in-depth: STRIP the harness's own secrets master-key vars from
      // the child (the child otherwise inherits the full server env). An
      // arbitrary agent subprocess must never see the key that decrypts EVERY
      // connection secret. `undefined` unsets an inherited var (see the
      // `SpawnSupervisedOptions.env` contract). These win over any operator
      // `config.env` collision — correct, since no agent needs the harness key.
      for (const masterKeyVar of MASTER_KEY_ENV_VARS) env[masterKeyVar] = undefined;

      const proc = supervisor.spawnSupervised({
        command: config.data.command,
        args: [...(config.data.args ?? []), input.data.task],
        cwd: input.data.cwd ?? config.data.cwd,
        env,
        // A default upper bound so a hung agent can never PERMANENTLY hold a
        // shared worker-pool slot (the invariant every other adapter upholds);
        // generous, since agent runs are long. Overridable via `config.timeoutMs`.
        timeoutMs: config.data.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        maxOutputBytes: config.data.maxOutputBytes,
        signal: ctx.signal,
      });

      // Drain stdout line-by-line (bounded by the supervisor's byte budget) into
      // the `output`. The supervisor closes the stream once the child exits, so
      // this loop terminates. stderr is intentionally not surfaced as `output`.
      const outLines: string[] = [];
      const collect = (async () => {
        for await (const ev of proc.events) {
          if (ev.stream === 'stdout') outLines.push(ev.line);
        }
      })();
      const result = await proc.result;
      await collect;

      // The run's own cancel wins over a coincident timeout.
      if (result.aborted) {
        yield { type: 'failed', kind: 'cancelled', error: 'agent_task aborted' };
        return;
      }
      if (result.timedOut) {
        yield { type: 'failed', kind: 'transient', error: 'agent_task timed out' };
        return;
      }
      if (result.killed) {
        // Reaped by graceful shutdown (not abort/timeout, handled above).
        yield { type: 'failed', kind: 'cancelled', error: 'agent_task killed (server shutdown)' };
        return;
      }
      if (result.exitCode === null) {
        // No exit code and we didn't kill it: a spawn failure (bad command → a
        // `permanent` config error) or an external kill signal (→ transient).
        if (result.signal !== null) {
          yield {
            type: 'failed',
            kind: 'transient',
            error: `agent_task killed by signal ${result.signal}`,
          };
        } else {
          yield {
            type: 'failed',
            kind: 'permanent',
            error: `agent_task failed to start (is '${config.data.command}' on PATH?)`,
          };
        }
        return;
      }

      yield {
        type: 'succeeded',
        outputs: { output: outLines.join('\n'), exitCode: result.exitCode },
      };
    },
  };
}
