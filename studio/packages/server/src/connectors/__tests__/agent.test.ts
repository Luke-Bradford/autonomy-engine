import { describe, expect, it, vi } from 'vitest';
import { AGENT_STRUCTURED_CLOSE, AGENT_STRUCTURED_OPEN } from '@autonomy-studio/shared';
import { createAgentAdapter, renderCliPrompt } from '../agent.js';
import { MAX_RETRY_AFTER_SECONDS } from '../llm-shared.js';
import { sha256Hex } from '../../util/hash.js';
import type { ActivityContext, ActivityEvent } from '../types.js';
import type {
  OutputLineEvent,
  SpawnSupervisedOptions,
  SupervisedProcess,
  SupervisedResult,
  Supervisor,
} from '../../workers/process-supervisor.js';

async function drain(stream: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function ctx(over: Partial<ActivityContext> = {}): ActivityContext {
  return {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType: over.activityType ?? 'agent_task',
    input: over.input ?? { task: 'do the thing' },
    connectionConfig: over.connectionConfig ?? { command: 'claude' },
    signal: over.signal ?? new AbortController().signal,
  };
}

/** An `llm_call` context on a CLI connection — the `agent_cli` adapter's other
 * invocation shape. Shared by every `llm_call` describe block (the trailing
 * `...over` is what applies the caller's overrides). */
function llmCtx(over: Partial<ActivityContext> = {}): ActivityContext {
  return ctx({
    activityType: 'llm_call',
    connectionConfig: { command: 'claude', args: ['-p'] },
    input: { prompt: 'Say hi' },
    ...over,
  });
}

/** The `metered` fact every `agent_cli` invocation emits when no model is named
 * — one literal, so a drift in the provider/status labels fails every assertion
 * at once rather than only the ones a change happened to touch (#797). */
const UNPRICED_CLI = {
  type: 'metered',
  usage: { provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' },
};

/** A fake Supervisor that replays fixed line events + a fixed result. */
function fakeSupervisor(
  lines: OutputLineEvent[],
  result: Partial<SupervisedResult>,
): { supervisor: Supervisor; spawnArgs: SpawnSupervisedOptions[] } {
  const spawnArgs: SpawnSupervisedOptions[] = [];
  const supervisor: Supervisor = {
    spawnSupervised(opts: SpawnSupervisedOptions): SupervisedProcess {
      spawnArgs.push(opts);
      const events: AsyncIterable<OutputLineEvent> = {
        async *[Symbol.asyncIterator]() {
          for (const l of lines) yield l;
        },
      };
      const full: SupervisedResult = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        killed: false,
        truncated: false,
        ...result,
      };
      return { events, result: Promise.resolve(full) };
    },
    reapAllSupervised: () => Promise.resolve(),
  };
  return { supervisor, spawnArgs };
}

describe('createAgentAdapter().runActivity', () => {
  it('spawns command + args + task, collects stdout, succeeds with exitCode 0', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'working...' },
        { stream: 'stderr', line: 'noise' },
        { stream: 'stdout', line: 'done' },
      ],
      { exitCode: 0 },
    );
    const adapter = createAgentAdapter(supervisor);

    const events = await drain(
      adapter.runActivity(
        ctx({ connectionConfig: { command: 'claude', args: ['-p'] }, input: { task: 'ship it' } }),
        null,
      ),
    );

    // #2 L11a — the subprocess telemetry fact is ordered BEFORE the terminal.
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: {
        summary: 'completed',
        exitCode: 0,
        outputChars: 'working...\ndone'.length,
        outputHash: sha256Hex('working...\ndone'),
      },
    });
    expect((events[0] as { telemetry: { latencyMs: number } }).telemetry.latencyMs).toBeTypeOf(
      'number',
    );
    // stdout shape only — no signal on a clean exit, no raw text.
    expect(events[0]).not.toHaveProperty('telemetry.signal');
    // #797 — the `unpriced` metering fact sits between the telemetry and the
    // terminal (the slot `metered` holds on every other adapter).
    expect(events[1]).toEqual(UNPRICED_CLI);
    expect(events[2]).toEqual({
      type: 'succeeded',
      outputs: { output: 'working...\ndone', exitCode: 0, truncated: false },
    });
    expect(events).toHaveLength(3);
    expect(spawnArgs[0]!.command).toBe('claude');
    // Static args precede the task, which is the final argv element.
    expect(spawnArgs[0]!.args).toEqual(['-p', 'ship it']);
  });

  it('injects the resolved secret into the configured env var, never argv', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const adapter = createAgentAdapter(supervisor);
    await drain(
      adapter.runActivity(
        ctx({
          connectionConfig: {
            command: 'claude',
            secretEnv: 'ANTHROPIC_API_KEY',
            env: { FOO: 'bar' },
          },
          input: { task: 't' },
        }),
        'sk-agent-secret',
      ),
    );
    const opts = spawnArgs[0]!;
    expect(opts.env).toEqual({ FOO: 'bar', ANTHROPIC_API_KEY: 'sk-agent-secret' });
    expect(JSON.stringify(opts.args)).not.toContain('sk-agent-secret');
  });

  it('a non-zero exit is STILL succeeded (exit code is data the pipeline branches on)', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'partial' }], { exitCode: 2 });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    // Completed on its own → telemetry `summary: completed` carrying the real exit
    // code, ordered before the (still-succeeded) terminal.
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'completed', exitCode: 2, outputChars: 'partial'.length },
    });
    // #797 — a non-zero exit is a COMPLETED agent_task, so it is metered.
    expect(events[1]).toEqual(UNPRICED_CLI);
    expect(events[2]).toEqual({
      type: 'succeeded',
      outputs: { output: 'partial', exitCode: 2, truncated: false },
    });
    expect(events).toHaveLength(3);
  });

  it('maps a timeout to a transient failure (telemetry summary=timedOut precedes it)', async () => {
    const { supervisor } = fakeSupervisor([], {
      exitCode: null,
      timedOut: true,
      killed: true,
      signal: 'SIGTERM',
    });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    // `killed` is a superset flag the supervisor sets alongside `timedOut`; the
    // classification must NOT misread it as `summary: killed`.
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'timedOut', exitCode: null, signal: 'SIGTERM' },
    });
    expect(events.find((e) => e.type === 'failed')).toMatchObject({
      type: 'failed',
      kind: 'transient',
    });
  });

  it('captures the PARTIAL stdout SHAPE of a timed-out subprocess (the failure-path value-add)', async () => {
    // The whole point of L11a: on a failure that today yields ONLY `node.failed`,
    // the partial output shape + exit code + latency are still observable.
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'started work' },
        { stream: 'stdout', line: 'made progress' },
      ],
      { exitCode: null, timedOut: true, killed: true },
    );
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    const partial = 'started work\nmade progress';
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: {
        summary: 'timedOut',
        outputChars: partial.length,
        outputHash: sha256Hex(partial),
      },
    });
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'transient' });
  });

  it('maps an abort to a cancelled failure (telemetry summary=aborted precedes it)', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, aborted: true, killed: true });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'aborted' },
    });
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'cancelled' });
  });

  it('maps a failure-to-start (null exit, no signal, not killed) to permanent', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, signal: null });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    // No stdout → `outputHash` OMITTED (fail-closed, never hash('')).
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'spawnFailed', exitCode: null, outputChars: 0 },
    });
    expect(events[0]).not.toHaveProperty('telemetry.outputHash');
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'permanent' });
  });

  it('maps a server-shutdown reap (killed by us, neither aborted nor timed out) to killed/cancelled', async () => {
    // The `reapAllSupervised` path: the supervisor set `killed:true` on its own
    // (tree-killed on shutdown) without the run aborting or the wall-clock firing.
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'was working' }], {
      exitCode: null,
      killed: true,
      signal: 'SIGTERM',
    });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'killed', exitCode: null, signal: 'SIGTERM' },
    });
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'cancelled' });
  });

  it('maps an external kill signal (null exit, signal set, not killed by us) to signalled/transient', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, signal: 'SIGKILL', killed: false });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: { summary: 'signalled', exitCode: null, signal: 'SIGKILL' },
    });
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'transient' });
  });

  it('rejects a config with no command as a permanent failure (no spawn)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: {} }), null),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // #1175 — one line naming the missing field, not Zod 4's JSON blob.
    const error = (events[0] as { error: string }).error;
    expect(error).toMatch(/^invalid agent_cli connection config: [^\n]+$/);
    expect(error).toContain('command: ');
    expect(spawnArgs).toHaveLength(0);
  });

  it('passes cwd (input overrides connection default) and timeout to the supervisor', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: { command: 'claude', cwd: '/base', timeoutMs: 5000 },
          input: { task: 't', cwd: '/override' },
        }),
        null,
      ),
    );
    expect(spawnArgs[0]!.cwd).toBe('/override');
    expect(spawnArgs[0]!.timeoutMs).toBe(5000);
  });

  it('applies a default wall-clock timeout when the connection sets none', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    // A hung agent must never permanently hold a worker-pool slot.
    expect(spawnArgs[0]!.timeoutMs).toBeGreaterThan(0);
    expect(spawnArgs[0]!.timeoutMs).toBe(30 * 60_000);
  });

  it('strips the harness master-key env vars from the child (even if config sets them)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: {
            command: 'claude',
            // A malicious/misconfigured connection can't smuggle the key back in.
            env: { AUTONOMY_MASTER_KEY: 'sneaky', KEEP: 'yes' },
          },
        }),
        null,
      ),
    );
    const env = spawnArgs[0]!.env!;
    expect(env.AUTONOMY_MASTER_KEY).toBeUndefined();
    expect(env.AUTONOMY_MASTER_KEY_FILE).toBeUndefined();
    expect(env.KEEP).toBe('yes');
  });

  it('captures every stdout line even when result resolves before the stream drains', async () => {
    // The real supervisor closes the output stream inside the same turn that
    // resolves `result`; the adapter must `await` the drain, not race it.
    const supervisor: Supervisor = {
      spawnSupervised(): SupervisedProcess {
        const events: AsyncIterable<OutputLineEvent> = {
          async *[Symbol.asyncIterator]() {
            // Lines arrive asynchronously, interleaved with the event loop.
            for (const line of ['a', 'b', 'c']) {
              await Promise.resolve();
              yield { stream: 'stdout' as const, line };
            }
          },
        };
        return {
          events,
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            killed: false,
            truncated: false,
          }),
        };
      },
      reapAllSupervised: () => Promise.resolve(),
    };
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events.find((e) => e.type === 'succeeded')).toEqual({
      type: 'succeeded',
      outputs: { output: 'a\nb\nc', exitCode: 0, truncated: false },
    });
    // Telemetry fingerprints the fully-drained stdout (not a mid-drain snapshot).
    expect(events[0]).toMatchObject({
      type: 'agentTelemetry',
      telemetry: {
        summary: 'completed',
        outputChars: 'a\nb\nc'.length,
        outputHash: sha256Hex('a\nb\nc'),
      },
    });
  });

  it('a spawn-failure config error (bad activity input) does NOT emit telemetry (no subprocess ran)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      // `task` is required; an empty task fails validation before any spawn.
      createAgentAdapter(supervisor).runActivity(ctx({ input: { task: '' } }), null),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(events.some((e) => e.type === 'agentTelemetry')).toBe(false);
    expect(spawnArgs).toHaveLength(0);
  });

  // #2 L11b — OPT-IN structured output: a declared outputSchema makes the fenced
  // stdout block the success contract.
  describe('structured output (#2 L11b)', () => {
    const outputSchema = {
      type: 'object',
      properties: { verdict: { type: 'string' }, score: { type: 'number' } },
    };
    const block = (json: string) => [
      { stream: 'stdout' as const, line: 'thinking about it...' },
      { stream: 'stdout' as const, line: AGENT_STRUCTURED_OPEN },
      { stream: 'stdout' as const, line: json },
      { stream: 'stdout' as const, line: AGENT_STRUCTURED_CLOSE },
    ];

    it('extracts + validates the fenced block into TYPED outputs (schema fields only, no output/exitCode)', async () => {
      const { supervisor, spawnArgs } = fakeSupervisor(block('{"verdict":"pass","score":9}'), {
        exitCode: 0,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      // Telemetry STILL precedes the terminal (exit code stays observable there).
      expect(events[0]).toMatchObject({ type: 'agentTelemetry', telemetry: { exitCode: 0 } });
      expect(events[1]).toEqual(UNPRICED_CLI);
      expect(events[2]).toEqual({ type: 'succeeded', outputs: { verdict: 'pass', score: 9 } });
      expect(events).toHaveLength(3);
      // The structured instruction (naming the sentinels) is appended to the task argv.
      const finalArg = spawnArgs[0]!.args!.at(-1)!;
      expect(finalArg).toContain('review');
      expect(finalArg).toContain(AGENT_STRUCTURED_OPEN);
    });

    it('resolves the LAST complete block when an earlier one appears in the transcript', async () => {
      const { supervisor } = fakeSupervisor(
        [
          { stream: 'stdout', line: AGENT_STRUCTURED_OPEN },
          { stream: 'stdout', line: '{"verdict":"draft","score":1}' },
          { stream: 'stdout', line: AGENT_STRUCTURED_CLOSE },
          { stream: 'stdout', line: 'on reflection, final answer:' },
          ...block('{"verdict":"final","score":10}'),
        ],
        { exitCode: 0 },
      );
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'succeeded')).toEqual({
        type: 'succeeded',
        outputs: { verdict: 'final', score: 10 },
      });
    });

    it('a MISSING block is a permanent failure with a distinct reason', async () => {
      const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'no markers here' }], {
        exitCode: 0,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'failed')).toEqual({
        type: 'failed',
        kind: 'permanent',
        error:
          'agent_task structured output invalid: no valid structured output block found in stdout',
      });
      expect(events.some((e) => e.type === 'succeeded')).toBe(false);
    });

    it('ignores a TRAILING instruction-echo block (non-JSON) after the real answer', async () => {
      // A chatty agent may restate the instruction (which names both markers) AFTER
      // its answer; that echo forms a complete but non-JSON block. It must NOT shadow
      // the real answer and fail an otherwise-valid run.
      const { supervisor } = fakeSupervisor(
        [
          ...block('{"verdict":"pass","score":7}'),
          { stream: 'stdout', line: 'Done. (I wrapped it as instructed between the markers.)' },
          { stream: 'stdout', line: AGENT_STRUCTURED_OPEN },
          { stream: 'stdout', line: 'and' },
          { stream: 'stdout', line: AGENT_STRUCTURED_CLOSE },
        ],
        { exitCode: 0 },
      );
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'succeeded')).toEqual({
        type: 'succeeded',
        outputs: { verdict: 'pass', score: 7 },
      });
    });

    it('a non-JSON block body is a permanent failure', async () => {
      const { supervisor } = fakeSupervisor(block('not json at all {'), { exitCode: 0 });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'failed')).toMatchObject({
        type: 'failed',
        kind: 'permanent',
        error: expect.stringContaining('agent_task structured output invalid'),
      });
    });

    it('a schema-mismatching block (missing required field) is a permanent failure', async () => {
      const { supervisor } = fakeSupervisor(block('{"verdict":"pass"}'), { exitCode: 0 });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'failed')).toMatchObject({
        type: 'failed',
        kind: 'permanent',
      });
      expect(events.some((e) => e.type === 'succeeded')).toBe(false);
    });

    it('a failure-to-COMPLETE (timeout) stays transient even with an outputSchema', async () => {
      const { supervisor } = fakeSupervisor(block('{"verdict":"pass","score":9}'), {
        exitCode: null,
        timedOut: true,
        killed: true,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ input: { task: 'review', outputSchema } }),
          null,
        ),
      );
      // Structured mode reinterprets only a COMPLETED process; a timeout is unchanged.
      expect(events.find((e) => e.type === 'failed')).toMatchObject({
        type: 'failed',
        kind: 'transient',
      });
    });

    it('never echoes child stdout (a secret in an invalid block) into the durable failure', async () => {
      const secret = 'sk-agent-secret-xyz';
      const { supervisor } = fakeSupervisor(
        block(`{"verdict":"${secret}"` /* unterminated → invalid JSON */),
        { exitCode: 0 },
      );
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({
            connectionConfig: { command: 'claude', secretEnv: 'ANTHROPIC_API_KEY' },
            input: { task: 'review', outputSchema },
          }),
          secret,
        ),
      );
      const failed = events.find((e) => e.type === 'failed') as { error: string };
      expect(failed.error).not.toContain(secret);
    });
  });
});

