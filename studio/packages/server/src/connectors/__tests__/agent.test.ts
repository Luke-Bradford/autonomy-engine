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
    expect(events[1]).toEqual({
      type: 'succeeded',
      outputs: { output: 'working...\ndone', exitCode: 0 },
    });
    expect(events).toHaveLength(2);
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
    expect(events[1]).toEqual({ type: 'succeeded', outputs: { output: 'partial', exitCode: 2 } });
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
      outputs: { output: 'a\nb\nc', exitCode: 0 },
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
      expect(events[1]).toEqual({ type: 'succeeded', outputs: { verdict: 'pass', score: 9 } });
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
  function llmCtx(over: Partial<ActivityContext> = {}): ActivityContext {
    return ctx({
      activityType: 'llm_call',
      connectionConfig: over.connectionConfig ?? { command: 'claude', args: ['-p'] },
      input: over.input ?? { prompt: 'Say hi' },
      ...over,
    });
  }

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
      {
        type: 'metered',
        usage: { provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' },
      },
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
    expect(metered).toEqual({
      type: 'metered',
      usage: { provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' },
    });
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
      {
        type: 'metered',
        usage: { provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' },
      },
      { type: 'succeeded', outputs: { text: '', stopReason: 'unknown' } },
    ]);
  });

  it('a non-zero exit is a PERMANENT failure (no completion; do not hot-loop) with NO metered event', async () => {
    const { supervisor } = fakeSupervisor(
      [
        { stream: 'stdout', line: 'partial' },
        { stream: 'stderr', line: 'boom: quota exhausted' },
      ],
      { exitCode: 1 },
    );
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    // No metering fact — we cannot know a billable response occurred.
    expect(events.some((e) => e.type === 'metered')).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The stderr diagnostic is surfaced in the error.
    expect((events[0] as { error: string }).error).toContain('boom: quota exhausted');
  });

  it('folds a stdout-only diagnostic into a non-zero-exit failure (some CLIs print errors to stdout)', async () => {
    const { supervisor } = fakeSupervisor(
      [{ stream: 'stdout', line: 'error: model overloaded, try later' }],
      { exitCode: 3 },
    );
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toContain('error: model overloaded, try later');
  });

  it('keeps BOTH the head and tail of an over-long CLI diagnostic (error may be early or late)', async () => {
    const early = 'FATAL: config parse error at line 1';
    const late = 'exhausted all retries, giving up';
    const noise = 'x'.repeat(4000);
    const { supervisor } = fakeSupervisor([{ stream: 'stderr', line: `${early}${noise}${late}` }], {
      exitCode: 1,
    });
    const events = await drain(createAgentAdapter(supervisor).runActivity(llmCtx(), null));
    const error = (events[0] as { error: string }).error;
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
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    const error = (events[0] as { error: string }).error;
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

  it('rejects an invalid llm_call config as a permanent failure (no spawn)', async () => {
    const { supervisor, spawnArgs } = fakeSupervisor([], { exitCode: 0 });
    const events = await drain(
      // neither prompt nor messages
      createAgentAdapter(supervisor).runActivity(llmCtx({ input: {} }), null),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(spawnArgs).toHaveLength(0);
  });

  it('maps a timeout to transient and an abort to cancelled (mirrors agent_task)', async () => {
    const t = await drain(
      createAgentAdapter(
        fakeSupervisor([], { exitCode: null, timedOut: true, killed: true }).supervisor,
      ).runActivity(llmCtx(), null),
    );
    expect(t[0]).toMatchObject({ type: 'failed', kind: 'transient' });
    const a = await drain(
      createAgentAdapter(
        fakeSupervisor([], { exitCode: null, aborted: true, killed: true }).supervisor,
      ).runActivity(llmCtx(), null),
    );
    expect(a[0]).toMatchObject({ type: 'failed', kind: 'cancelled' });
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
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(events[0]).not.toHaveProperty('retryAfterSeconds');
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
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
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

// #2 L14c — the connection `config.quota` hint is validated at the boundary (save /
// dispatch): an un-compilable regex or an out-of-range window is refused with a clear
// error rather than throwing later at the failure emit.
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
