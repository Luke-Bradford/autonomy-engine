import { z } from 'zod';
import { literalText, optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { CallConfigSchema, type Node, type Output } from '../schemas/pipeline.js';
import type { ActivityCatalog, ActivityCatalogEntry } from './types.js';
import {
  AGENT_TASK_ACTIVITY_TYPE,
  APPEND_VARIABLE_ACTIVITY_TYPE,
  COPY_ACTIVITY_TYPE,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  GET_METADATA_ACTIVITY_TYPE,
  FILTER_RESULT_OUTPUT,
  IF_ACTIVITY_TYPE,
  HTTP_REQUEST_ACTIVITY_TYPE,
  WEB_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  SET_VARIABLE_ACTIVITY_TYPE,
  SET_VARIABLE_OPERATIONS,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
  COPY_FILES_ACTIVITY_TYPE,
  DELETE_ACTIVITY_TYPE,
} from './types.js';
import { agentTaskConfigSchema } from './agent-config.js';
import { copyDispatchInputSchema, copyInputSchema } from './copy-config.js';
import { copyFilesConfigSchema } from './copy-files-config.js';
import { deleteConfigSchema } from './delete-config.js';
import {
  HTTP_SECRET_HEADERS_FIELD,
  httpSecretHeadersSchema,
  webConfigSchema,
  webWaitsOnly,
} from './web-config.js';
import {
  GET_METADATA_FIELDS_BY_CONNECTION_KIND,
  GET_METADATA_WAIT_UNTIL_BY_CONNECTION_KIND,
  getMetadataConfigSchema,
} from './get-metadata-config.js';
import { lookupConfigSchema } from './lookup-config.js';
import { llmCallConfigSchema } from './llm-config.js';
import {
  fileCopyConfigSchema,
  fileDeleteConfigSchema,
  fileListConfigSchema,
  fileMoveConfigSchema,
  fileReadConfigSchema,
  fileWriteConfigSchema,
} from './fs-activity-config.js';

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
/** An output that may be null (#594's present-null), e.g. a Get metadata field left unticked. */
const optionalOut = (name: string, type: Output['type']): Output => ({
  name,
  type,
  optional: true,
});

/**
 * #1396 — the hint on a `${}` duration field (`wait.seconds`,
 * `webhook.timeoutSeconds`). A bare `30` is refused at save, so the example is
 * the most useful thing the form can say; it is pinned valid by a test.
 */
const WHOLE_SECONDS_HINT = 'A whole ${} expression giving a number, e.g. ${30}.';

/**
 * The per-activity request settings the http adapter reads from a node's
 * prepared `input` (`connectors/http.ts`). Shared, not adapter-private, because
 * the save gate checks a literal config against this same instance (#1480).
 */
export const httpRequestInputSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  // The declared secret SINK (item 7 / S4): header name → inert `{$secret:name}`
  // marker. The RESOLVED plaintext is read from the `secretFields` side channel,
  // NEVER from this marker; this schema exists so a malformed value at the sink is
  // caught rather than silently ignored.
  [HTTP_SECRET_HEADERS_FIELD]: httpSecretHeadersSchema,
});

/** #1600 C12a — Set variable's Operation field. */
const setVariableOperationSchema = z.enum(SET_VARIABLE_OPERATIONS);