describe('createAgentAdapter().testConnection', () => {
  it('validates config without spawning', async () => {
    const spawn = vi.fn();
    const supervisor: Supervisor = {
      spawnSupervised: spawn as unknown as Supervisor['spawnSupervised'],
      reapAllSupervised: () => Promise.resolve(),
    };
    expect(
      await createAgentAdapter(supervisor).testConnection({ command: 'claude' }, null),
    ).toEqual({
      ok: true,
      probed: 'config',
    });
    expect(await createAgentAdapter(supervisor).testConnection({}, null)).toMatchObject({
      ok: false,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

// #2 L14b — the SAME `agent_cli` adapter also serves the `llm_call` activity: a
// CLI/subscription single-shot (`claude -p`/`codex exec` → stdout). The completion
// is metered `unpriced` (a flat/covered seat pays for it — no per-token price BY
// DESIGN), making L14a's inert `unpriced` status LIVE.
describe('createAgentAdapter().runActivity — llm_call (CLI/subscription single-shot)', () => {
  it('spawns the prompt as the final argv element and captures stdout as `text`', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'Hi there' },
        { stream: 'stderr', line: 'some log noise' },
      ],
      { exitCode: 0 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          connectionConfig: { command: 'claude', args: ['-p'] },
          input: { prompt: 'Say hi' },
        }),
        null,
      ),
    );

    // metered (unpriced) is ordered BEFORE the terminal, mirroring the API adapters.
    expect(events).toEqual([
      UNPRICED_CLI,
      { type: 'succeeded', outputs: { text: 'Hi there', stopReason: 'unknown' } },
    ]);
    // The prompt is the final argv element (never argv-leaked flags).
    expect(spawnArgs[0]!.args).toEqual(['-p', 'Say hi']);
  });

  it('emits NO agentTelemetry (that fact is agent_task-only, not the llm_call shape)', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'Hi' }], { exitCode: 0 });
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    expect(events.some((e) => e.type === 'agentTelemetry')).toBe(false);
  });

  it('stamps NO token counts and NO price fields on the unpriced metered event', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'out' }], { exitCode: 0 });
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    const metered = events.find((e) => e.type === 'metered');
    expect(metered).toBeDefined();
    // usage is a fact but a CLI gives none; ALL price/token fields stay absent.
    expect(metered).toEqual(UNPRICED_CLI);
  });

  it('resolves the metered model node < connection < the `cli` fallback', async () => {
    // node model wins
    const a = await drain(
      createAgentAdapter(fakeSupervisor([], { exitCode: 0 }).supervisor).runActivity(
        llmCtx({
          connectionConfig: { command: 'claude', model: 'connection-model' },
          input: { prompt: 'x', model: 'node-model' },
        }),
        null,
      ),
    );
    expect(a.find((e) => e.type === 'metered')).toMatchObject({
      usage: { model: 'node-model' },
    });
    // connection model when the node omits one
    const b = await drain(
      createAgentAdapter(fakeSupervisor([], { exitCode: 0 }).supervisor).runActivity(
        llmCtx({
          connectionConfig: { command: 'claude', model: 'connection-model' },
          input: { prompt: 'x' },
        }),
        null,
      ),
    );
    expect(b.find((e) => e.type === 'metered')).toMatchObject({
      usage: { model: 'connection-model' },
    });
  });

  it('a present-but-empty completion (exit 0, empty stdout) still succeeds with text:""', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    expect(events).toEqual([
      UNPRICED_CLI,
      { type: 'succeeded', outputs: { text: '', stopReason: 'unknown' } },
    ]);
  });

  it('a non-zero exit is a PERMANENT failure (no completion; do not hot-loop) but IS metered', async () => {
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'partial' },
        { stream: 'stderr', line: 'boom: something broke' },
      ],
      { exitCode: 1 },
    );
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    // #797 — the exit code is the CLIENT WRAPPER's verdict on its whole job, not
    // the provider declining to serve: a CLI routinely exits non-zero AFTER a
    // completed generation. So the invocation is metered; only a quota REFUSAL
    // (below) and a spawn failure are not.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'metered' });
    expect(events[1]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The stderr diagnostic is surfaced in the error.
    expect((events[1] as { error: string }).error).toContain('boom: something broke');
  });

  it('folds a stdout-only diagnostic into a non-zero-exit failure (some CLIs print errors to stdout)', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stdout', line: 'error: model overloaded, try later' }],
      { exitCode: 3 },
    );
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    const failure = events.find((e) => e.type === 'failed');
    expect(failure).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((failure as { error: string }).error).toContain('error: model overloaded, try later');
  });

  it('keeps BOTH the head and tail of an over-long CLI diagnostic (error may be early or late)', async () => {
    const early = 'FATAL: config parse error at line 1';
    const late = 'exhausted all retries, giving up';
    const noise = 'x'.repeat(4000);
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: `${early}${noise}${late}` }], {
      exitCode: 1,
    });
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    const error = (events.find((e) => e.type === 'failed') as { error: string }).error;
    expect(error).toContain(early); // head preserved
    expect(error).toContain(late); // tail preserved
    expect(error).toContain('…'); // middle elided
    expect(error.length).toBeLessThan(1200); // bounded
  });

  it('REDACTS the injected secret out of a non-zero-exit failure error (stderr echo leak)', async () => {
    // A CLI that echoes the injected key in an auth/quota error must never leak it
    // into the durable `node.failed` event.
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'auth failed for key sk-leaky-secret at api.example' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({ connectionConfig: { command: 'claude', args: ['-p'], secretEnv: 'API_KEY' } }),
        'sk-leaky-secret',
      ),
    );
    const failure = events.find((e) => e.type === 'failed');
    expect(failure).toMatchObject({ type: 'failed', kind: 'permanent' });
    const error = (failure as { error: string }).error;
    expect(error).not.toContain('sk-leaky-secret');
    expect(error).toContain('***'); // the secret substring is replaced, not the whole message
  });

  it('rejects a `structured` outputMode on a CLI connection as permanent (no JSON-mode on opaque stdout)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          input: {
            prompt: 'classify this',
            outputMode: 'structured',
            outputSchema: { type: 'object', properties: { category: { type: 'string' } } },
          },
        }),
        null,
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(spawnArgs).toHaveLength(0); // rejected before spawn
  });

  it('rejects declared tools on a CLI connection as permanent (#2 L10a — no tool loop over stdout)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          input: {
            prompt: 'add 1 and 2',
            tools: [
              {
                name: 'adder',
                description: 'Adds two numbers.',
                parameters: {
                  type: 'object',
                  properties: { a: { type: 'number' }, b: { type: 'number' } },
                },
                expression: '${add(tool.args.a, tool.args.b)}',
              },
            ],
          },
        }),
        null,
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    if (events[0]!.type === 'failed') expect(events[0]!.error).toMatch(/tools are not supported/);
    expect(spawnArgs).toHaveLength(0); // rejected before spawn
  });

  it("runs normally when declared tools are parked with toolChoice 'none' (provider parity)", async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([{ stream: 'stdout', line: 'hi' }], {
      exitCode: 0,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          input: {
            prompt: 'add 1 and 2',
            toolChoice: 'none',
            tools: [
              {
                name: 'adder',
                description: 'Adds two numbers.',
                parameters: {
                  type: 'object',
                  properties: { a: { type: 'number' }, b: { type: 'number' } },
                },
                expression: '${add(tool.args.a, tool.args.b)}',
              },
            ],
          },
        }),
        null,
      ),
    );
    expect(events[events.length - 1]).toMatchObject({ type: 'succeeded' });
    expect(spawnArgs).toHaveLength(1); // "tools off" runs the plain single-shot
  });

  it('rejects an invalid llm_call config as a permanent failure (no spawn)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      // neither prompt nor messages
      createAgentAdapter(supervisor).runActivity(llmCtx({ input: {} }), null),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // #1175 — a sentence, and it now names the same config its three sibling
    // adapters name: this site alone said `llm_call config`.
    expect((events[0] as { error: string }).error).toMatch(
      /^invalid llm_call activity config: [^\n]+$/,
    );
    expect(spawnArgs).toHaveLength(0);
  });

  it('maps a timeout to transient and an abort to cancelled (mirrors agent_task)', async () => {
    const t = await drain(
      createAgentAdapter(
        fakeSupervisor([], { exitCode: null, timedOut: true, killed: true }).supervisor,
      ).runActivity(llmCtx(), null),
    );
    // #797 — the abandoned invocation is metered before the terminal.
    expect(t[0]).toMatchObject({ type: 'metered' });
    expect(t[1]).toMatchObject({ type: 'failed', kind: 'transient' });
    const a = await drain(
      createAgentAdapter(
        fakeSupervisor([], { exitCode: null, aborted: true, killed: true }).supervisor,
      ).runActivity(llmCtx(), null),
    );
    expect(a[0]).toMatchObject({ type: 'metered' });
    expect(a[1]).toMatchObject({ type: 'failed', kind: 'cancelled' });
  });

  it('injects the secret into env only, and folds system + messages into one prompt', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([{ stream: 'stdout', line: 'ok' }], {
      exitCode: 0,
    });
    await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          connectionConfig: { command: 'claude', args: ['-p'], secretEnv: 'ANTHROPIC_API_KEY' },
          input: {
            system: 'You are terse.',
            messages: [
              { role: 'user', content: 'What is 2+2?' },
              { role: 'assistant', content: '4' },
              { role: 'user', content: 'And 3+3?' },
            ],
          },
        }),
        'sk-secret',
      ),
    );
    expect(spawnArgs[0]!.env!.ANTHROPIC_API_KEY).toBe('sk-secret');
    const prompt = spawnArgs[0]!.args!.at(-1)!;
    expect(prompt).toBe('You are terse.\n\nUser: What is 2+2?\n\nAssistant: 4\n\nUser: And 3+3?');
    expect(JSON.stringify(spawnArgs[0]!.args)).not.toContain('sk-secret');
  });

  it('rejects an unknown activityType with a loud permanent failure', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({ activityType: 'not_a_real_activity', input: {} }),
        null,
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(spawnArgs).toHaveLength(0);
  });

  // #2 L14c — a subscription CLI's usage quota resets on a rolling window. When a
  // non-zero exit's output matches the connection's configured `quota.exhaustionPattern`,
  // the failure is a quota exhaustion (throttling), NOT a permanent error: emit
  // `rate_limit` (→ engine transient + `code:'rate_limit'`) carrying the reset window
  // as `retryAfterSeconds`, so the existing L7 path arms a retry alarm at reset time
  // instead of hot-looping a doomed subprocess. NO new event/table — the reset window
  // IS the retry alarm's `dueAt`.
  const quotaConfig = {
    command: 'claude',
    args: ['-p'],
    quota: { exhaustionPattern: 'usage limit reached|rate.?limit', resetWindowSeconds: 3600 },
  };

  it('reclassifies a matching non-zero-exit (stderr) as rate_limit + retryAfterSeconds', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'Error: usage limit reached for this account' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(llmCtx({ connectionConfig: quotaConfig }), null),
    );
    // No metering fact (no billable response occurred), one terminal failure.
    expect(events.some((e) => e.type === 'metered')).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'failed',
      kind: 'rate_limit',
      retryAfterSeconds: 3600,
    });
    // The diagnostic is still surfaced (redaction/truncation unchanged).
    expect((events[0] as { error: string }).error).toContain('usage limit reached');
  });

  it('matches the quota pattern against STDOUT too (some CLIs print the quota error to stdout)', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stdout', line: 'you have hit your rate-limit; try again later' }],
      { exitCode: 2 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(llmCtx({ connectionConfig: quotaConfig }), null),
    );
    expect(events[0]).toMatchObject({
      type: 'failed',
      kind: 'rate_limit',
      retryAfterSeconds: 3600,
    });
  });

  it('leaves a non-matching non-zero-exit as PERMANENT (no false-positive retry)', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'Error: invalid argument --frobnicate' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(llmCtx({ connectionConfig: quotaConfig }), null),
    );
    // A non-matching non-zero exit IS metered (#797) — only a quota REFUSAL is not.
    expect(events[0]).toMatchObject({ type: 'metered' });
    expect(events[1]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(events[1]).not.toHaveProperty('retryAfterSeconds');
  });

  it('leaves a non-zero-exit PERMANENT when the connection declares NO quota hint', async () => {
    // Same output that WOULD match a quota pattern, but no pattern is configured.
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'usage limit reached' }], {
      exitCode: 1,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({ connectionConfig: { command: 'claude', args: ['-p'] } }),
        null,
      ),
    );
    expect(events[0]).toMatchObject({ type: 'metered' });
    // The DIAGNOSTIC still reaches the failure, even though no pattern is set.
    // `diagnoseCliExit` builds the stderr+stdout join unconditionally for exactly
    // this reason: the quota verdict is one consumer, the durable failure detail
    // is the other, and the latter does not depend on `quota` being configured.
    // Asserted because its absence makes "short-circuit the join when `quota` is
    // undefined" look like a free optimization — it would blank this message.
    expect(events[1]).toEqual({
      type: 'failed',
      kind: 'permanent',
      error: 'llm_call CLI exited 1: usage limit reached',
    });
  });

  it('still REDACTS the injected secret out of a quota (rate_limit) failure error', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'usage limit reached for key sk-leaky-secret' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({
          connectionConfig: { ...quotaConfig, secretEnv: 'API_KEY' },
        }),
        'sk-leaky-secret',
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'rate_limit' });
    const error = (events[0] as { error: string }).error;
    expect(error).not.toContain('sk-leaky-secret');
    expect(error).toContain('***');
  });

  it('does NOT consult the quota pattern on a successful (exit 0) completion', async () => {
    // A completion whose text happens to contain the quota phrase is a real result,
    // not a failure — the quota check only runs on a non-zero exit.
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'usage limit reached' }], {
      exitCode: 0,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(llmCtx({ connectionConfig: quotaConfig }), null),
    );
    expect(events.map((e) => e.type)).toEqual(['metered', 'succeeded']);
  });
});

