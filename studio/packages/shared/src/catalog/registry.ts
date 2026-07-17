import { z } from 'zod';
import type { Output } from '../schemas/pipeline.js';
import { SecretRefSchema } from '../schemas/secret-ref.js';
import type { ActivityCatalog, ActivityCatalogEntry } from './types.js';
import {
  FAIL_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
} from './types.js';
import { llmCallConfigSchema } from './llm-config.js';

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
    // #2 L1 — the SSOT config schema, shared with the three LLM adapters so the
    // palette metadata and the live request validation can never desync (the
    // same shared→server pattern `http_request` uses for `httpSecretHeadersSchema`).
    configSchema: llmCallConfigSchema,
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
  {
    // #4 A1 — the `if` CONTROL activity. `kind:'control'` = engine-evaluated: the
    // reducer routes it STRUCTURALLY by `type` (the `call_pipeline`/`Node.call`
    // precedent), never a connector, so `connectionKinds` is empty and the
    // executor REFUSES a dispatched control node (`CONTROL_NOT_DISPATCHABLE`).
    // `idempotent` is inert for the same reason (nothing dispatches it), and
    // there are no `outputs` — an `if` produces a branch, not data. The
    // `configSchema` is palette metadata; the save-time condition rule is
    // `validateDoc`'s whole-value check. Cataloguing the TYPE (per D6's note)
    // bumped `CATALOG_VERSION` 2→3 so an older build refuses an if-doc it cannot
    // route rather than silently stranding its branch edges.
    type: IF_ACTIVITY_TYPE,
    title: 'If Condition',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ condition: z.string().min(1) }),
  },
  {
    // #4 A2 — the `switch` CONTROL activity. Same engine-evaluated shape as `if`
    // (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on dispatch, no
    // `outputs` — it produces a branch, not data): the reducer routes it
    // STRUCTURALLY by `type`. It matches the `${}` `on` value against declared
    // `cases` labels → the matching case's branch, or the implicit `default`.
    // `configSchema` is palette metadata (not the save-time validator, per the
    // A1 rebuttal — `validateDoc`'s `validateSwitchConfig` is the real gate);
    // `cases` carries no `.min(1)` here for the same reason. Cataloguing the TYPE
    // bumped `CATALOG_VERSION` 3→4 so an older build refuses a switch-doc it
    // cannot route rather than silently stranding its branch edges.
    type: SWITCH_ACTIVITY_TYPE,
    title: 'Switch',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ on: z.string().min(1), cases: z.array(z.string()) }),
  },
  {
    // #4 A7 — the `fail` CONTROL activity. Same engine-evaluated shape as `if`/
    // `switch` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE `if`/`switch`
    // it produces a FAILURE, not a branch — a ready `fail` resolves its `${}`
    // `message` PURELY and holds `ready` while the driver appends `node.failed`
    // (`kind:'permanent'`, `code:'forced_fail'`), which the graph's `failure` edges
    // then handle (unhandled → the run fails, ADF Fail's "fail the pipeline"). No
    // `outputs` (a fail produces no data) and no branch labels (a branch edge off a
    // `fail` is correctly invalid). `configSchema` is palette metadata; the
    // save-time rule is `validateDoc`'s `validateFailConfig`. Cataloguing the TYPE
    // bumped `CATALOG_VERSION` 4→5 so an older build refuses a fail-doc it cannot
    // route rather than silently treating the fail node as inert.
    type: FAIL_ACTIVITY_TYPE,
    title: 'Fail',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ message: z.string().min(1) }),
  },
  {
    // #4 A8 — the `filter` CONTROL activity. Engine-evaluated like `if`/`switch`/
    // `fail` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE `if`/`switch`
    // (a branch) and `fail` (a failure) it produces a normal SUCCESS carrying a
    // `result` output — the input `items` array filtered by the whole-value `${}`
    // `predicate`, order-preserved. The reducer composes the two config fields into
    // the INERT expression language's existing `filter(items, predicate)` closed-fn
    // (evaluated under ONE element budget) and holds `ready` while the driver
    // appends `node.succeeded{outputs:{result}}` via the `succeedControl` command.
    // `outputs`/`configSchema` are palette metadata; the save-time rules are
    // `validateDoc`'s `validateFilterConfig` (shape/whole-value) and `validateRefs`'
    // composed-expr scan (which gives the predicate lambda `${item}` scope).
    // Cataloguing the TYPE bumped `CATALOG_VERSION` 5→6.
    type: FILTER_ACTIVITY_TYPE,
    title: 'Filter',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [out('result', 'json')],
    configSchema: z.object({ items: z.string().min(1), predicate: z.string().min(1) }),
  },
  {
    // #4 A5+A6 — the `wait` CONTROL activity. Engine-evaluated like `if`/`switch`/
    // `fail`/`filter` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. UNLIKE the four
    // synchronous control activities it is DURABLE — a ready `wait` resolves its
    // whole-value `${}` `seconds` PURELY, and the driver ARMS S1's alarm then
    // appends `timer.waitScheduled`, parking the node `wait_pending` until the alarm
    // clock fires `timer.due` (which SUCCEEDS the node with no output). No `outputs`
    // (a wait produces no data) and no branch labels (a branch edge off a `wait` is
    // correctly invalid). `seconds` is a WHOLE-VALUE `${}` number field like
    // `if.condition`/`filter.items` (an embedded template can only be a string, so
    // `validateWaitConfig` refuses it at save); `configSchema` is palette metadata,
    // the save-time rule is `validateDoc`'s `validateWaitConfig`, and the run-time
    // type gate is `evalWaitSeconds` (finite, non-negative). `idempotent:false` is
    // inert (a control node is never dispatched, so no `node.dispatched.idempotent`
    // is ever written). Cataloguing the TYPE bumped `CATALOG_VERSION` 6→7 so an
    // older build refuses a wait-doc it cannot route rather than treating it inert.
    type: WAIT_ACTIVITY_TYPE,
    title: 'Wait',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({ seconds: z.string().min(1) }),
  },
];

/** The MVP activity catalog, keyed by `type`. Frozen (read-only) at module load. */
export const catalog: ActivityCatalog = new Map(ENTRIES.map((e) => [e.type, e]));

/** Look up an activity entry by `type`; `undefined` when the type is unknown. */
export function getActivity(type: string): ActivityCatalogEntry | undefined {
  return catalog.get(type);
}