const ENTRIES: ActivityCatalogEntry[] = [
  {
    type: HTTP_REQUEST_ACTIVITY_TYPE,
    title: 'HTTP request',
    description: 'Send a request to a URL over an HTTP connection and capture the response.',
    kind: 'execution',
    category: 'general',
    // #1600 C11b — retired from the palette: Web covers it, and a stored node
    // opens as Web with Fail on HTTP error off and Parse as Text (`retired.ts`).
    // It still runs.
    inPalette: false,
    tabs: [
      { key: 'request', bindings: ['connection'], fields: ['url', 'method', 'headers', 'body'] },
      { key: 'auth', fields: [HTTP_SECRET_HEADERS_FIELD] },
    ],
    idempotent: false,
    connectionKinds: ['http'],
    outputs: [out('status', 'number'), out('body', 'string'), out('headers', 'json')],
    // Item 7 / S4 — the FIRST real secret SINK. A `{$secret:name}` marker is
    // permitted only within `secretHeaders` (header name → marker); the save
    // gate (`validateRefs`) refuses one anywhere else, and the http adapter
    // sends the dispatch-resolved plaintext as that header, LAST, never echoed.
    secretSinkFields: [HTTP_SECRET_HEADERS_FIELD],
    configSchema: z.object({
      url: presented(singleLine(z.string()).min(1), {
        title: 'Request URL',
        description:
          "The address to call, joined to the connection's base URL when it is relative.",
      }),
      method: presented(singleLine(z.string()).optional(), {
        title: 'HTTP method',
        description: 'Defaults to GET.',
      }),
      headers: presented(z.record(z.string(), z.string()).optional(), {
        title: 'Request headers',
      }),
      body: presented(z.string().optional(), { title: 'Request body' }),
      // Presentation only: the save gate and the adapter both parse
      // `httpRequestInputSchema` (#1480). Documents the sink shape for the UI.
      // Computed key + shared shape (`httpSecretHeadersSchema`) so neither the
      // field name NOR the record shape can desync from the adapter's schema.
      // Titled on the shared instance itself: there is no wrapper of its own to
      // tag, and the registry is presentation only, so the adapter never sees it.
      [HTTP_SECRET_HEADERS_FIELD]: presented(httpSecretHeadersSchema, {
        title: 'Secret headers',
        description: 'Headers whose values come from stored secrets, sent last and never echoed.',
      }),
    }),
    dispatchConfigSchema: httpRequestInputSchema,
  },
  {
    // #1600 OR41 C11a — Web (catalogue §4.6): ADF's Web activity on an http
    // connection. Unlike `http_request`, a 4xx/5xx FAILS by default (Fail on
    // HTTP error), the body is read up to Max size and parsed as JSON or kept as
    // text, and a 429/5xx carries the server's Retry-After to the retry alarm.
    // `http_request` lowers to it (C11b). Wait for callback (C11c) parks the
    // node on the external-wait machinery `webhook` uses and fills `callback`
    // (declared since C11a, so no `formerOutputs` refresh). With no Request URL
    // (C11c-2) it sends nothing and only waits, which is what `webhook` lowers to.
    type: WEB_ACTIVITY_TYPE,
    title: 'Web',
    description: 'Call a URL over an HTTP connection and read its response.',
    kind: 'execution',
    category: 'general',
    tabs: [
      { key: 'request', bindings: ['connection'], fields: ['url', 'method', 'headers', 'body'] },
      { key: 'auth', fields: [HTTP_SECRET_HEADERS_FIELD] },
      {
        key: 'settings',
        // Ordered so the dock's three-column grid packs the tab into five
        // rows at 1440x900, Wait for callback on or off: the three toggles
        // share a row, Treat as success takes one, the two timeouts and Max size
        // share one, Parse as (two columns) takes Report status on callback
        // beside it, and When over the limit closes. C11c's three fields fill
        // the free cells of rows that already existed rather than add a sixth.
        fields: [
          'failOnHttpError',
          'retryOnThrottle',
          'waitForCallback',
          'successStatusCodes',
          'httpRequestTimeoutSeconds',
          'callbackTimeoutSeconds',
          'maxResponseBytes',
          'parseAs',
          'reportStatusOnCallback',
          'whenOverLimit',
        ],
      },
    ],
    // The rules `webConfigSchema`'s superRefine enforces, except C11c-2's: with
    // no Request URL the request settings are refused at save but still shown,
    // since a condition here can only name values, not "empty".
    appliesWhen: {
      successStatusCodes: [{ field: 'failOnHttpError', in: ['true'] }],
      callbackTimeoutSeconds: [{ field: 'waitForCallback', in: ['true'] }],
      reportStatusOnCallback: [{ field: 'waitForCallback', in: ['true'] }],
    },
    idempotent: false,
    connectionKinds: ['http'],
    outputs: [
      out('status', 'number'),
      out('headers', 'json'),
      // Parsed (JSON) or a string (Text); null for an empty JSON body.
      out('body', 'json'),
      // The body bytes read: after a truncation, the bytes kept.
      out('bytes', 'number'),
      out('durationMs', 'number'),
      out('truncated', 'boolean'),
      optionalOut('callback', 'json'),
    ],
    secretSinkFields: [HTTP_SECRET_HEADERS_FIELD],
    configSchema: webConfigSchema,
    dispatchConfigSchema: webConfigSchema,
  },
  {
    type: LLM_CALL_ACTIVITY_TYPE,
    title: 'LLM call',
    description: 'Send a prompt to a language model and use its reply in later activities.',
    kind: 'execution',
    category: 'ai',
    tabs: [
      {
        key: 'model',
        bindings: ['connection'],
        fields: ['model', 'maxTokens', 'temperature', 'topP', 'stop', 'seed', 'reasoningEffort'],
      },
      { key: 'prompt', fields: ['prompt', 'system', 'messages', 'history'] },
      { key: 'tools', fields: ['tools', 'toolChoice', 'maxToolIterations'] },
      {
        key: 'output',
        fields: ['outputMode', 'outputSchema', 'emitMessages', 'capture', 'captureReasoning'],
      },
    ],
    idempotent: false,
    // #2 L14b — `agent_cli` joins the LLM-provider kinds: an `llm_call` can bind a
    // CLI/subscription connection (the SAME agent-CLI connection `agent_task` uses,
    // per the spec's "LLM connection kinds unchanged; subscription/CLI auth via the
    // agent CLI"). The `agent_cli` adapter serves BOTH activities, selecting by
    // `ctx.activityType`. Widening this list bumped `CATALOG_VERSION` 12→13 so a
    // pre-L14b build refuses to import a pipeline binding `agent_cli` to `llm_call`
    // (which it would reject at dispatch) rather than mis-run it — see version.ts.
    connectionKinds: ['anthropic_api', 'openai_api', 'ollama', 'agent_cli'],
    outputs: [out('text', 'string'), out('stopReason', 'string')],
    // #2 L1 — the SSOT config schema, shared with the three LLM adapters so the
    // palette metadata and the live request validation can never desync (the
    // same shared→server pattern `http_request` uses for `httpSecretHeadersSchema`).
    configSchema: llmCallConfigSchema,
    dispatchConfigSchema: llmCallConfigSchema,
  },
  {
    type: AGENT_TASK_ACTIVITY_TYPE,
    title: 'Agent task',
    description:
      'Hand a task to a coding agent such as Claude Code or Codex and capture its result.',
    kind: 'execution',
    // Spec #4 files `agent_task` under "Execution — AI (Spec #2)" next to
    // `llm_call`: an external CLI agent is an AI activity, not its own class.
    category: 'ai',
    tabs: [
      { key: 'settings', bindings: ['connection'], fields: ['task', 'cwd'] },
      { key: 'output', fields: ['outputSchema'] },
    ],
    idempotent: false,
    connectionKinds: ['agent_cli'],
    // #1101 — `truncated` says the child's output collection hit the supervisor's
    // byte budget, so `output` is a PREFIX of what the agent wrote. Declared so a
    // pipeline can branch on it exactly as it branches on `exitCode`; the durable
    // `activity.warned{output_truncated}` states the same fact for the modes that
    // have no key to carry it (structured `agent_task`, and `llm_call`). The
    // budget is shared by stdout and stderr, so a `true` means COLLECTION stopped
    // at the cap — stdout may itself be whole.
    outputs: [out('output', 'string'), out('exitCode', 'number'), out('truncated', 'boolean')],
    configSchema: agentTaskConfigSchema,
    dispatchConfigSchema: agentTaskConfigSchema,
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
    title: 'If condition',
    description: 'Run one branch when a condition is true and another when it is false.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['condition'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      condition: presented(z.string().min(1), {
        title: 'Condition',
        description: 'A whole ${} expression. True takes the true branch, false the false one.',
      }),
    }),
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
    description:
      'Pick the branch whose case matches a value, or the default branch when none does.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['on', 'cases'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      on: presented(z.string().min(1), {
        title: 'Switch on',
      }),
      cases: presented(z.array(z.string()), {
        title: 'Cases',
        description: 'Each case is a branch; a value matching none takes the default branch.',
      }),
    }),
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
    description: 'Fail this step with an error message you write.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['message'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      message: presented(z.string().min(1), {
        title: 'Error message',
      }),
    }),
  },
  {
    // #844 V5 — the `set_variable` CONTROL activity (spec V-D4). Engine-evaluated
    // like `fail`/`filter` (`kind:'control'`, no connector, never dispatched): the
    // reducer evaluates `value` over the scoped run state, checks it against the
    // declared type, replay safety and `VARIABLE_MAX_BYTES`, and holds the node
    // `ready` while the driver appends `variable.set` (the write and the node's
    // success, one event). An unwritable value fails the node `permanent` with a
    // `VARIABLE_*` code instead. `variable` is a declared variable's literal name —
    // never `${}`, or the determinism guard could not tell what it writes.
    // `configSchema` is palette metadata; the save-time rules are `validateDoc`'s
    // `validateVariableWriteConfig` plus the guard. No outputs: the write IS the
    // result, read back as `${vars.<name>}`.
    // #1600 OR41 C12a (catalogue §4.7) — Operation Set or Append: ADF's Append
    // variable is this activity's second operation, and `append_variable` is
    // lowered to it (`retired.ts`). Literal (an enum, so no dynamic content):
    // it decides the event and what the determinism guard counts.
    type: SET_VARIABLE_ACTIVITY_TYPE,
    title: 'Set variable',
    description: 'Set a pipeline variable, or add a value to the end of an array variable.',
    kind: 'control',
    category: 'control',
    // Operation last: it has a default, and a tab lists its required fields
    // first (`activity-tabs.test.ts`).
    tabs: [{ key: 'settings', fields: ['variable', 'value', 'operation'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      operation: presented(setVariableOperationSchema.default('set'), {
        title: 'Operation',
        description:
          'Set replaces the value. Append adds one value to the end of an array variable, as is, without converting it.',
        options: optionTitles(setVariableOperationSchema, { set: 'Set', append: 'Append' }),
      }),
      variable: presented(literalText(singleLine(z.string())).min(1), {
        title: 'Variable name',
        // #1600 C12a — Append variable's help, which Set variable now needs too.
        description:
          "The name of a variable declared on the pipeline's Variables tab. Append needs an array variable.",
      }),
      value: presented(singleLine(z.string()), { title: 'Value' }),
    }),
  },
  {
    // #844 V5 — the `append_variable` CONTROL activity (spec V-D4): `set_variable`'s
    // twin that appends ONE element to an `array` variable. The element is
    // untyped JSON, so it is not coerced: a literal appends a string, a
    // whole-value `${}` appends its native value.
    // #1600 C12a — retired from the palette: Set variable · Append covers it,
    // and a stored node opens as one (`retired.ts`). It still runs.
    inPalette: false,
    type: APPEND_VARIABLE_ACTIVITY_TYPE,
    title: 'Append variable',
    description: 'Add a value to the end of an array variable.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['variable', 'value'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      variable: presented(literalText(singleLine(z.string())).min(1), {
        title: 'Variable name',
        description:
          "The name of an array variable declared on the pipeline's Variables tab. To replace a value instead, use Set variable.",
      }),
      value: presented(singleLine(z.string()), { title: 'Value' }),
    }),
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
    description: 'Keep only the items of an array that match a condition.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['items', 'predicate'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [out(FILTER_RESULT_OUTPUT, 'json')],
    configSchema: z.object({
      items: presented(z.string().min(1), {
        title: 'Input array',
        description: 'A whole ${} expression giving the array to filter.',
      }),
      predicate: presented(z.string().min(1), {
        title: 'Keep when',
        description:
          'A whole ${} expression over item. The items it is true for are kept, in order.',
      }),
    }),
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
    description: 'Pause this branch of the pipeline for a set number of seconds.',
    kind: 'control',
    category: 'control',
    tabs: [{ key: 'settings', fields: ['seconds'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      seconds: presented(singleLine(z.string()).min(1), {
        title: 'Wait time',
        unit: 'seconds',
        description: WHOLE_SECONDS_HINT,
      }),
    }),
  },
  {
    // #4 A13 — the `webhook` external-wait CONTROL activity. Engine-evaluated like
    // `wait` (`kind:'control'`, no connector, `CONTROL_NOT_DISPATCHABLE` on
    // dispatch): the reducer routes it STRUCTURALLY by `type`. Like `wait` it is
    // DURABLE, but a DIFFERENT suspend/resume source — a ready `webhook` resolves
    // its whole-value `${}` `timeoutSeconds` PURELY, and the driver ARMS S1's
    // EXPIRY alarm (+ a correlation row) then appends `externalWait.created`,
    // parking the node `external_wait_pending`. It resumes when an inbound,
    // correlated + authed + replay-protected HTTP callback appends
    // `externalWait.completed` (SUCCEEDS the node) OR the expiry alarm fires
    // `externalWait.expired` (FOLDS the node to `failure`, so its `failure` edge is
    // the timeout/default path). #4 A16 (LANDED): the callback body is a TYPED
    // output — validated at the HTTP boundary against the webhook's declared generic
    // `config.outputs` and lowered onto `externalWait.completed.outputs`, so
    // `${nodes.w.output.decision}` resolves downstream (a webhook that declares no
    // outputs still succeeds with `{}`). The static `outputs:[]` here is the CATALOG
    // default (webhook outputs are AUTHOR-declared via `config.outputs`, like
    // `execute_pipeline`'s child-projected outputs — not catalog-fixed); no branch
    // labels. `timeoutSeconds` is a WHOLE-VALUE `${}` number field like
    // `wait.seconds` (an embedded template can only be a string, so
    // `validateWebhookConfig` refuses it at save); `configSchema` is palette
    // metadata, the save-time rule is `validateDoc`'s `validateWebhookConfig`, and
    // the run-time type gate is `evalWebhookTimeoutSeconds` (finite, non-negative,
    // bounded). A REQUIRED timeout guarantees a parked webhook always has a live
    // alarm (it can never stall). `idempotent:false` is inert (a control node is
    // never dispatched). Cataloguing the TYPE bumped `CATALOG_VERSION` 9→10 so an
    // older build refuses a webhook-doc it cannot route rather than treating it
    // inert. Config rides `Node.config` (not `Node.call`), so it is NOT a
    // structural-call.
    type: WEBHOOK_ACTIVITY_TYPE,
    title: 'Webhook (external wait)',
    description:
      'Pause until another system calls back over HTTP, or fail when the timeout passes.',
    kind: 'control',
    category: 'control',
    // #1600 OR41 C11c-2 — retired from the palette: Web's Wait for callback with
    // no Request URL covers it, and a stored node without declared outputs opens
    // as that (`retired.ts`). It still runs.
    inPalette: false,
    tabs: [{ key: 'settings', fields: ['timeoutSeconds'] }],
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: z.object({
      timeoutSeconds: presented(singleLine(z.string()).min(1), {
        title: 'Timeout',
        unit: 'seconds',
        description: `How long to wait for the callback before failing. ${WHOLE_SECONDS_HINT}`,
      }),
    }),
  },
  {
    // #4 A9 — the `execute_pipeline` CONTROL activity. It does NOT introduce a new
    // mechanism: it SURFACES the pre-existing structural `call_pipeline` (P2c) as a
    // first-class catalog TYPE. The reducer routes a call node STRUCTURALLY by the
    // presence of `Node.call` (`reduce.ts`), NEVER by this `type` — so no reducer
    // branch is added. Back-compat for a legacy call node carrying a DIFFERENT
    // `type` holds with one exception worth stating precisely (#953), because the
    // unqualified "any other type routes unchanged" this comment used to claim is
    // false: `reduce.ts` reaches `if (node.call !== undefined)` only AFTER the
    // `kind:'control'` forks (`controlBranchEvent`, then fail/filter/wait/webhook),
    // so on those types the TYPE wins and the call blob is inert. `authorsCallBlob`
    // is that rule, and it is what the authoring UI must consult.
    // It reaches the executor only as a `startChild`
    // command (the real child spawn is P3b); the `kind:'control'` +
    // `CONTROL_NOT_DISPATCHABLE` guard only ever fires for a MIS-authored call-less
    // node, which `validateDoc` refuses to save.
    //
    // THE STRUCTURAL-CALL EXCEPTION: `configSchema` here types the `Node.call` blob
    // (reused from `CallConfigSchema`, the SSOT), NOT `Node.config` like every other
    // entry — so `isStructuralCallActivity` flags it, and the generic schema→form
    // CONFIG path routes away from it. It is no longer hidden: #425 gave it a
    // dedicated editor (`CallPanel`), so the palette offers it and the inspector
    // renders that editor for it. `outputs:[]`: a call node's outputs
    // come from the CHILD projection, never a catalog template, so `lowerNodeOutputs`
    // skips call nodes (seeding `[]` would flip the contract absent→declared-empty and
    // silently drop every child output). Cataloguing this TYPE does NOT bump
    // `CATALOG_VERSION` (structural routing = no older build mis-runs it; see
    // `schemas/version.ts` + `catalog/types.ts`).
    type: EXECUTE_PIPELINE_ACTIVITY_TYPE,
    title: 'Execute pipeline',
    description: 'Run another pipeline as a step of this one.',
    kind: 'control',
    category: 'control',
    idempotent: false,
    connectionKinds: [],
    outputs: [],
    configSchema: CallConfigSchema,
  },
  {
    // #4 A11 — the `file_read` EXECUTION activity. The FIRST non-http/LLM
    // connector (`fs`): connector-dispatched I/O (`kind:'execution'`), so it
    // REQUIRES a bound `fs` connection whose non-secret `config.roots` the
    // server-side adapter confines the read to (path-traversal + symlink guard).
    // `idempotent:true` — a read is side-effect-free, so the boot reconciler may
    // safely RESUME an in-flight read after a crash (re-reading yields the same
    // bytes); it is the first activity to opt into the read-only idempotent case
    // the fail-safe `false` default anticipates. Outputs the file `content` (as
    // UTF-8 text) and the canonical `path` actually read. `configSchema` is
    // also the `dispatchConfigSchema`: the adapter validates the live
    // (`${}`-substituted) `path` with it, and the save gate a literal one
    // (#1480). No `secretSinkFields` — `fs` is credential-less.
    //
    // #1600 OR41 C7b — Lookup · *Whole file as text* (`LOOKUP_TYPES`): the
    // second type under the ONE Lookup palette item, as `copy_files` is under
    // Copy, so it shares Lookup's title and is not offered on its own.
    //
    // #1600 OR41 C7c — Settings: *When over the limit*. The limit is the
    // connection's `maxBytes` (not rows mode's 1 MiB byte cap, which would fail
    // reads stored nodes make today), and the default is Fail, as it always was.
    // Truncate keeps the first `maxBytes` bytes and warns. `bytes` and
    // `truncated` say what was kept, as in rows mode.
    type: FILE_READ_ACTIVITY_TYPE,
    title: 'Lookup',
    description: 'Read the contents of a file on a file system connection.',
    kind: 'execution',
    category: 'general',
    inPalette: false,
    tabs: [
      { key: 'source', bindings: ['connection'], fields: ['path'] },
      { key: 'settings', fields: ['overLimit'] },
    ],
    idempotent: true,
    connectionKinds: ['fs'],
    outputs: [
      out('content', 'string'),
      out('path', 'string'),
      out('bytes', 'number'),
      out('truncated', 'boolean'),
    ],
    // The two A11 declared, which a node saved before C7c still holds.
    formerOutputs: [[out('content', 'string'), out('path', 'string')]],
    configSchema: fileReadConfigSchema,
    dispatchConfigSchema: fileReadConfigSchema,
  },
  {
    // #4 A11 — the `file_write` EXECUTION activity. Same `fs` connector as
    // `file_read`, but `idempotent:false`: a write is a SIDE EFFECT, so the boot
    // reconciler FREEZES an in-flight write after a crash rather than risk a
    // double write on resume (fail-safe). Overwrites the target (truncate) with
    // the `${}`-substituted `content` as UTF-8 text; outputs the `bytesWritten`
    // and the canonical `path`. Bounded by the same server-side root/traversal
    // guard as the read. The adapter validates the live request against
    // `dispatchConfigSchema`, as the save gate does a literal one (#1480). No
    // `secretSinkFields` — `fs` is credential-less.
    type: FILE_WRITE_ACTIVITY_TYPE,
    title: 'Write file',
    description: 'Write text to a file on a file system connection.',
    kind: 'execution',
    category: 'general',
    tabs: [
      { key: 'location', bindings: ['connection'], fields: ['path'] },
      { key: 'content', fields: ['content'] },
    ],
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('bytesWritten', 'number'), out('path', 'string')],
    configSchema: fileWriteConfigSchema,
    dispatchConfigSchema: fileWriteConfigSchema,
  },
  {
    // #4 A12 — `file_copy`. Copies `source` → `dest`, both confined to the `fs`
    // connection's roots by the same server-side guard. `idempotent:false` — a
    // copy overwrites `dest` (a side effect), so the reconciler FREEZES an
    // in-flight copy rather than risk a partial re-copy on resume. The adapter
    // STREAMS source→temp→rename (no in-memory size cap, unlike `file_read`), so
    // an arbitrarily large file copies without OOM. The adapter validates the
    // live `${}`-substituted request against `dispatchConfigSchema`, as the save
    // gate does a literal one (#1480).
    type: FILE_COPY_ACTIVITY_TYPE,
    title: 'Copy file',
    description: 'Copy a file to another path on a file system connection.',
    kind: 'execution',
    category: 'general',
    // #1600 C1b — retired from the palette: the one Copy covers it, and a
    // stored node opens as Copy · Files as-is (`retired.ts`). It still runs.
    inPalette: false,
    tabs: [{ key: 'location', bindings: ['connection'], fields: ['source', 'dest'] }],
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('bytesWritten', 'number'), out('source', 'string'), out('dest', 'string')],
    configSchema: fileCopyConfigSchema,
    dispatchConfigSchema: fileCopyConfigSchema,
  },
  {
    // #4 A12 — `file_move`. Atomic same-filesystem `rename(source, dest)`, both
    // confined to the roots. `idempotent:false` — the source is GONE after a
    // successful move, so a resume of a completed move would fail (source
    // missing); the reconciler must freeze it. A move ACROSS filesystems throws
    // `EXDEV` → `permanent` (the operator composes `file_copy`+`file_delete` for
    // that); documented same-filesystem-only. Outputs the canonical source/dest.
    type: FILE_MOVE_ACTIVITY_TYPE,
    title: 'Move file',
    description: 'Move or rename a file on a file system connection.',
    kind: 'execution',
    category: 'general',
    // #1600 C1b — retired from the palette: the one Copy covers it, and a
    // stored node opens as Copy · Files as-is (`retired.ts`). It still runs.
    inPalette: false,
    tabs: [{ key: 'location', bindings: ['connection'], fields: ['source', 'dest'] }],
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('source', 'string'), out('dest', 'string')],
    configSchema: fileMoveConfigSchema,
    dispatchConfigSchema: fileMoveConfigSchema,
  },
  {
    // #4 A12 — `file_delete`. `unlink`s a single regular file confined to the
    // roots. `idempotent:false` — a delete is a side effect (and a missing target
    // is a `permanent` failure, not a benign success), so a resume must not
    // re-run it. The target-symlink guard means a symlink AT the path is refused,
    // not followed. Outputs the canonical `path` deleted.
    type: FILE_DELETE_ACTIVITY_TYPE,
    title: 'Delete file',
    description: 'Delete a file on a file system connection.',
    kind: 'execution',
    category: 'general',
    // #1600 C9b — retired from the palette: Delete covers it, and a stored node
    // opens as Delete · File (`retired.ts`). It still runs.
    inPalette: false,
    tabs: [{ key: 'location', bindings: ['connection'], fields: ['path'] }],
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [out('path', 'string')],
    configSchema: fileDeleteConfigSchema,
    dispatchConfigSchema: fileDeleteConfigSchema,
  },
  {
    // #4 A12 — `file_list`. Lists the entries of a directory confined to the
    // roots (bounded by the connection's `maxEntries`, default 10000). Like
    // `file_read` it is side-effect-free, so `idempotent:true` — the reconciler
    // may safely RESUME an in-flight list (re-listing yields an equivalent
    // result). Each entry is `{name, type}` where `type` is
    // `file`|`directory`|`symlink`|`other` from the raw dirent (a symlink entry
    // is REPORTED, never followed). Outputs the `entries` array (json) + the
    // canonical `path` listed.
    type: FILE_LIST_ACTIVITY_TYPE,
    title: 'List directory',
    description: 'List the files and folders in a directory on a file system connection.',
    kind: 'execution',
    category: 'general',
    // #1600 C8b — retired from the palette: Get metadata · Child items covers
    // it, and a stored node opens as that (`retired.ts`). It still runs.
    inPalette: false,
    tabs: [{ key: 'location', bindings: ['connection'], fields: ['path'] }],
    idempotent: true,
    connectionKinds: ['fs'],
    outputs: [out('entries', 'json'), out('path', 'string')],
    outputElements: { entries: [out('name', 'string'), out('type', 'string')] },
    configSchema: fileListConfigSchema,
    dispatchConfigSchema: fileListConfigSchema,
  },
  {
    // #1600 OR41 C8a — Get metadata on a file system connection (catalogue
    // §4.3). The fields ticked in `fieldList` fill the outputs of the same
    // name; the rest are null, so every field output is OPTIONAL and the
    // contract is fixed, not derived from the ticks (a derived one would go
    // stale when they change). A reference to an unticked field therefore
    // resolves to null where ADF fails it; the spec records the difference.
    // Side-effect-free, so `idempotent:true`, like `file_list`, which is
    // lowered to its Child items (C8b). Wait until (C8d) re-checks a path, a
    // delimited or Excel dataset's file (C8d-2a) or a table (C8d-2b) on a
    // durable timer: the adapter answers `notReady` until it holds.
    // Include subfolders (C8e) names each child by its path below the folder.
    //
    // C8c — a database TABLE as well: on a sqlite or postgres connection the
    // table is the Source tab's dataset (a saved `table` dataset or an inline
    // Table, C1q), never a path, and the field list offers a table's fields.
    // The dataset is optional on `fs` only, where the path is the address.
    type: GET_METADATA_ACTIVITY_TYPE,
    title: 'Get metadata',
    description:
      'Read facts about a file, folder or table: whether it exists, its size, dates or columns, or list what a folder holds.',
    kind: 'execution',
    category: 'general',
    tabs: [
      { key: 'source', bindings: ['connection', 'sourceDataset'], fields: ['path'] },
      {
        key: 'settings',
        fields: [
          'fieldList',
          'childFilter',
          'childType',
          'recursive',
          'modifiedStart',
          'modifiedEnd',
          'waitUntil',
          'minimumSize',
          'checkEverySeconds',
          'giveUpAfterSeconds',
        ],
      },
    ],
    appliesWhen: {
      path: [{ connectionKind: ['fs'] }],
      minimumSize: [{ field: 'waitUntil', in: ['minimumSize'] }],
      checkEverySeconds: [{ field: 'waitUntil', in: ['exists', 'nonEmpty', 'minimumSize'] }],
      giveUpAfterSeconds: [{ field: 'waitUntil', in: ['exists', 'nonEmpty', 'minimumSize'] }],
      childFilter: [{ field: 'fieldList', in: ['childItems'] }],
      childType: [{ field: 'fieldList', in: ['childItems'] }],
      recursive: [{ field: 'fieldList', in: ['childItems'] }],
      modifiedStart: [{ field: 'fieldList', in: ['childItems'] }],
      modifiedEnd: [{ field: 'fieldList', in: ['childItems'] }],
    },
    fieldOptionsByConnectionKind: {
      fieldList: GET_METADATA_FIELDS_BY_CONNECTION_KIND,
      // C8d-2b — a table waits until it exists or holds a row, never for a size.
      waitUntil: GET_METADATA_WAIT_UNTIL_BY_CONNECTION_KIND,
    },
    idempotent: true,
    connectionKinds: ['fs', 'sqlite', 'postgres'],
    datasetKinds: { source: ['table', 'delimited', 'excel'], optionalOn: ['fs'] },
    outputs: [
      out('path', 'string'),
      optionalOut('exists', 'boolean'),
      optionalOut('itemName', 'string'),
      optionalOut('itemType', 'string'),
      optionalOut('size', 'number'),
      optionalOut('created', 'string'),
      optionalOut('lastModified', 'string'),
      optionalOut('contentMD5', 'string'),
      optionalOut('childItems', 'json'),
      optionalOut('structure', 'json'),
      optionalOut('columnCount', 'number'),
      optionalOut('rowCount', 'number'),
    ],
    // The nine C8a declared, which a node saved before C8c (and C8b's lowered
    // List directory, and the demo) still holds. A snapshot, not derived.
    formerOutputs: [
      [
        out('path', 'string'),
        optionalOut('exists', 'boolean'),
        optionalOut('itemName', 'string'),
        optionalOut('itemType', 'string'),
        optionalOut('size', 'number'),
        optionalOut('created', 'string'),
        optionalOut('lastModified', 'string'),
        optionalOut('contentMD5', 'string'),
        optionalOut('childItems', 'json'),
      ],
    ],
    outputElements: {
      childItems: [
        out('name', 'string'),
        out('type', 'string'),
        optionalOut('size', 'number'),
        out('lastModified', 'string'),
      ],
      structure: [out('name', 'string'), out('type', 'string')],
    },
    configSchema: getMetadataConfigSchema,
    dispatchConfigSchema: getMetadataConfigSchema,
  },
  {
    // #1600 OR41 C9a — Delete (catalogue §4.4): the files at a path on a file
    // system connection, one file or a folder's matches, with Include
    // subfolders, a modified window and, after them, the subfolders left empty.
    // The walk is Get metadata's (`fs-walk.ts`). `idempotent:false`: a delete
    // is a side effect, as Copy · Files as-is's is. Needs Allow writes on the
    // connection. `file_delete` is lowered to it (C9b).
    type: DELETE_ACTIVITY_TYPE,
    title: 'Delete',
    description:
      'Delete a file, or the files in a folder that match a wildcard, on a file system connection.',
    kind: 'execution',
    category: 'general',
    tabs: [
      {
        key: 'source',
        bindings: ['connection'],
        fields: ['path', 'pathType', 'wildcard', 'recursive', 'modifiedStart', 'modifiedEnd'],
      },
      {
        key: 'settings',
        fields: [
          'maxConcurrentConnections',
          'failIfNothingMatched',
          'deleteEmptyFolders',
          'logLevel',
          'logTo',
          'logFolder',
        ],
      },
    ],
    // The rules `deleteConfigSchema`'s superRefine enforces.
    appliesWhen: {
      wildcard: [{ field: 'pathType', in: ['folder'] }],
      recursive: [{ field: 'pathType', in: ['folder'] }],
      deleteEmptyFolders: [{ field: 'recursive', in: ['true'] }],
      logTo: [{ field: 'logLevel', in: ['warning', 'info'] }],
      logFolder: [{ field: 'logTo', in: ['folder'] }],
    },
    idempotent: false,
    connectionKinds: ['fs'],
    outputs: [
      out('path', 'string'),
      out('filesDeleted', 'number'),
      out('foldersDeleted', 'number'),
      // C9c — the session log file written, or null when none is (§4.4).
      optionalOut('logPath', 'string'),
    ],
    formerOutputs: [
      // C9a/C9b, before the session log.
      [out('path', 'string'), out('filesDeleted', 'number'), out('foldersDeleted', 'number')],
    ],
    configSchema: deleteConfigSchema,
    dispatchConfigSchema: deleteConfigSchema,
  },
  {
    /*
     * #996 M5 (slice 4c, #1139) — `copy`, the data-movement activity, and the
     * FIRST entry in this registry to declare either of the two paired fields.
     * Everything under it shipped in slices 1-4b and was unreachable until this
     * object existed: `executor.ts` refuses an uncatalogued type with
     * `UNKNOWN_ACTIVITY` before it looks at anything else, so the pump, the sink
     * discipline and the dispatch seam had no way to run.
     *
     * `idempotent:false` — §4 argues this one explicitly, and the argument is
     * NOT "a copy is destructive so mark it unsafe". It is that the flag governs
     * the BOOT-RECOVERY path only: the reconciler FREEZES an in-flight
     * non-idempotent node rather than resume it, which is what a copy needs
     * because an interrupted `append` may have committed some batches. §4's
     * atomic-swap discipline is what makes a copy safe WITHIN a run; this flag is
     * what keeps a crash from re-running one. Both, never one instead of the other.
     *
     * `datasetKinds.sink` is `['table']` and not `['table','query']` by
     * construction, not by policy: `connectors/sqlite.ts` reads a `query` dataset
     * but refuses any non-`table` for the write, because a query has nothing to
     * write INTO.
     *
     * M7 slice 3 (#1167) WIDENED THE TWO SOURCE LISTS TOGETHER, exactly as the
     * paragraph they replace said it would have to: a `delimited` dataset lives
     * on an `fs` connection (`DatasetSchema.connectionId`), so `delimited` in
     * `datasetKinds.source` without `fs` in `connectionKinds` would be refused
     * at dispatch by `DATASET_CONNECTION_MISMATCH` on every binding — and `fs`
     * without `delimited` would be a store nothing can name a dataset in. The
     * pair is the unit; `CATALOG_VERSION` 23 -> 24 is its discharge.
     *
     * THE SINK HALVES DELIBERATELY DID NOT MOVE. `sinkConnectionKinds` is still
     * `['sqlite']` and `datasetKinds.sink` still `['table']`, because M7 built a
     * `delimited` READER and no writer — there is nothing to copy INTO a CSV
     * with. Widening them in sympathy would offer an author a pairing that
     * every dispatch then refuses, which is the shape this entry has now twice
     * declined. `excel` arrived at M11 slice 2 (#1215) on the SOURCE side only,
     * for that same reason applied to it: it has a reader and no writer.
     *
     * `connectionKinds` is a SOURCE allowlist with two store kinds in it, and
     * the executor dispatches on the SOURCE connection's kind — so which
     * adapter runs a `copy` is now a real choice rather than a foregone one.
     * `sqlite.ts` and `fs.ts` each supply the store halves of `CopyIo`; both
     * refuse a non-`sqlite` sink at the ladder's `refuseSink` rung.
     *
     * `outputs` mirrors `connectors/copy.ts`'s `copyOutputs` exactly — five, all
     * REQUIRED. That is load-bearing rather than incidental: F13b lowering seeds
     * these into a node's `config.outputs` at SAVE, and `validateOutputs` then
     * fails the node for any the adapter omits. The adapter yields all five
     * unconditionally on success, and on the WRITE-failure path emits them as
     * `output` events first, so a copy that dies mid-write still reports what it
     * had moved. Deliberately NOT claimed of the whole failure ladder: the
     * earlier `permanent` refusals (an unresolved dataset, a refused sink, an
     * invalid dispatch config) yield `failed` carrying no outputs, which is
     * right — nothing had been counted yet.
     */
    type: COPY_ACTIVITY_TYPE,
    title: 'Copy data',
    description:
      'Copy rows from a source dataset into a sink dataset, mapping columns between them, or copy files as they are.',
    kind: 'execution',
    category: 'general',
    tabs: [
      { key: 'source', bindings: ['sourceConnection', 'sourceDataset'], fields: [] },
      {
        key: 'sink',
        bindings: ['sinkConnection', 'sinkDataset'],
        // #1600 OR41 C3b — ADF's sink order: behaviour, then the script, then the
        // batch. C3c's Table option comes first, as ADF's does.
        fields: [
          'tableOption',
          'mode',
          'keyColumns',
          'preCopyScript',
          'preCopyScriptParameters',
          'writeBatchSize',
        ],
      },
      { key: 'mapping', fields: ['mapping'] },
      // #1600 OR41 C6a — ADF's Settings tab, after Mapping. The Session log only
      // for now; fault tolerance, consistency and parallelism join it in C6.
      { key: 'settings', fields: ['logLevel'] },
    ],
    // #1600 OR41 C3a — Key columns are read only by Upsert, and save refuses
    // them on any other write behaviour (`copyKeyColumnIssues`).
    // C3b — Pre-copy bind values only mean something beside a script, and save
    // refuses them without one.
    appliesWhen: {
      keyColumns: [{ field: 'mode', in: ['upsert'] }],
      preCopyScriptParameters: [{ field: 'preCopyScript', set: true }],
    },
    idempotent: false,
    // #1190 (M10 slice 2) — `postgres` joins the SOURCE allowlist, because the
    // executor dispatches a copy on the source connection's adapter and the
    // postgres adapter now carries the reader. Widening this bumped
    // `CATALOG_VERSION` 25 -> 26, on bump 24's precedent (widening this same
    // list `['sqlite'] -> ['sqlite','fs']` was itself that bump).
    connectionKinds: ['sqlite', 'fs', 'postgres'],
    // #1196 (M10 slice 3a) — `postgres` joins the SINK allowlist, in the same
    // commit as `postgres-sink.ts`'s writer, exactly as slice 2 opened the
    // SOURCE half alongside its reader. `copy` is the first activity whose sink
    // is heterogeneous, so `copy-sink.ts` now dispatches on this kind.
    // `CATALOG_VERSION` 26 -> 27.
    //
    // #1190's pin said adding a kind here "silently expires" the premise that
    // made #1193's two items unreachable. It is expired DELIBERATELY and out
    // loud, and both were re-measured rather than waved through:
    //
    // - §7's drift-gate row 3. Slice 2 measured that `insert into t(n int4)
    //   select c` where `c` is `text` raises `42804` naming both types, and
    //   inferred that postgres-as-sink would reject on TYPE. It does not on the
    //   path this writer uses: a BOUND parameter is untyped text, and measured,
    //   `'123'` into `int4` SUCCEEDS while `'abc'` raises `22P02` and
    //   `3000000000` raises `22003`. So postgres coerces per VALUE exactly as
    //   SQLite does, and §7 ③'s argument for not building row 3 — that a
    //   per-type refusal would break working copies — applies here unchanged.
    //   Row 3 is not merely still deferred; its premise was wrong.
    //
    // - The `query` self-copy residual. Measured against `postgres:17`: it is
    //   not a data-loss path. The sink's `EXCLUSIVE` lock does not conflict
    //   with the source cursor's `ACCESS SHARE`, and under READ COMMITTED the
    //   source reads a snapshot taken before the sink's uncommitted `DELETE` —
    //   so a `query` reading the very table its sink overwrites read all five
    //   rows, wrote them back, and committed with the table intact. A wasteful
    //   no-op, not destruction. It stays a REACHABLE case rather than an
    //   unreachable one, and it is still not guess-refused: §7 ② is explicit
    //   that a `permanent` refusal reached by parsing an operator's SQL badly is
    //   the one direction a gate must never fail in.
    //
    //   #1600 C3a — Truncate then insert is the exception: its sink lock is
    //   `ACCESS EXCLUSIVE`, which DOES conflict with the source cursor's
    //   `ACCESS SHARE`, so a `query` reading the table its Truncate empties
    //   waits on itself until the activity timeout ends it. Nothing is lost
    //   (nothing was truncated), and the spec's C3a note says to use Overwrite.
    //
    // #1193 (slice 3b) then closed the ONE item those two re-measurements left:
    // the `storeIdentity` hole this widening made reachable. The address seam
    // now takes a credential, so two spellings of one host no longer read as two
    // stores. See §7 ④.
    sinkConnectionKinds: ['sqlite', 'postgres'],
    // #1215 (M11 slice 2) — `excel` joins the SOURCE list, in the same commit as
    // `connectors/excel-io.ts`, exactly as `delimited` did at #1167 and
    // `postgres` did at #1190. `connectionKinds` needs no matching widening this
    // time and that is not an exception to the pairing rule: an `excel` dataset
    // lives on an `fs` connection, and `fs` has been on that list since #1167.
    // `CATALOG_VERSION` 27 -> 28.
    //
    // THE SINK HALVES STILL DO NOT MOVE. `excel` is source-only for
    // `delimited`'s reason unchanged — M11 built a READER and no writer, so
    // there is nothing to copy INTO a workbook with, and offering the pairing
    // would only produce a dispatch that always refuses.
    datasetKinds: { source: ['table', 'query', 'delimited', 'excel'], sink: ['table'] },
    outputs: [
      out('rowsRead', 'number'),
      out('rowsWritten', 'number'),
      out('rowsFailed', 'number'),
      out('bytesRead', 'number'),
      out('truncated', 'boolean'),
    ],
    configSchema: copyInputSchema,
    dispatchConfigSchema: copyDispatchInputSchema,
  },
  {
    /*
     * #1600 OR41 C1a — Copy · Files as-is (activity catalogue §4.1): bytes from
     * one `fs` connection to another, by file, folder + wildcard or file list,
     * with copy behaviour, if-exists and after-copy options. The SAME Copy to
     * an author: the palette offers only `copy` (`inPalette: false` here), and
     * the dock's *Copy* toggle switches a node between the two types. Why a
     * type and not a mode field: `copy-files-config.ts`.
     *
     * PAIRED on connections (`sinkConnectionKinds`), so the executor resolves
     * `connectionIds.{source,sink}` and dispatches on the SOURCE kind, exactly
     * as `copy` does. NOT dataset-bound: no `datasetKinds`, so a stray
     * `datasetIds` stays inert. `idempotent: false` on `copy`'s argument: a
     * crash mid-copy may have written, deleted or moved some files, so boot
     * recovery freezes the node rather than re-running it.
     *
     * Outputs: the file and byte counters §4.1 lists, never the row outputs (a
     * `rowsWritten` of 0 would count as "wrote nothing" in the run's rows
     * total, `rowsWrittenFromLog`). All required: the adapter yields every one
     * on success, and the counters on a mid-copy failure too.
     *
     * #1600 C1b — plus `source` and `dest`, the canonical source path and the
     * file written (one file or a merge) or the sink folder. They are the
     * retired `file_copy`/`file_move` outputs, so a lowered node's
     * `${nodes.x.output.dest}` still resolves (`retired.ts`).
     */
    type: COPY_FILES_ACTIVITY_TYPE,
    // `copy`'s title: one activity to an author, so a card does not rename
    // itself when the toggle flips.
    title: 'Copy data',
    description:
      'Copy files as they are, without parsing them, from one file connection to another.',
    kind: 'execution',
    category: 'general',
    inPalette: false,
    tabs: [
      {
        key: 'source',
        bindings: ['sourceConnection'],
        fields: [
          'sourcePath',
          'pathType',
          'wildcard',
          'recursive',
          'fileListPath',
          'modifiedStart',
          'modifiedEnd',
          'afterCopy',
          'moveTo',
        ],
      },
      {
        key: 'sink',
        bindings: ['sinkConnection'],
        fields: ['sinkFolder', 'sinkFileName', 'copyBehavior', 'ifExists'],
      },
    ],
    // #1686 — the same rules `copyFilesConfigSchema`'s superRefine enforces,
    // read by the dock to leave out what cannot apply.
    appliesWhen: {
      wildcard: [{ field: 'pathType', in: ['folder'] }],
      recursive: [{ field: 'pathType', in: ['folder'] }],
      fileListPath: [{ field: 'pathType', in: ['list'] }],
      moveTo: [{ field: 'afterCopy', in: ['move'] }],
      sinkFileName: [
        { field: 'pathType', in: ['file'] },
        { field: 'copyBehavior', in: ['merge'] },
      ],
    },
    idempotent: false,
    connectionKinds: ['fs'],
    sinkConnectionKinds: ['fs'],
    outputs: [
      out('filesRead', 'number'),
      out('filesWritten', 'number'),
      out('filesSkipped', 'number'),
      out('filesDeleted', 'number'),
      out('filesMoved', 'number'),
      out('bytesRead', 'number'),
      out('bytesWritten', 'number'),
      out('source', 'string'),
      out('dest', 'string'),
    ],
    configSchema: copyFilesConfigSchema,
    dispatchConfigSchema: copyFilesConfigSchema,
  },
  {
    /**
     * #996 M12 slice 2 (#1221, data-movement spec §5) — `lookup`: read ONE
     * dataset, materialise a BOUNDED set of rows into the declared outputs.
     *
     * The SOURCE-ONLY entry the catalog type has been anticipating since M5
     * slice 4a: `sinkConnectionKinds` is omitted entirely and `datasetKinds`
     * declares no `sink`, which is why both fields were made optional then
     * rather than now. It is the first entry to exercise that shape, and
     * therefore the first that can produce a source-only `Node.datasetIds` — the
     * shape M12 slice 1 (#1220) made legal.
     *
     * OUTPUTS, and the two the ticket required this slice to settle:
     *
     *  - `rows` carries the materialised records. M12 offered no `firstRow`;
     *    #1600 OR41 C7a adds it with catalogue §4.2 (ADF's Lookup output). Its
     *    empty value is `null`, which no row can be (a row is a record), and
     *    `truncated` tells an empty source from a first row too large to keep.
     *    So nothing is manufactured: `null` is "no row", not a row.
     *  - `count` (C7a, ADF's name) and `rowCount` (M12's, kept so the nodes
     *    that read it keep working, catalogue §8) are the same number.
     *  - `rowCount` is ALWAYS `rows.length`. On a truncated lookup the source
     *    total is unknown — the read stopped — and studio does not report what
     *    it did not count.
     *  - `bytes` is the DURABLE size of those rows, and is named `bytes` rather
     *    than `copy`'s `bytesRead` because it is a different quantity measured
     *    for a different purpose (see `server/limits.ts`'s `LOOKUP_BYTE_CAP`).
     *    Sharing the name would be the drift, not the consistency.
     *  - `truncated` is REQUIRED and honest, per §5. Paired with `rows`, it is
     *    what distinguishes an empty SOURCE (`[]` + `false`) from a source whose
     *    first row alone would not fit (`[]` + `true`).
     *
     * IDEMPOTENT, and it is the third activity ever to say so. The reconciler
     * RESUMES an idempotent in-flight node and FREEZES the rest, so this claims
     * that re-running a lookup after a crash is safe — which it is, on
     * `file_read`/`file_list`'s own reasoning: it opens a store READ-ONLY, moves
     * nothing, and writes nowhere. The safety is structural rather than
     * asserted: there is no sink half of this entry for a future slice to widen
     * without confronting this flag.
     *
     * SETTINGS (#1600 OR41 C7a, catalogue §4.2): First row only, Max rows and
     * When over the limit. The table, the query and its parameters, the file
     * path, the sheet and the header row stay the DATASET's, re-validated by the
     * reader at dispatch (§8). M12 cut a `maxRows` knob because a per-node
     * override would make the durable-log bound configurable by the person it
     * protects against. That bound is the 1 MiB byte cap, which is still not
     * configurable at all. Rows are (C7d): a node's Max rows asks for up to
     * `LOOKUP_ROW_CEILING_MAX`, and the run is held to the workspace's Lookup
     * max rows as well (`WorkspaceSettings.lookupMaxRows`, default
     * `LOOKUP_ROW_CAP`), so more rows only ever means smaller rows.
     */
    type: LOOKUP_ACTIVITY_TYPE,
    title: 'Lookup',
    description:
      'Read a bounded set of rows from a dataset, or a whole file as text, so later activities can use them.',
    kind: 'execution',
    category: 'general',
    tabs: [
      { key: 'source', bindings: ['connection', 'sourceDataset'], fields: [] },
      { key: 'settings', fields: ['firstRowOnly', 'maxRows', 'overLimit'] },
    ],
    // ADF's new-node default. The schema's own default is off, so a stored
    // node keeps returning `rows` (catalogue §8).
    newNodeConfig: { firstRowOnly: true },
    idempotent: true,
    // The same three source stores `copy` reads from, and for the same reason:
    // the executor dispatches on the bound connection's kind, so a lookup is
    // reachable exactly where a reader exists. `sinkConnectionKinds` is ABSENT,
    // not `[]` — absence means "not paired", and `[]` would mean "paired, but no
    // sink kind is ever valid", an entry every dispatch refuses.
    connectionKinds: ['sqlite', 'fs', 'postgres'],
    // Every source kind that has a reader, which is `copy`'s source list
    // exactly. It is written out rather than derived from that entry: the two
    // agreeing today is a fact about which readers exist, not a rule, and a
    // shared constant would turn the next divergence into a puzzle.
    datasetKinds: { source: ['table', 'query', 'delimited', 'excel'] },
    outputs: [
      out('rows', 'json'),
      out('rowCount', 'number'),
      out('count', 'number'),
      out('firstRow', 'json'),
      out('bytes', 'number'),
      out('truncated', 'boolean'),
    ],
    // The four M12 declared, which a node saved before C7a still holds. Written
    // out, not derived from `outputs`: it is a snapshot of an old default.
    formerOutputs: [
      [
        out('rows', 'json'),
        out('rowCount', 'number'),
        out('bytes', 'number'),
        out('truncated', 'boolean'),
      ],
    ],
    // The Monitor's Rows read column (C7d). `rowCount` for a node saved before
    // C7a, whose contract has no `count`; the two are the same number.
    rowsReadOutputs: ['count', 'rowCount'],
    configSchema: lookupConfigSchema,
    dispatchConfigSchema: lookupConfigSchema,
  },
];