// #2 L14c / #799 — the SAME quota classification on the `agent_task` shape. Before
// #799 this shape dropped stderr and mapped every exit code to a COMPLETED run, so
// it could never classify a refusal — which meant it could never ARM the connection
// quota window either (the driver writes that window only off a `node.failed`
// carrying `code:'rate_limit'`). The read side was never the gap: the L14c admission
// gate keys on connection KIND, so an `agent_task` was always throttled by a window
// some sibling `llm_call` had armed. A connection consumed SOLELY by `agent_task`
// nodes simply never armed one.
//
// This is the ONE carve-out to "any exit code is `succeeded`", and it is strictly
// opt-in: it requires the operator to have set `quota.exhaustionPattern`.
describe('#2 L14c / #799 — agent_task quota classification', () => {
  const quotaTaskConfig = {
    command: 'claude',
    quota: { exhaustionPattern: 'usage limit reached|rate.?limit', resetWindowSeconds: 3600 },
  };

  it('reclassifies a matching non-zero-exit (stderr) as rate_limit + retryAfterSeconds', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'Error: usage limit reached for this account' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    // Metered too — this shape does NOT apply `llm_call`'s refusal exclusion (a
    // multi-turn session burns quota before it learns it is out).
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'failed']);
    expect(events[2]).toEqual({
      type: 'failed',
      kind: 'rate_limit',
      error:
        'agent_task CLI exited 1 (quota exhausted): Error: usage limit reached for this account',
      retryAfterSeconds: 3600,
    });
  });

  it('matches the quota pattern against STDOUT too (codex prints its error there)', async () => {
    // Widest surface on this shape: an `agent_task`'s stdout is an arbitrarily long
    // agent transcript, not a single completion, so prose that merely MENTIONS the
    // phrase can trip it — and the window it arms is connection-wide. Kept for
    // symmetry with `llm_call` and because some CLIs have no other error channel;
    // the mitigation is that the pattern is operator-authored and opt-in.
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'hit the rate-limit' }], {
      exitCode: 7,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events[2]).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 3600 });
  });

  it('REDACTS a secret straddling the truncation boundary (redact-then-truncate order)', async () => {
    // The load-bearing ordering inside `cliFailureDetail`: redact the FULL text,
    // THEN elide the middle. Truncating first would cut the secret in half and
    // leave a surviving fragment in a durable, API-served `node.failed`. Sized so
    // the secret sits exactly across the `MAX_CLI_DIAGNOSTIC_CHARS / 2` head
    // boundary, which is the only place the two orderings differ.
    const SECRET = 'sk-straddle-0123456789';
    const PREFIX = 'usage limit reached ';
    // Place the secret's MIDPOINT exactly on the head boundary (half of the 1000
    // cap), so truncate-first would slice it in two and keep the leading half.
    const head = 'A'.repeat(500 - PREFIX.length - Math.floor(SECRET.length / 2));
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: `${PREFIX}${head}${SECRET}${'B'.repeat(900)}` }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: { ...quotaTaskConfig, secretEnv: 'ANTHROPIC_API_KEY' },
        }),
        SECRET,
      ),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    // …and no ≥8-char fragment of it survived the cut either.
    for (let i = 0; i + 8 <= SECRET.length; i += 1) {
      expect(serialized).not.toContain(SECRET.slice(i, i + 8));
    }
    expect(serialized).toContain('***');
  });

  it('orders the diagnostic stderr-BEFORE-stdout', async () => {
    // Documented as deliberate (stderr is the conventional error channel), so the
    // real error leads even when a CLI also printed noise to stdout.
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'transcript tail' },
        { stream: 'stderr', line: 'usage limit reached' },
      ],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect((events[2] as { error: string }).error).toMatch(
      /usage limit reached[\s\S]*transcript tail/,
    );
  });

  it('leaves a NON-matching non-zero exit as succeeded — the carve-out stays narrow', async () => {
    // The "exit code is data" contract survives everywhere the pattern does not hit.
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'compile error' }], {
      exitCode: 2,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'succeeded']);
    expect(events[2]).toMatchObject({ outputs: { exitCode: 2 } });
  });

  // The pattern is matched against a BOUNDED excerpt, not the whole transcript
  // (`MAX_CLI_MATCH_CHARS` = 64k, head + tail). `RegExp.test` is synchronous, and
  // an `agent_task` transcript runs to `maxOutputBytes` (10 MB default), so an
  // unbounded scan stalls the server's only thread on every failed node — a cost
  // the single-completion `llm_call` shape never had. These three pin the bound's
  // shape: what it deliberately stops seeing, what it must still see, and that
  // eliding the middle cannot FORGE a match across the seam.
  const overCap = (head: string, tail: string, gap = 100) =>
    `${'x'.repeat(32_000 - head.length)}${head}${'z'.repeat(gap)}${tail}${'y'.repeat(32_000 - tail.length)}`;

  it('does NOT match a pattern buried in the elided MIDDLE of an over-cap transcript', async () => {
    // The deliberate narrowing. A refusal 40k chars deep in an 80k transcript is
    // not the reason the process exited; the exit reason is at one end or the
    // other. Costs a mid-transcript mention, buys a bounded scan.
    const { supervisor } = fakeSupervisor(
      [
        {
          stream: 'stdout',
          line: `${'x'.repeat(40_000)}usage limit reached${'y'.repeat(40_000)}`,
        },
      ],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'succeeded']);
  });

  it('STILL matches a refusal in the TAIL of an over-cap transcript — the cap must not miss real ones', async () => {
    // The half that matters for #799: a CLI prints why it is exiting LAST, so a
    // cap that dropped the tail would reopen the hot loop this ticket closed.
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stdout', line: `${'x'.repeat(80_000)}\nError: usage limit reached` }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events[2]).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 3600 });
  });

  it('does NOT forge a match across the elision seam (head + tail are not spliced bare)', async () => {
    // `headTailExcerpt`'s marker is load-bearing, not decoration: a head ending
    // 'usage li' spliced onto a tail starting 'mit reached' would invent a quota
    // refusal — and arm a connection-wide window — out of two unrelated fragments.
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stdout', line: overCap('usage li', 'mit reached') }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'succeeded']);
  });

  it('does NOT consult the quota pattern on a successful (exit 0) completion', async () => {
    // A clean run whose transcript happens to discuss rate limits is NOT a refusal.
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'usage limit reached' }], {
      exitCode: 0,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(ctx({ connectionConfig: quotaTaskConfig }), null),
    );
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'succeeded']);
  });

  it('classifies the refusal BEFORE structured mode can misdiagnose it as permanent', async () => {
    // A quota-refused STRUCTURED run has no fenced block, so ordering the terminal
    // after the structured branch would report "no valid structured output block
    // found in stdout" — a content complaint about a call that never ran.
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'usage limit reached' }], {
      exitCode: 1,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: quotaTaskConfig,
          input: {
            task: 'do the thing',
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        }),
        null,
      ),
    );
    expect(events[2]).toMatchObject({ kind: 'rate_limit' });
    expect(JSON.stringify(events)).not.toContain('structured output block');
  });

  it('REDACTS the injected secret out of an agent_task quota failure error', async () => {
    // The refusal text is persisted to `run_events` and served over the API, and a
    // CLI commonly echoes the injected key in an auth/quota error.
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stderr', line: 'usage limit reached (key sk-agent-secret)' }],
      { exitCode: 1 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: { ...quotaTaskConfig, secretEnv: 'ANTHROPIC_API_KEY' },
          input: { task: 'do the thing' },
        }),
        'sk-agent-secret',
      ),
    );
    expect(events[2]).toMatchObject({ kind: 'rate_limit' });
    expect(JSON.stringify(events)).not.toContain('sk-agent-secret');
  });

  it('leaves a non-zero exit succeeded when the connection declares NO quota hint', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'usage limit reached' }], {
      exitCode: 1,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({ connectionConfig: { command: 'claude' } }),
        null,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'succeeded']);
  });
});

