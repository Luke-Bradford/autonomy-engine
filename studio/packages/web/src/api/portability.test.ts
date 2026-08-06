import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  EnvelopeParseError,
  describeAttention,
  describeImported,
  exportPipeline,
  importEnvelope,
  parseEnvelopeText,
} from './portability';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('exportPipeline', () => {
  it('returns the response bytes VERBATIM, without reformatting them', async () => {
    // Canonical JSON (#3 G1) is a byte contract: identical content must
    // download as identical bytes. The fixture is deliberately NOT a fixed
    // point of `JSON.stringify(JSON.parse(x))` — unsorted keys, pretty-printed,
    // surrounding whitespace — so a client that parsed and re-serialized (or
    // round-tripped through a Zod schema, which would also STRIP the unknown
    // key) returns a different string and this test goes red. A compact,
    // already-sorted fixture would survive every one of those and prove
    // nothing; it did, until this comment was written.
    const canonical = '\n{\n  "schemaVersion": 1,\n  "kind": "pipeline",\n  "unknownToClient": 7\n}\n';
    fetchMock.mockResolvedValue(
      new Response(canonical, { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(exportPipeline('pl_1')).resolves.toBe(canonical);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pipelines/pl_1/export',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('encodes the id into the path', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await exportPipeline('pl/1 2');

    expect(fetchMock).toHaveBeenCalledWith('/api/pipelines/pl%2F1%202/export', expect.anything());
  });

  it('reports a non-2xx through the shared error mapping, not as a saved file', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: 'not_found', message: 'pipeline "pl_9" not found' }),
    );

    // The point of fetching rather than using a bare `<a download>`: the
    // failure surfaces here instead of landing on the operator's disk.
    await expect(exportPipeline('pl_9')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'pipeline "pl_9" not found',
    });
  });
});

describe('parseEnvelopeText', () => {
  it('parses a JSON file into the value the import route wants', () => {
    expect(parseEnvelopeText('{"kind":"pipeline"}')).toEqual({ kind: 'pipeline' });
  });

  it('refuses a file that is not JSON at all, locally and by name', () => {
    // A picked file can be anything on the operator's disk. Naming the file
    // beats a Fastify body-parse 400 that names nothing.
    expect(() => parseEnvelopeText('not json', 'notes.txt')).toThrow(EnvelopeParseError);
    expect(() => parseEnvelopeText('not json', 'notes.txt')).toThrow(/notes\.txt/);
  });

  it('refuses a JSON scalar — an envelope is an object', () => {
    expect(() => parseEnvelopeText('42')).toThrow(EnvelopeParseError);
  });

  it('does NOT judge the envelope kind or version — the server is that authority', () => {
    // Deliberately no local `kind` gate. `/api/import` accepts pipeline,
    // connection and trigger envelopes and owns the refusal message; a second
    // copy of that rule here would refuse an envelope the server accepts the
    // moment a fourth kind is added.
    expect(parseEnvelopeText('{"kind":"connection"}')).toEqual({ kind: 'connection' });
    expect(parseEnvelopeText('{"kind":"something-new","schemaVersion":99}')).toEqual({
      kind: 'something-new',
      schemaVersion: 99,
    });
  });
});

describe('importEnvelope', () => {
  it('POSTs the parsed envelope and returns the typed result', async () => {
    const result = {
      kind: 'pipeline',
      pipeline: {
        id: 'pl_new',
        resourceId: 'res_1',
        ownerId: 'own_1',
        name: 'Imported',
        concurrency: 1,
        archived: false,
        createdAt: 1_754_438_400_000,
        updatedAt: 1_754_438_400_000,
      },
      versions: [],
      attention: [{ type: 'unresolvedConnectionRef', nodeId: 'n1' }],
    };
    fetchMock.mockResolvedValue(jsonResponse(201, result));

    await expect(importEnvelope({ kind: 'pipeline' })).resolves.toMatchObject({
      kind: 'pipeline',
      pipeline: { id: 'pl_new' },
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/import');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ kind: 'pipeline' }));
  });

  it('surfaces the server refusal message for an envelope it will not take', async () => {
    // A fresh `Response` per call: a body can only be read once, so a single
    // shared instance would make the second assertion fail on a consumed
    // stream rather than on what it is testing.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(400, {
          error: 'import_failed',
          message: 'Cannot import: catalogVersion 99 is newer than this build supports (3)',
        }),
      ),
    );

    await expect(importEnvelope({})).rejects.toBeInstanceOf(ApiError);
    await expect(importEnvelope({})).rejects.toThrow(/newer than this build supports/);
  });
});

describe('describeAttention', () => {
  it('says what the operator must do next for every attention type', () => {
    // Every branch is reachable: the panel takes ANY export file, so a
    // connection's or a trigger's attention items land in the same list.
    expect(describeAttention({ type: 'unresolvedConnectionRef', nodeId: 'send' })).toMatch(/send/);
    expect(describeAttention({ type: 'requiresSecret' })).toMatch(/secret/i);
    expect(describeAttention({ type: 'unboundPipelineVersion' })).toMatch(/never fire/i);
    expect(describeAttention({ type: 'requiresWebhookSecret' })).toMatch(/webhook/i);
  });
});

describe('describeImported', () => {
  it('names a created pipeline by id, because names are not unique after import', () => {
    const described = describeImported({
      kind: 'pipeline',
      pipeline: { id: 'pl_new', name: 'Imported' },
      versions: [{ id: 'v1' }, { id: 'v2' }],
      attention: [],
      // The describer reads only the fields it names; the rest of the
      // ImportResult shape is the server's business.
    } as never);

    expect(described).toMatchObject({ kind: 'pipeline', id: 'pl_new', name: 'Imported' });
  });

  it('warns that an imported trigger arrives DISABLED as well as unbound', () => {
    // `importTriggerEnvelope` forces `enabled: false`, and that is NOT one of
    // the `attention` items — a panel that rendered `attention` alone would
    // leave the operator believing a re-bound trigger will fire.
    const described = describeImported({
      kind: 'trigger',
      trigger: { id: 'trg_new', name: 'Nightly' },
      attention: [],
    } as never);

    expect(described).toMatchObject({ kind: 'trigger', id: 'trg_new' });
    expect(described.note).toMatch(/disabled/i);
  });

  it('has no extra note for a connection', () => {
    const described = describeImported({
      kind: 'connection',
      connection: { id: 'conn_new', name: 'OpenAI' },
      attention: [],
    } as never);

    expect(described).toMatchObject({ kind: 'connection', id: 'conn_new' });
    expect(described.note).toBeUndefined();
  });
});