/** The MVP activity catalog, keyed by `type`. Frozen (read-only) at module load. */
export const catalog: ActivityCatalog = new Map(ENTRIES.map((e) => [e.type, e]));

/** Look up an activity entry by `type`; `undefined` when the type is unknown. */
export function getActivity(type: string): ActivityCatalogEntry | undefined {
  return catalog.get(type);
}

/**
 * Whether an activity `type` stores its settings in `Node.call` (the structural
 * `call_pipeline` mechanism, P2c) rather than `Node.config`. Today this is
 * exactly `execute_pipeline` (#4 A9). It is the SSOT the generic authoring UI
 * consults to EXCLUDE such a type: the palette/inspector author `Node.config`, so
 * a call node needs the dedicated call-node authoring UI (#425), not a plain
 * config form. A magic per-type check in the web layer would desync from this
 * catalog fact, so the predicate lives here beside the entry.
 */
export function isStructuralCallActivity(type: string): boolean {
  return type === EXECUTE_PIPELINE_ACTIVITY_TYPE;
}

/**
 * #953 — whether a node's `Node.call` blob is the thing that DISPATCHES it, and
 * therefore whether the authoring UI owes it the call editor rather than the
 * generic `Node.config` form.
 *
 * `isStructuralCallActivity` alone is not that question. `Node.call` is an
 * OPTIONAL DISCRIMINANT valid on a node of any type — the engine test suite and
 * any imported/API-seeded doc use the literal `type: 'call_pipeline'`, which the
 * catalog does not know — so keying the inspector on the type alone left such a
 * node routed to a generic form that derives no fields, with its call blob
 * neither visible nor editable.
 *
 * The `kind: 'control'` exclusion is the non-obvious half, and it is read off the
 * reducer rather than guessed: `reduce.ts` evaluates the control forks
 * (`controlBranchEvent`, then fail/filter/wait/webhook) BEFORE it tests
 * `node.call`, so on those types the TYPE wins and a call blob is inert. Offering
 * a call editor there would be a UI that contradicts what the run does.
 * `execute_pipeline` is `kind:'control'` too but has no reducer fork of its own —
 * it falls through to the `node.call` branch — which is why the structural test
 * is a separate disjunct rather than an exception carved out of the exclusion.
 *
 * NOT the same predicate as `lower.ts`'s call-node skip, deliberately. That one is
 * `node.call !== undefined || isStructuralCallActivity(node.type)` and is WIDER on
 * purpose: it must not seed `config.outputs` into ANY call-bearing node, control
 * type or not, because doing so would flip the absent→declared-empty contract and
 * change the node's content form (and so its version-mint / git-import churn).
 * "What lowering must not touch" and "what the reducer executes" are genuinely
 * different questions; one name for both would be the disagreement, not the fix.
 */
