import { describe, expect, it, vi } from 'vitest';
import { createAgentAdapter } from '../agent.js';
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

    expect(events).toEqual([
      { type: 'succeeded', outputs: { output: 'working...\ndone', exitCode: 0 } },
    ]);
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
    expect(events).toEqual([{ type: 'succeeded', outputs: { output: 'partial', exitCode: 2 } }]);
  });

  it('maps a timeout to a transient failure', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, timedOut: true, killed: true });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'transient' });
  });

  it('maps an abort to a cancelled failure', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, aborted: true, killed: true });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'cancelled' });
  });

  it('maps a failure-to-start (null exit, no signal, not killed) to permanent', async () => {
    const { supervisor } = fakeSupervisor([], { exitCode: null, signal: null });
    const events = await drain(createAgentAdapter(supervisor).runActivity(ctx(), null));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
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
    expect(events).toEqual([{ type: 'succeeded', outputs: { output: 'a\nb\nc', exitCode: 0 } }]);
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
