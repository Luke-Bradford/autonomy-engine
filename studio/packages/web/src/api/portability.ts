import {
  ExportEnvelopeSchema,
  ImportResultSchema,
  type ImportAttentionItem,
  type ImportResult,
} from '@autonomy-studio/shared';
import { apiFetch, apiFetchText } from './client';

/**
 * Portability (P1c): getting a resource OUT of the workspace as a
 * version-stamped envelope, and bringing one back IN.
 *
 * The server has carried this whole subsystem since P1c — three export routes
 * and `POST /api/import` — and `packages/web/src` called none of them, so an
 * operator could neither back a pipeline up, share one, nor move one between
 * workspaces (#959).
 *
 * SECURITY: no secret material crosses either way, and that is the SERVER's
 * guarantee, not this module's. A connection export never carries its
 * ciphertext (`ConnectionExportDataSchema.requiresSecret` is a boolean), a
 * trigger export never carries its `webhook.secretRef`, and a pipeline export
 * nulls every node's `connectionId`. What arrives instead is an
 * `ImportAttentionItem` per missing binding — which is exactly why rendering
 * `attention` is not optional garnish (see `describeAttention`).
 */

/**
 * A file the operator picked that this app could not read as JSON at all.
 * Distinct from an `ApiError`, because nothing was sent: it is a local,
 * instant refusal naming the file, not a server verdict.
 */
export class EnvelopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeParseError';
  }
}

function exportPath(collection: string, id: string): string {
  return `/api/${collection}/${encodeURIComponent(id)}/export`;
}

/**
 * The pipeline + ALL of its versions, as canonical-JSON text.
 *
 * Returns TEXT, not a parsed object: see `apiFetchText` for why the bytes are
 * the payload here and must not be round-tripped through a client-side schema.
 */
export function exportPipeline(id: string, signal?: AbortSignal): Promise<string> {
  return apiFetchText(exportPath('pipelines', id), { signal });
}

export function exportConnection(id: string, signal?: AbortSignal): Promise<string> {
  return apiFetchText(exportPath('connections', id), { signal });
}

export function exportTrigger(id: string, signal?: AbortSignal): Promise<string> {
  return apiFetchText(exportPath('triggers', id), { signal });
}

/**
 * Read a picked file's text as the value `POST /api/import` expects.
 *
 * This checks two things and DELIBERATELY not a third. It checks that the text
 * is JSON, and that it is a JSON *object* — because a picked file can be
 * anything on the operator's disk, and "notes.txt is not a JSON file" is a
 * better answer than a Fastify body-parse 400 that names nothing.
 *
 * It does NOT check `schemaVersion` or `catalogVersion`, and it does not judge
 * whether a `kind` is importable. `parseAndUpgradeEnvelope` on the server is
 * the single authority on that, and it owns the message. A second copy of the
 * version/upgrade rules here would start refusing envelopes the server accepts
 * the moment either advanced.
 *
 * `foreignEnvelopeKind` below is a DIFFERENT question — "does this file belong
 * on the page I am standing on" — which the server cannot answer because it
 * does not know which page asked.
 */
export function parseEnvelopeText(text: string, filename?: string): unknown {
  const named = filename === undefined ? 'That file' : `“${filename}”`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvelopeParseError(`${named} is not a JSON file.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvelopeParseError(`${named} does not contain an export envelope.`);
  }
  return parsed;
}

/**
 * The kinds an envelope can declare, from the schema that defines them rather
 * than a hand-written list — so this cannot drift from `ExportEnvelopeSchema`.
 */
const ENVELOPE_KINDS: ReadonlySet<string> = new Set(
  ExportEnvelopeSchema.options.map((member) => member.shape.kind.value),
);

/**
 * The kind this envelope declares, when it is a kind this build knows AND it is
 * not the kind of the list the operator is standing on. `null` otherwise —
 * meaning "send it".
 *
 * This exists so a mis-picked file is refused BEFORE any request. `POST
 * /api/import` takes all three kinds and mints a resource for whichever it
 * gets, so dropping a connection export on the Triggers list would otherwise
 * succeed — creating a real row on a page that cannot show it, which the
 * operator then has to find and delete. There is no dry-run to fall back on.
 *
 * It is deliberately NOT a general "is this importable" gate, which would be a
 * second authority on the server's own rules. An unrecognised `kind` returns
 * `null` and goes to the server, so a v2 envelope this build has never heard of
 * is judged by the thing that knows — never refused here. The only claim made
 * locally is the one the server cannot make: which page asked.
 */
export function foreignEnvelopeKind(
  envelope: unknown,
  listKind: ImportResult['kind'],
): ImportResult['kind'] | null {
  const kind: unknown = (envelope as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !ENVELOPE_KINDS.has(kind)) return null;
  return kind === listKind ? null : (kind as ImportResult['kind']);
}

/** `POST /api/import` — the one entry point for every envelope kind. */
export function importEnvelope(envelope: unknown): Promise<ImportResult> {
  return apiFetch('/api/import', {
    method: 'POST',
    body: envelope,
    schema: ImportResultSchema,
  });
}

/**
 * One sentence per attention item: what the import could NOT carry, and the
 * act that repairs it. Authored here rather than in the panel for the reason
 * `describeDeleteFailure` is authored in `pipelines.ts` — the sentence is the
 * contract, and two hand-written copies drift.
 */
export function describeAttention(item: ImportAttentionItem): string {
  switch (item.type) {
    case 'unresolvedConnectionRef':
      return `Node “${item.nodeId}” has no connection — every export drops connection bindings. Open the pipeline and pick a connection for it, then save.`;
    case 'requiresSecret':
      return 'This connection needs its secret — an export never carries one. Edit the connection and enter it before anything can call the provider.';
    case 'unboundPipelineVersion':
      return 'This trigger is not bound to a pipeline version — every export drops the binding, and an unbound trigger will never fire. Edit the trigger and bind it.';
    case 'requiresWebhookSecret':
      return 'This webhook trigger needs a fresh webhook secret — an export never carries one. Provision one from the trigger before calling its URL.';
  }
}

/** What an import actually created, flattened across the result's three kinds. */
export interface ImportedResource {
  kind: ImportResult['kind'];
  id: string;
  name: string;
  /**
   * A fact about the created resource that is NOT in `attention[]` and that
   * the operator would otherwise have to discover by watching nothing happen.
   */
  note?: string;
}

export function describeImported(result: ImportResult): ImportedResource {
  switch (result.kind) {
    case 'pipeline':
      return { kind: 'pipeline', id: result.pipeline.id, name: result.pipeline.name };
    case 'connection':
      return { kind: 'connection', id: result.connection.id, name: result.connection.name };
    case 'trigger':
      // `importTriggerEnvelope` forces `enabled: false` as a second line of
      // defence behind the scheduler's null-binding refusal, and that is not
      // reported as an attention item. Said here, or a rebound trigger sits
      // silently doing nothing.
      return {
        kind: 'trigger',
        id: result.trigger.id,
        name: result.trigger.name,
        note: 'Imported triggers arrive disabled — enable it once it is bound.',
      };
  }
}

/**
 * The id an import minted. Names are NOT unique after an import — `/api/import`
 * mints a fresh id and does not dedupe by name, so importing the same file
 * twice leaves two resources called the same thing — which is why every
 * surface that reports an import names the id, not just the name.
 */
export function importedResourceId(result: ImportResult): string {
  return describeImported(result).id;
}