export function authorsCallBlob(node: Pick<Node, 'type' | 'call'>): boolean {
  if (isStructuralCallActivity(node.type)) return true;
  return node.call !== undefined && getActivity(node.type)?.kind !== 'control';
}

/**
 * #1600 OR41 C0a (#1 F3) — can `policy.timeoutSeconds` hold on this node? Only an
 * `execution` activity's attempt runs an adapter the executor can abort, so a
 * call (the child is a run of its own) and every `control` activity cannot. The
 * ONE statement of the rule: `validateDoc` refuses a timeout where it is false,
 * and the property dock offers the field only where it is true.
 */
export function timeoutApplies(node: Pick<Node, 'type' | 'call' | 'config'>): boolean {
  if (node.call !== undefined || getActivity(node.type)?.kind !== 'execution') return false;
  // #1600 OR41 C11c-2 — a Web with no Request URL is never dispatched: it waits,
  // as a `webhook` does, and its Callback timeout is the bound.
  return !(node.type === WEB_ACTIVITY_TYPE && webWaitsOnly(node.config));
}

/**
 * #1600 OR41 C0d — whether a node's user properties are recorded: they are
 * resolved and written on `node.dispatched`, so on exactly the nodes the
 * executor dispatches — the same set a timeout applies to.
 */
export function userPropertiesApply(node: Pick<Node, 'type' | 'call' | 'config'>): boolean {
  return timeoutApplies(node);
}
