import { z } from 'zod';
import type { Output } from '../schemas/pipeline.js';
import type { ActivityCatalog, ActivityCatalogEntry } from './types.js';

/**
 * P3 MVP activity catalog. Each entry is STATIC and pure (see
 * `ActivityCatalogEntry`). The executable side (the adapter that actually runs
 * an activity via its connector) lives server-side in `@autonomy-studio/server`
 * — this module is metadata only, so `shared` stays I/O-free and isomorphic.
 *
 * MVP set (per the target architecture): `http_request` (self-contained HTTP),
 * `llm_call` (an LLM provider connection), `agent_task` (an `agent_cli`
 * subprocess). In P3a only `http_request` has a server adapter; `llm_call` /
 * `agent_task` are catalogued (so the UI + reconciler know them) but a run that
 * dispatches one fails LOUDLY at the executor ("no adapter for kind …") until
 * P3b supplies the adapter — never a silent hang.
 *
 * `idempotent` is `false` for every MVP activity: an HTTP call may be a
 * non-GET write, an LLM call may already be billed, an agent subprocess has
 * arbitrary side effects. Fail-safe by default — a crash mid-flight FREEZES the
 * run (`interrupted`) rather than risk a double side effect on resume. A future
 * read-only activity (e.g. a pure `transform`) can opt into `idempotent: true`.
 */

const out = (name: string, type: Output['type']): Output => ({ name, type });

const ENTRIES: ActivityCatalogEntry[] = [
  {
    type: 'http_request',
    title: 'HTTP Request',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['http'],
    outputs: [out('status', 'number'), out('body', 'string'), out('headers', 'json')],
    configSchema: z.object({
      url: z.string().min(1),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    }),
  },
  {
    type: 'llm_call',
    title: 'LLM Call',
    kind: 'execution',
    category: 'ai',
    idempotent: false,
    connectionKinds: ['anthropic_api', 'openai_api', 'ollama'],
    outputs: [out('text', 'string'), out('stopReason', 'string')],
    configSchema: z.object({
      prompt: z.string().min(1),
      system: z.string().optional(),
      model: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().optional(),
    }),
  },
  {
    type: 'agent_task',
    title: 'Agent Task',
    kind: 'execution',
    // Spec #4 files `agent_task` under "Execution — AI (Spec #2)" next to
    // `llm_call`: an external CLI agent is an AI activity, not its own class.
    category: 'ai',
    idempotent: false,
    connectionKinds: ['agent_cli'],
    outputs: [out('output', 'string'), out('exitCode', 'number')],
    configSchema: z.object({
      task: z.string().min(1),
      cwd: z.string().optional(),
    }),
  },
];

/** The MVP activity catalog, keyed by `type`. Frozen (read-only) at module load. */
export const catalog: ActivityCatalog = new Map(ENTRIES.map((e) => [e.type, e]));

/** Look up an activity entry by `type`; `undefined` when the type is unknown. */
export function getActivity(type: string): ActivityCatalogEntry | undefined {
  return catalog.get(type);
}