// #2 L14c — the connection `config.quota` hint is validated at the boundary (save /
// dispatch): an un-compilable regex or an out-of-range window is refused with a clear
// error rather than throwing later at the failure emit.
describe('#816 — per-shape quota classification scope (quota.classifyActivityTypes)', () => {
  const PATTERN = 'usage limit reached';
  /** A quota hint scoped to `shapes`; omit `shapes` for the unscoped default. */
  function quotaConfig(shapes?: readonly string[]) {
    return {
      command: 'claude',
      quota: {
        exhaustionPattern: PATTERN,
        resetWindowSeconds: 3600,
        ...(shapes !== undefined ? { classifyActivityTypes: shapes } : {}),
      },
    };
  }
  /** A completed non-zero exit whose stderr carries a genuine refusal. */
  function refusingSupervisor() {
    return fakeSupervisor([{ stream: 'stderr', line: `Error: ${PATTERN}` }], { exitCode: 1 });
  }

  it('scoped to llm_call ONLY: an agent_task refusal is NOT classified — exit-code-is-data survives', async () => {
    const { supervisor } = refusingSupervisor();
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({ connectionConfig: quotaConfig(['llm_call']) }),
        null,
      ),
    );
    // The #799 carve-out is scoped OUT, so this shape falls back to its default
    // contract: any exit code is data the graph branches on.
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('scoped to agent_task: an agent_task refusal IS still classified (the positive leg)', async () => {
    const { supervisor } = refusingSupervisor();
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({ connectionConfig: quotaConfig(['agent_task']) }),
        null,
      ),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 3600 });
  });

  it('scoped to agent_task ONLY: an llm_call refusal stays `permanent` AND becomes METERED', async () => {
    const { supervisor } = refusingSupervisor();
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({ connectionConfig: quotaConfig(['agent_task']) }),
        null,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The SECOND consequence of scoping `llm_call` out, named because it is not
    // obvious: `quotaHit` also drives this shape's metering EXCLUSION (a refused
    // call was never served). With no verdict there is nothing to except, so the
    // invocation is metered — the over-mark direction `cliSpendFact` prefers.
    expect(events.some((e) => e.type === 'metered')).toBe(true);
  });

  it('ABSENT classifyActivityTypes: BOTH shapes still classify — no behaviour change on upgrade', async () => {
    const agentEvents = await drain(
      createAgentAdapter(refusingSupervisor().supervisor).runActivity(
        ctx({ connectionConfig: quotaConfig() }),
        null,
      ),
    );
    expect(agentEvents.at(-1)).toMatchObject({ kind: 'rate_limit' });
    const llmEvents = await drain(
      createAgentAdapter(refusingSupervisor().supervisor).runActivity(
        llmCtx({ connectionConfig: quotaConfig() }),
        null,
      ),
    );
    expect(llmEvents.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('a scoped-out shape still reports the full stderr+stdout diagnostic on its failure', async () => {
    // Scoping narrows WHICH SHAPE carries a quota verdict, never what a failure
    // is allowed to say. `llm_call`'s `permanent` error must still fold both
    // channels, or the narrowing would degrade every diagnostic it touches.
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stderr', line: 'boom on stderr' },
        { stream: 'stdout', line: 'context on stdout' },
      ],
      { exitCode: 3 },
    );
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        llmCtx({ connectionConfig: quotaConfig(['agent_task']) }),
        null,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: 'llm_call CLI exited 3: boom on stderr\ncontext on stdout',
    });
  });

  it('a scoped-out STRUCTURED agent_task misdiagnoses a real refusal as `permanent` — the cost, pinned', async () => {
    // "Scoping restores exit-code-is-data" is true only for an OPAQUE agent_task.
    // A STRUCTURED one never had that contract: a quota-refused run emits no
    // fenced block, so with the quota branch scoped out it falls through to the
    // structured branch and is reported `permanent` ("no valid structured output
    // block found") — the misdiagnosis the quota branch is deliberately sited
    // ABOVE to prevent. Not a regression (it is the pre-#799 behaviour), but it
    // is the sharpest edge on the escape hatch, so it is pinned rather than left
    // for an operator to discover.
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: `Error: ${PATTERN}` }], {
      exitCode: 1,
    });
    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          connectionConfig: quotaConfig(['llm_call']),
          input: {
            task: 'review',
            outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
          },
        }),
        null,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(JSON.stringify(events.at(-1))).toContain('structured output');
  });
});

