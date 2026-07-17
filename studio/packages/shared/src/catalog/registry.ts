import { z } from 'zod';
import type { Output } from '../schemas/pipeline.js';
import { SecretRefSchema } from '../schemas/secret-ref.js';
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

/**
 * The `http_request` secret-SINK config field name (item 7 / S4) — the ONE
 * source of truth. The catalog declares it as a sink here; the server http
 * adapter (`connectors/http.ts`) imports it to derive the `secretFields` key
 * prefix it consumes. Shared so a rename can't silently desync the two sides
 * (a magic string on each would drop the secret header without a type error).
 */
export const HTTP_SECRET_HEADERS_FIELD = 'secretHeaders';

/**
 * The Zod SHAPE of the `secretHeaders` sink value: header name → inert
 * `{$secret:name}` marker. SSOT'd here (not just the field NAME above) so the
 * catalog `configSchema` below and the http adapter's live `httpRequestInputSchema`
 * (`connectors/http.ts`) can't desync on the value/key constraints either — one
 * change to the record shape reaches both consumers, type-checked.
 */
export const httpSecretHeadersSchema = z.record(z.string(), SecretRefSchema).optional();

const ENTRIES: ActivityCatalogEntry[] = [
  {
    type: 'http_request',
    title: 'HTTP Request',
    kind: 'execution',
    category: 'general',
    idempotent: false,
    connectionKinds: ['http'],
    outputs: [out('status', 'number'), out('body', 'string'), out('headers', 'json')],
    // Item 7 / S4 — the FIRST real secret SINK. A `{$secret:name}` marker is
    // permitted only within `secretHeaders` (header name → marker); the save
    // gate (`validateRefs`) refuses one anywhere else, and the http adapter
    // sends the dispatch-resolved plaintext as that header, LAST, never echoed.
    secretSinkFields: [HTTP_SECRET_HEADERS_FIELD],
    configSchema: z.object({
      url: z.string().min(1),
      method: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      // Metadata only (catalog `configSchema` is not a save-time validator — the
      // adapter validates the live request). Documents the sink shape for the UI.
      // Computed key + shared shape (`httpSecretHeadersSchema`) so neither the
      // field name NOR the record shape can desync from the adapter's schema.
      [HTTP_SECRET_HEADERS_FIELD]: httpSecretHeadersSchema,
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
