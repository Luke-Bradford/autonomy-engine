import pLimit from 'p-limit';
import {
  LOOKUP_ACTIVITY_TYPE,
  inlineQuerySqlIssue,
  type ConnectionKind,
  type DatasetPreviewResult,
  type InlineDataset,
} from '@autonomy-studio/shared';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { redactSecrets } from '../connectors/redact.js';
import type { ConnectorAdapter, ResolvedDataset } from '../connectors/types.js';
import {
  LOOKUP_BYTE_CAP,
  PREVIEW_BACKSTOP_MS,
  PREVIEW_CONCURRENCY,
  PREVIEW_ROW_CAP,
} from '../limits.js';
import { resolveInlineSource } from './inline-source.js';

const previewLimit = pLimit(PREVIEW_CONCURRENCY);

/** The id a preview's synthetic activity context carries; it names no run. */
const PREVIEW_ID = 'preview';

export interface PreviewInlineSourceArgs {
  readonly registry: ConnectorRegistry;
  readonly connection: { readonly kind: ConnectionKind; readonly config: Record<string, unknown> };
  /** Already decrypted by the caller; `null` for a store that holds none. */
  readonly secret: string | null;
  /** Every bind value already literal: the form asks for one in place of a `${}`. */
  readonly inline: InlineDataset;
  /** The caller went away: abort the read and answer nothing useful. */
  readonly signal?: AbortSignal;
  /** Overridable so a test can prove the backstop without waiting a minute. */
  readonly backstopMs?: number;
}

/**
 * #1600 C1q-c — read the first rows of an inline Table or Query, as the Source
 * tab's Preview shows them. NEVER throws: the caller is an HTTP handler, and an
 * adapter fault must reach the operator as a sentence, not a 500.
 *
 * THE READ IS LOOKUP'S. It dispatches the store adapter's own `lookup` arm on a
 * synthetic context, so Preview inherits that read whole: the same reader the
 * run uses (sqlite opened read-only; postgres inside `BEGIN READ ONLY`, always
 * rolled back), its row and byte caps, and its JSON-safe row values. A preview
 * cannot show rows the run would read differently, because it is not a second
 * reader.
 *
 * The checks are the run's too: `resolveInlineSource` (store kind, secret marker,
 * config) and save's literal-SQL rule, so Preview never shows rows for a source
 * that cannot be saved or would be refused at dispatch.
 *
 * CONCURRENCY is probe's split (`connectors/probe.ts`): the slot is held until
 * the REAL read settles, and the caller is answered on its own timer.
 */
export async function previewInlineSource(
  args: PreviewInlineSourceArgs,
): Promise<DatasetPreviewResult> {
  const { registry, connection, secret, inline, signal, backstopMs = PREVIEW_BACKSTOP_MS } = args;

  const sqlIssue = inlineQuerySqlIssue(inline.kind, inline.config);
  if (sqlIssue !== null) return { ok: false, error: sqlIssue };
  const resolved = resolveInlineSource(inline, connection.kind);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const adapter = registry.get(connection.kind);
  if (adapter === undefined) {
    return { ok: false, error: `no adapter for connection kind '${connection.kind}'` };
  }

  const controller = new AbortController();
  const onCallerAbort = () => stop('the preview was cancelled');
  const timer = setTimeout(
    () =>
      stop(`the preview did not finish within ${Math.round(backstopMs / 1000)}s and was stopped`),
    backstopMs,
  );
  timer.unref?.();
  let settle!: (result: DatasetPreviewResult) => void;
  let settled = false;
  const answer = new Promise<DatasetPreviewResult>((resolve) => {
    // Once the caller has its answer nothing needs the timer or the listener,
    // however it was answered: the read, the backstop or the caller leaving.
    // The SLOT is a separate matter and stays held until the read ends.
    settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      resolve(result);
    };
  });
  function stop(error: string) {
    settle({ ok: false, error });
    controller.abort();
  }
  if (signal?.aborted === true) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });

  void previewLimit(async () => {
    // Answered while queued (the backstop, or the caller left): reading now
    // would spend a session on rows nobody will see.
    if (settled) return;
    try {
      settle(await readPrefix(args, adapter, resolved.dataset, controller.signal));
    } catch (err) {
      // An adapter's stream threw rather than yielding `failed`. Its message is
      // the least trusted string here, so it is redacted like a failure's.
      settle({
        ok: false,
        error: redactSecrets(err instanceof Error ? err.message : String(err), [secret]),
      });
    }
  });

  return answer;
}

async function readPrefix(
  args: PreviewInlineSourceArgs,
  adapter: ConnectorAdapter,
  dataset: ResolvedDataset,
  signal: AbortSignal,
): Promise<DatasetPreviewResult> {
  const events = adapter.runActivity(
    {
      runId: PREVIEW_ID,
      nodeId: PREVIEW_ID,
      attemptId: PREVIEW_ID,
      activityType: LOOKUP_ACTIVITY_TYPE,
      input: {},
      connectionConfig: args.connection.config,
      datasets: { source: dataset },
      signal,
    },
    args.secret,
  );
  for await (const event of events) {
    if (event.type === 'failed') {
      return { ok: false, error: redactSecrets(event.error, [args.secret]) };
    }
    if (event.type === 'succeeded') return prefixOf(event.outputs);
  }
  return { ok: false, error: 'the store ended the read without an answer' };
}

/** Lookup's `{ rows, truncated }` as the preview's first `PREVIEW_ROW_CAP` rows. */
function prefixOf(outputs: Record<string, unknown>): DatasetPreviewResult {
  const all = Array.isArray(outputs['rows']) ? (outputs['rows'] as Record<string, unknown>[]) : [];
  const rows = all.slice(0, PREVIEW_ROW_CAP);
  const capped = outputs['truncated'] === true;
  const truncated = capped || all.length > rows.length;
  // Lookup stopped on its byte cap before the preview's row cap: say so, or a
  // short or empty table reads as a short or empty source.
  if (capped && rows.length < PREVIEW_ROW_CAP) {
    const limit = `${LOOKUP_BYTE_CAP / (1024 * 1024)} MiB`;
    const note =
      rows.length === 0
        ? `The first row alone is larger than the ${limit} preview limit, so no rows are shown. Select fewer or narrower columns.`
        : `Only the first ${rows.length} rows fit in the ${limit} preview limit.`;
    return { ok: true, rows, truncated, note };
  }
  return { ok: true, rows, truncated };
}