describe('agent_cli config quota hint validation', () => {
  const schema = createAgentAdapter(fakeSupervisor([], {}).supervisor).configSchema;

  it('accepts a valid quota hint', () => {
    const r = schema.safeParse({
      command: 'claude',
      quota: { exhaustionPattern: 'rate limit', resetWindowSeconds: 3600 },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an un-compilable exhaustionPattern regex', () => {
    const r = schema.safeParse({
      command: 'claude',
      quota: { exhaustionPattern: '(', resetWindowSeconds: 60 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-positive resetWindowSeconds', () => {
    expect(
      schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects a resetWindowSeconds above the 24h retry-alarm ceiling (windows > 24h are the deferred admission-gate slice)', () => {
    expect(
      schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: MAX_RETRY_AFTER_SECONDS + 1 },
      }).success,
    ).toBe(false);
    // exactly at the ceiling is allowed
    expect(
      schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: MAX_RETRY_AFTER_SECONDS },
      }).success,
    ).toBe(true);
  });

  it('accepts a classifyActivityTypes scope naming either shape (#816)', () => {
    for (const classifyActivityTypes of [
      ['llm_call'],
      ['agent_task'],
      ['llm_call', 'agent_task'],
    ]) {
      const r = schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: 60, classifyActivityTypes },
      });
      expect(r.success).toBe(true);
    }
  });

  it('REFUSES an EMPTY classifyActivityTypes — "classify nothing" must not be spelled obliquely (#816)', () => {
    // An empty scope is an obscure way of writing "delete the quota block", and
    // it silently disarms the hot-loop guard on BOTH shapes. Refuse at the
    // boundary rather than honour a config whose intent cannot be read.
    expect(
      schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: 60, classifyActivityTypes: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown member of classifyActivityTypes (#816)', () => {
    expect(
      schema.safeParse({
        command: 'claude',
        quota: {
          exhaustionPattern: 'x',
          resetWindowSeconds: 60,
          classifyActivityTypes: ['http_request'],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a partial quota hint (both fields required)', () => {
    expect(schema.safeParse({ command: 'claude', quota: { exhaustionPattern: 'x' } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ command: 'claude', quota: { resetWindowSeconds: 60 } }).success).toBe(
      false,
    );
  });
});

describe('renderCliPrompt', () => {
  it('reduces a single user turn with no system to raw content', () => {
    expect(renderCliPrompt({ messages: [{ role: 'user', content: 'hello' }], sampling: {} })).toBe(
      'hello',
    );
  });

  it('prefixes the system prompt and labels a multi-turn transcript', () => {
    expect(
      renderCliPrompt({
        system: 'be terse',
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
        ],
        sampling: {},
      }),
    ).toBe('be terse\n\nUser: q1\n\nAssistant: a1');
  });

  it('keeps a single user turn labelled-free but still prepends a system prompt', () => {
    expect(
      renderCliPrompt({ system: 'sys', messages: [{ role: 'user', content: 'u' }], sampling: {} }),
    ).toBe('sys\n\nu');
  });

  it('is defensive on an empty message list (direct callers) — returns the system or empty', () => {
    expect(renderCliPrompt({ messages: [], sampling: {} })).toBe('');
    expect(renderCliPrompt({ system: 'only sys', messages: [], sampling: {} })).toBe('only sys');
  });
});

// #2 L14 / #797 — a subprocess that RAN spent the subscription's quota, whether or
// not it ever produced a completion. Before this, `agent_cli` metered on a clean
// `llm_call` exit ONLY: every tree-killed/cancelled/signalled CLI, and EVERY
// `agent_task` on every path, burned quota and left no metering fact at all.
//
// The marking rule deliberately DIVERGES from the HTTP adapters' (#725), and the
// divergence is the point: there, an unmarked call is a `costUnknown` fact that
// would flip a run's cost to permanently INCOMPLETE, so a timeout that cannot
// distinguish a >120s generation from a dropped SYN stays unmarked. Here the fact
// is `unpriced`, which never flips `complete` — so the fail directions are
// asymmetric (over-mark = one extra `responseCount`; under-mark = the quota signal
// is lost). The evidence is also a little stronger — a spawned process is a
// process that ran — but only a little: a spawn is not proof a request reached
// the provider, so the asymmetric fail direction is what carries the rule.
describe('agent_cli subscription metering on abnormal termination (#797)', () => {
  describe('agent_task', () => {
    it('meters a timed-out agent_task, ordered AFTER the telemetry and BEFORE the failure', async () => {
      const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'started work' }], {
        exitCode: null,
        timedOut: true,
        killed: true,
      });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'failed']);
      expect(events[1]).toEqual(UNPRICED_CLI);
    });

    // THE headline case, and the one a stdout-presence gate would silently miss: a
    // single-shot CLI flushes its completion at the END, so the longest, most
    // expensive run — killed at the wall-clock ceiling — is exactly the one with no
    // stdout to show for it.
    it('meters a timed-out agent_task that produced NO stdout (the completion flushes at the END)', async () => {
      const { supervisor } = fakeSupervisor([], {
        exitCode: null,
        timedOut: true,
        killed: true,
      });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('meters an aborted (cancelled) agent_task — the subprocess still ran', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, aborted: true, killed: true });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('meters an externally-signalled agent_task', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, signal: 'SIGKILL' });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('meters a server-shutdown reap (killed) agent_task', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, killed: true });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    // The fail direction: a process that never STARTED cannot have been billed, so
    // marking it would manufacture spend — the mirror of the hole #797 closes.
    it('does NOT meter a spawn failure — no subprocess ran, so nothing was billed', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, signal: null });
      const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
      expect(events.find((e) => e.type === 'agentTelemetry')).toMatchObject({
        telemetry: { summary: 'spawnFailed' },
      });
      expect(events.some((e) => e.type === 'metered')).toBe(false);
    });

    it('does NOT meter a pre-spawn config error (validation failed before any spawn)', async () => {
      const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(ctx({ input: { task: '' } }), null),
      );
      expect(spawnArgs).toHaveLength(0);
      expect(events.some((e) => e.type === 'metered')).toBe(false);
    });

    // `agent_task` treats ANY observed exit code as `succeeded` (the exit code is
    // data the pipeline branches on), so a non-zero exit is a COMPLETED run here —
    // unlike `llm_call`, where it means no completion was produced.
    it('meters a completed agent_task on a zero AND a non-zero exit', async () => {
      for (const exitCode of [0, 3]) {
        const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'done' }], { exitCode });
        const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
        expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
        expect(events.some((e) => e.type === 'succeeded')).toBe(true);
      }
    });

    it('meters a structured-mode agent_task whose fenced block is invalid — the process completed, so it spent', async () => {
      const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'no fenced block here' }], {
        exitCode: 0,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({
            input: {
              task: 'do the thing',
              outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
            },
          }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
      expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'permanent' });
    });

    it('labels the fact with the connection model when one is configured', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, timedOut: true, killed: true });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ connectionConfig: { command: 'claude', model: 'opus-5' } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'metered')).toEqual({
        type: 'metered',
        usage: { provider: 'agent_cli', model: 'opus-5', meteringStatus: 'unpriced' },
      });
    });

    it('treats an EMPTY connection model as absent, exactly as the llm_call shape does', async () => {
      // The schema allows `model: ''` (`z.string().optional()`, no `.min(1)`), and
      // a bare `??` would take it — labelling one connection's `agent_task` facts
      // `''` while its `llm_call` facts (which route through `resolveModel`) say
      // `cli`. One precedence rule, one label, whichever shape ran.
      const { supervisor } = fakeSupervisor([], { exitCode: null, timedOut: true, killed: true });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({ connectionConfig: { command: 'claude', model: '' } }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('METERS a quota-refused agent_task — a session burns quota before it learns it is out', async () => {
      // The asymmetry with `llm_call` (pinned below as UNMETERED) SURVIVES #799,
      // but on a corrected cause. The old rationale was plumbing — "this shape
      // discards stderr and maps every exit code to a COMPLETED run" — and #799
      // removed it: the refusal is classified now. The real reason is the shape:
      // `llm_call` is single-shot and a refusal means nothing was served, whereas
      // an `agent_task` drives a multi-turn session that typically hits the limit
      // MID-session, after real spend. Since the adapter cannot tell that from an
      // already-exhausted t=0 refusal, it errs toward marking: an over-mark costs
      // one spurious `unpriced` response, an under-mark hides real spend.
      const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'usage limit reached' }], {
        exitCode: 1,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          ctx({
            connectionConfig: {
              command: 'claude',
              quota: { exhaustionPattern: 'usage limit reached', resetWindowSeconds: 3600 },
            },
          }),
          null,
        ),
      );
      // The exact emitted SEQUENCE: telemetry, the spend mark, then the classified
      // throttle. Metering and classification are independent decisions here and
      // this pins both — the refusal is metered AND is not a success.
      expect(events.map((e) => e.type)).toEqual(['agentTelemetry', 'metered', 'failed']);
      expect(events[1]).toEqual(UNPRICED_CLI);
      expect(events.find((e) => e.type === 'succeeded')).toBeUndefined();
    });
  });

  describe('llm_call', () => {
    it('meters a timed-out llm_call, ordered BEFORE the transient failure', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, timedOut: true, killed: true });
      const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
      expect(events.map((e) => e.type)).toEqual(['metered', 'failed']);
      expect(events[0]).toEqual(UNPRICED_CLI);
      expect(events[1]).toMatchObject({ kind: 'transient' });
    });

    it('meters an aborted llm_call', async () => {
      const { supervisor } = fakeSupervisor([], { exitCode: null, aborted: true, killed: true });
      const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('does NOT meter an llm_call spawn failure', async () => {
      const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: null, signal: null });
      const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
      expect(events.some((e) => e.type === 'metered')).toBe(false);
      // Pin that the SPAWN-FAILURE exclusion is what suppressed it, not a
      // pre-spawn config rejection: the adapter must have reached the spawn, and
      // the terminal must be the spawn-failure `permanent`. Without this the
      // negative assertion above would still pass if a future schema tightening
      // made `llmCtx()` fail validation before ever spawning.
      expect(spawnArgs).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
      expect((events[0] as { error: string }).error).toContain('claude');
    });

    // A plain non-zero exit IS metered. The HTTP rule does NOT carry over here: a
    // non-2xx is the PROVIDER stating it did not serve the request, whereas an exit
    // code is the client wrapper's verdict on its whole job — routinely non-zero
    // AFTER a completed generation (a post-hoc parse/hook failure, a broken pipe).
    it('meters a non-zero-exit llm_call — an exit code is not the provider declining', async () => {
      const { supervisor } = fakeSupervisor(
        [
          { stream: 'stdout', line: 'partial output' },
          { stream: 'stderr', line: 'boom' },
        ],
        { exitCode: 1 },
      );
      const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
      expect(events.find((e) => e.type === 'metered')).toEqual(UNPRICED_CLI);
    });

    it('leaves a quota-exhaustion (rate_limit) llm_call UNMETERED — the call was refused', async () => {
      const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: 'usage limit reached' }], {
        exitCode: 1,
      });
      const events = await drain(
        createAgentAdapter(supervisor).runActivity(
          llmCtx({
            connectionConfig: {
              command: 'claude',
              quota: { exhaustionPattern: 'usage limit reached', resetWindowSeconds: 300 },
            },
          }),
          null,
        ),
      );
      expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'rate_limit' });
      expect(events.some((e) => e.type === 'metered')).toBe(false);
    });
  });
});

describe('#816 half 1 — quota match SOURCE (quota.matchSource: json-lines)', () => {
  const PATTERN = 'usage limit reached';
  /** An `agent_cli` connection whose CLI is declared to speak JSON-per-line. */
  const jsonLines = (errorEnvelopeTypes: string[], exhaustionPattern = PATTERN) => ({
    command: 'claude',
    quota: {
      exhaustionPattern,
      resetWindowSeconds: 3600,
      matchSource: { format: 'json-lines' as const, errorEnvelopeTypes },
    },
  });
  const runTask = async (lines: { stream: 'stdout' | 'stderr'; line: string }[], config: unknown) =>
    drain(
      createAgentAdapter(fakeSupervisor(lines, { exitCode: 1 }).supervisor).runActivity(
        ctx({ connectionConfig: config as Record<string, unknown> }),
        null,
      ),
    );
  const out = (line: string) => ({ stream: 'stdout' as const, line });

  it('does NOT classify a refusal phrase carried by an agent CONTENT envelope', async () => {
    // #816's archetype, and this repo's own workload: an agent reading logs that
    // discuss quota. Before the declaration this failed the run AND armed a
    // connection-wide admission window.
    const events = await runTask(
      [out(JSON.stringify({ type: 'assistant', text: `the log says "${PATTERN}" here` }))],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('DOES classify the same phrase carried by a declared error envelope', async () => {
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', message: `Error: ${PATTERN} for this account` }))],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 3600 });
  });

  it('never narrows STDERR — a refusal there still classifies under json-lines', async () => {
    // stderr is CLI/API output, never model content, so the narrowing has no
    // business touching it. This is also the mitigation for the dropped-line
    // residual below: a CLI that breaks protocol usually breaks it onto stderr.
    const events = await runTask(
      [
        { stream: 'stderr', line: `Error: ${PATTERN}` },
        out(JSON.stringify({ type: 'assistant', text: 'unrelated' })),
      ],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('DROPS a bare non-JSON stdout line — the accepted false-negative residual, pinned', async () => {
    // Deliberate, not an oversight. Admitting unparseable lines would degrade to
    // the old behaviour exactly on the transcripts this exists for: a capture
    // truncated at `maxOutputBytes` ends in an unparseable CHUNK OF CONTENT,
    // which would then be matched whole.
    const events = await runTask([out(`Error: ${PATTERN}`)], jsonLines(['error']));
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('ABSENT matchSource still matches the whole transcript — no behaviour change on upgrade', async () => {
    const events = await runTask(
      [out(JSON.stringify({ type: 'assistant', text: `the log says "${PATTERN}" here` }))],
      { command: 'claude', quota: { exhaustionPattern: PATTERN, resetWindowSeconds: 3600 } },
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('still REPORTS the excluded transcript in the failure detail — it bounds what is SCANNED', async () => {
    // The narrowing decides what the pattern may READ, never what a failure is
    // allowed to SAY. Same discipline as `MAX_CLI_MATCH_CHARS`.
    // On `llm_call`, because that is the shape whose non-zero exit terminalizes
    // as a failure at all — `agent_task` treats the exit code as data and
    // succeeds, so it has no failure detail to inspect.
    const events = await drain(
      createAgentAdapter(
        fakeSupervisor(
          [
            { stream: 'stderr', line: 'boom' },
            out(JSON.stringify({ type: 'assistant', text: `chatter about ${PATTERN}` })),
          ],
          { exitCode: 1 },
        ).supervisor,
      ).runActivity(llmCtx({ connectionConfig: jsonLines(['error']) }), null),
    );
    const failure = events.find((e) => e.type === 'failed');
    expect(failure).toMatchObject({ kind: 'permanent' });
    expect(JSON.stringify(failure)).toContain(`chatter about ${PATTERN}`);
  });

  it('matches envelope TYPE exactly — a type that merely CONTAINS a declared one is not admitted', async () => {
    // The NESTED `"type":"error"` is what clears the cheap pre-filter (which reads
    // the `type` position but not its depth), so the exact TOP-LEVEL membership is
    // what actually rejects this line. Without that second gate it classifies.
    const events = await runTask(
      [out(JSON.stringify({ type: 'error_summary', meta: { type: 'error' }, message: PATTERN }))],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('excludes the top-level TYPE VALUE from the matched text — the selector is not the evidence', async () => {
    // Otherwise `errorEnvelopeTypes: ['rate_limit_event']` + a `rate.?limit`
    // pattern fires on claude's routine ALLOWED heartbeat, which carries that
    // literal in the very field that selected it (claude.sh needs the envelope
    // AND `rate_limit_info.status == "rejected"`).
    const heartbeat = await runTask(
      [out(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))],
      jsonLines(['rate_limit_event'], 'rate.?limit'),
    );
    expect(heartbeat.at(-1)).toMatchObject({ type: 'succeeded' });
    // …while the REJECTED state, matched on its own words, still classifies.
    const rejected = await runTask(
      [out(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))],
      jsonLines(['rate_limit_event'], 'rejected'),
    );
    expect(rejected.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('matches string LEAVES, not keys — a pattern cannot hit the protocol itself', async () => {
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', message: 'boom' }))],
      jsonLines(['error'], 'message'),
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('matches DECODED text — a pattern needs no JSON escaping to reach it', async () => {
    // The raw line carries `\"` and `\n`; the pattern is written against what the
    // CLI actually said. Matching the raw line would silently require the author
    // to escape for a wire format they never chose.
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', message: `it said "${PATTERN}"\ngiving up` }))],
      jsonLines(['error'], `said "${PATTERN}"`),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('reaches a leaf nested inside the envelope', async () => {
    const events = await runTask(
      [out(JSON.stringify({ type: 'turn.failed', error: { detail: [{ text: PATTERN }] } }))],
      jsonLines(['turn.failed']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('a FORGED envelope on raw stdout still classifies — narrowed, not closed', async () => {
    // Pinned as accepted residual, not as a win: the filter cuts the accidental
    // mention (the archetype), never a deliberate forgery by a passthrough tool.
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', message: PATTERN }))],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('survives an over-cap transcript that would ELIDE the refusal under text matching', async () => {
    // Narrowing runs BEFORE `MAX_CLI_MATCH_CHARS`, so a huge content body can no
    // longer push a real envelope into the elided middle. The same input under
    // `text` (below) loses it — that contrast is the point.
    const filler = () => out(JSON.stringify({ type: 'assistant', text: 'x'.repeat(1_000) }));
    const lines = [
      ...Array.from({ length: 40 }, filler),
      out(JSON.stringify({ type: 'error', message: PATTERN })),
      ...Array.from({ length: 40 }, filler),
    ];
    expect((await runTask(lines, jsonLines(['error']))).at(-1)).toMatchObject({
      kind: 'rate_limit',
    });
    const asText = await runTask(lines, {
      command: 'claude',
      quota: { exhaustionPattern: PATTERN, resetWindowSeconds: 3600 },
    });
    expect(asText.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('bounds the parse work — candidate lines are consumed from the END backwards', async () => {
    // A 10 MB transcript whose every line names a declared type would otherwise be
    // JSON.parsed in full, synchronously, on the server's only thread. The budget
    // keeps the envelopes NEAREST the exit, so a refusal beyond it is missed —
    // stated, tested, and orders of magnitude past any real refusal stream.
    // The decoys are REAL declared envelopes, because the pre-filter keys on the
    // `type` POSITION — that tightening is what stops unrelated protocol lines
    // (`{"type":"item.completed","error":null}`) from eating the budget. They
    // carry no refusal text, so only the budget can decide this test.
    const decoy = out(JSON.stringify({ type: 'error', message: 'y'.repeat(9_000) }));
    const refusal = out(JSON.stringify({ type: 'error', message: PATTERN }));
    const flood = Array.from({ length: 140 }, () => decoy);
    expect((await runTask([refusal, ...flood], jsonLines(['error']))).at(-1)).toMatchObject({
      type: 'succeeded',
    });
    // …and the same refusal at the END, inside the budget, still classifies.
    expect((await runTask([...flood, refusal], jsonLines(['error']))).at(-1)).toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('does not let UNRELATED protocol lines starve the budget of real envelopes', async () => {
    // `"error"` is an ordinary KEY in events that are not error envelopes
    // (`{"type":"item.completed","error":null}`). Keying the pre-filter on the
    // `type` POSITION is what keeps them off the parse budget — otherwise a long
    // transcript charges 1 MB of non-envelopes and the real refusal at the head is
    // dropped, turning a cost bound into a wrong verdict.
    const noise = out(
      JSON.stringify({ type: 'item.completed', error: null, text: 'y'.repeat(9_000) }),
    );
    const refusal = out(JSON.stringify({ type: 'error', message: PATTERN }));
    const events = await runTask(
      [refusal, ...Array.from({ length: 140 }, () => noise)],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('applies to llm_call too — the source is a fact about the CLI, not about the shape', async () => {
    const events = await drain(
      createAgentAdapter(
        fakeSupervisor([out(JSON.stringify({ type: 'assistant', text: `mentions ${PATTERN}` }))], {
          exitCode: 1,
        }).supervisor,
      ).runActivity(llmCtx({ connectionConfig: jsonLines(['error']) }), null),
    );
    expect(events.find((e) => e.type === 'failed')).toMatchObject({ kind: 'permanent' });
  });

  it('degrades an OVER-CAP declared envelope to a raw excerpt rather than dropping it', async () => {
    // It already matched in the `type` position, so it is a real envelope that is
    // merely too big to parse (a provider error body echoing the request). Dropping
    // it would miss a genuine refusal — the expensive direction.
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', message: `${'z'.repeat(20_000)} ${PATTERN}` }))],
      jsonLines(['error']),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  it('drops a leaf nested past the depth ceiling, and keeps the one just inside it', async () => {
    const nest = (depth: number): unknown => (depth === 0 ? PATTERN : { inner: nest(depth - 1) });
    const at = async (depth: number) =>
      runTask([out(JSON.stringify({ type: 'error', deep: nest(depth) }))], jsonLines(['error']));
    expect((await at(7)).at(-1)).toMatchObject({ kind: 'rate_limit' });
    expect((await at(8)).at(-1)).toMatchObject({ type: 'succeeded' });
  });

  it('does NOT forge a match across the seam between two leaves', async () => {
    // Narrowing DELETES the text between survivors, so joining them bare would let
    // a pattern match across an adjacency that never existed in the output — and
    // would invent a classification `text` matching would not have produced. Same
    // hazard `headTailExcerpt`'s elision marker exists to prevent.
    const events = await runTask(
      [out(JSON.stringify({ type: 'error', a: 'usage limit', b: 'reached' }))],
      jsonLines(['error'], 'usage limit\nreached'),
    );
    expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
  });

  describe('the stderr-only source — the one that needs no protocol from the CLI', () => {
    const stderrOnly = {
      command: 'claude',
      quota: {
        exhaustionPattern: PATTERN,
        resetWindowSeconds: 3600,
        matchSource: { format: 'stderr' as const },
      },
    };

    it('classifies a refusal on stderr', async () => {
      const events = await runTask([{ stream: 'stderr', line: `Error: ${PATTERN}` }], stderrOnly);
      expect(events.at(-1)).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 3600 });
    });

    it('ignores the same phrase anywhere on stdout — including as plain prose', async () => {
      // This is the whole point: it works on the DEFAULT `claude -p` invocation,
      // where there is no JSON protocol to declare. Its cost is the mirror image —
      // a CLI whose only refusal channel is stdout is missed.
      const events = await runTask([out(`the log says ${PATTERN}`)], stderrOnly);
      expect(events.at(-1)).toMatchObject({ type: 'succeeded' });
    });
  });

  it('an explicit text source behaves exactly as an absent one', async () => {
    const events = await runTask([out(`chatter about ${PATTERN}`)], {
      command: 'claude',
      quota: {
        exhaustionPattern: PATTERN,
        resetWindowSeconds: 3600,
        matchSource: { format: 'text' as const },
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: 'rate_limit' });
  });

  describe('schema', () => {
    const schema = createAgentAdapter(fakeSupervisor([], {}).supervisor).configSchema;
    const parse = (matchSource: unknown) =>
      schema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: 'x', resetWindowSeconds: 60, matchSource },
      }).success;

    it('accepts a json-lines source naming its error envelopes', () => {
      expect(parse({ format: 'json-lines', errorEnvelopeTypes: ['error'] })).toBe(true);
    });

    it('accepts an explicit text source', () => {
      expect(parse({ format: 'text' })).toBe(true);
    });

    it('REFUSES json-lines with no errorEnvelopeTypes — it could never classify', () => {
      expect(parse({ format: 'json-lines' })).toBe(false);
      expect(parse({ format: 'json-lines', errorEnvelopeTypes: [] })).toBe(false);
    });

    it('REFUSES errorEnvelopeTypes on a text source rather than silently stripping it', () => {
      // `.optional()` alone would admit both incoherent bodies; the discriminated
      // union of STRICT members refuses them by construction.
      expect(parse({ format: 'text', errorEnvelopeTypes: ['error'] })).toBe(false);
    });

    it('REFUSES an unknown format', () => {
      expect(parse({ format: 'stream-json', errorEnvelopeTypes: ['error'] })).toBe(false);
    });

    it('accepts a stderr-only source, and refuses envelope types on it', () => {
      expect(parse({ format: 'stderr' })).toBe(true);
      expect(parse({ format: 'stderr', errorEnvelopeTypes: ['error'] })).toBe(false);
    });

    it('BOUNDS errorEnvelopeTypes — the pre-filter walk is linear in types x stream', () => {
      const many = Array.from({ length: 33 }, (_, i) => `t${i}`);
      expect(parse({ format: 'json-lines', errorEnvelopeTypes: many })).toBe(false);
      expect(parse({ format: 'json-lines', errorEnvelopeTypes: ['x'.repeat(201)] })).toBe(false);
      expect(parse({ format: 'json-lines', errorEnvelopeTypes: many.slice(0, 32) })).toBe(true);
    });
  });
});

// #1101 — the supervisor bounds an agent child's combined stdout+stderr and
// computes `truncated`; before this the adapter never read it, so a clipped
// transcript reached `${nodes.x.output.output}` reading exactly like a whole one.
describe('#1101 — a transcript clipped at the byte cap says so', () => {
  const warnings = (events: ActivityEvent[]) => events.filter((e) => e.type === 'warned');
  const terminalIndex = (events: ActivityEvent[]) =>
    events.findIndex((e) => e.type === 'succeeded' || e.type === 'failed');

  it('agent_task: yields the advisory BEFORE the terminal and carries the fact into outputs', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'half a transcript' }], {
      exitCode: 0,
      truncated: true,
    });

    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));

    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ type: 'warned', code: 'output_truncated' });
    expect(events.indexOf(warned[0]!)).toBeLessThan(terminalIndex(events));
    // The sentence is durable and unredacted, so it names the CAP, never content.
    const reason = String((warned[0] as { reason: string }).reason);
    expect(reason).not.toContain('half a transcript');
    expect(reason).toContain('agent_task');
    // ...and the fact is branchable: `${nodes.x.output.truncated}`.
    expect(events.at(-1)).toEqual({
      type: 'succeeded',
      outputs: { output: 'half a transcript', exitCode: 0, truncated: true },
    });
  });

  it('agent_task: stays SILENT when nothing was clipped, and still states the fact', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'whole transcript' }], {
      exitCode: 0,
    });

    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));

    expect(warnings(events)).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: 'succeeded',
      outputs: { output: 'whole transcript', exitCode: 0, truncated: false },
    });
  });

  it('agent_task: warns on a FAILED attempt too — the clipping is known before the outcome', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'noise' }], {
      exitCode: null,
      timedOut: true,
      truncated: true,
    });

    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));

    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(events.indexOf(warned[0]!)).toBeLessThan(terminalIndex(events));
    expect(events.at(-1)).toMatchObject({ type: 'failed', kind: 'transient' });
  });

  it('agent_task STRUCTURED: the advisory is the only channel (outputs are schema-derived)', async () => {
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stdout', line: AGENT_STRUCTURED_OPEN },
        { stream: 'stdout', line: '{"verdict":"pass"}' },
        { stream: 'stdout', line: AGENT_STRUCTURED_CLOSE },
      ],
      { exitCode: 0, truncated: true },
    );

    const events = await drain(
      createAgentAdapter(supervisor).runActivity(
        ctx({
          input: {
            task: 'review',
            outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
          },
        }),
        null,
      ),
    );

    expect(warnings(events)).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'succeeded', outputs: { verdict: 'pass' } });
  });

  it('llm_call on a CLI connection: the shape with NO telemetry fact warns too', async () => {
    const { supervisor } = fakeSupervisor([{ stream: 'stdout', line: 'clipped answer' }], {
      exitCode: 0,
      truncated: true,
    });

    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));

    const warned = warnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ type: 'warned', code: 'output_truncated' });
    expect(String((warned[0] as { reason: string }).reason)).toContain('llm_call');
    expect(events.indexOf(warned[0]!)).toBeLessThan(terminalIndex(events));
    // ...and BEFORE the metering fact, as the yield site claims: an abnormal
    // termination must not be able to reorder the two.
    expect(events.indexOf(warned[0]!)).toBeLessThan(events.findIndex((e) => e.type === 'metered'));
    // Its outputs are the SHARED llm contract, so there is no key to carry it.
    expect(events.at(-1)).toEqual({
      type: 'succeeded',
      outputs: { text: 'clipped answer', stopReason: 'unknown' },
    });
  });
});
