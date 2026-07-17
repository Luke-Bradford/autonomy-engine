import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTrigger,
  deleteTrigger,
  fireTrigger,
  listTriggers,
  provisionWebhookSecret,
  updateTrigger,
} from './triggers';

const sample = {
  id: 'trg_1',
  ownerId: 'local',
  name: 'Nightly',
  pipelineVersionId: 'plv_1',
  params: {},
  mode: 'schedule' as const,
  schedule: '0 2 * * *',
  webhook: null,
  concurrency: { policy: 'skip_if_running' as const },
  runWindows: null,
  recurrence: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function stubFetch(status: number, jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(jsonBody),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('triggers API', () => {
  it('lists triggers and hits GET /api/triggers', async () => {
    const fetchMock = stubFetch(200, [sample]);
    const out = await listTriggers();
    expect(out).toEqual([sample]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/triggers');
  });

  it('parses a realistic (already-stripped) webhook config from a list response', async () => {
    // The server sends TriggerPublic — webhook.secretRef ALREADY removed. The
    // client re-parses that body through TriggerPublicSchema, so the public
    // webhook schema must accept a config with NO secretRef (idempotent) or the
    // whole list load throws. This is the real server shape, not a synthetic one.
    const provisioned = {
      ...sample,
      mode: 'webhook' as const,
      schedule: null,
      webhook: { idempotencyWindowSeconds: 300 },
    };
    const out = await stubbedList(provisioned);
    expect(out[0]!.webhook).toEqual({ idempotencyWindowSeconds: 300 });
  });

  it('defensively strips a stray webhook.secretRef were the server to leak one', async () => {
    const leaky = {
      ...sample,
      mode: 'webhook' as const,
      schedule: null,
      webhook: { secretRef: 'sec_leak', foo: 'bar' },
    };
    const out = await stubbedList(leaky);
    expect(out[0]!.webhook).toEqual({ foo: 'bar' });
  });

  async function stubbedList(row: unknown) {
    stubFetch(200, [row]);
    return listTriggers();
  }

  it('creates a trigger via POST with a JSON body', async () => {
    const fetchMock = stubFetch(201, sample);
    await createTrigger({
      name: 'Nightly',
      pipelineVersionId: 'plv_1',
      params: {},
      mode: 'schedule',
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/triggers');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string).name).toBe('Nightly');
  });

  it('patches a trigger via PATCH and encodes the id', async () => {
    const fetchMock = stubFetch(200, sample);
    await updateTrigger('trg/1', { enabled: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/triggers/trg%2F1');
    expect(init?.method).toBe('PATCH');
  });

  it('deletes a trigger via DELETE (204, no body)', async () => {
    const fetchMock = stubFetch(204, undefined);
    await expect(deleteTrigger('trg_1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
  });

  it('fires a trigger and parses the 202 fire result', async () => {
    const fetchMock = stubFetch(202, { outcome: 'started', runId: 'run_9' });
    const out = await fireTrigger('trg_1');
    expect(out).toEqual({ outcome: 'started', runId: 'run_9' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/triggers/trg_1/fire');
    expect(init?.method).toBe('POST');
  });

  it('rejects a fire result with an unknown outcome (schema contract)', async () => {
    stubFetch(202, { outcome: 'exploded' });
    await expect(fireTrigger('trg_1')).rejects.toThrow();
  });

  it('provisions a webhook secret and returns the once-only plaintext', async () => {
    const fetchMock = stubFetch(200, { secret: 'sk_abc', deliveryUrl: '/api/webhooks/trg_1' });
    const out = await provisionWebhookSecret('trg_1');
    expect(out).toEqual({ secret: 'sk_abc', deliveryUrl: '/api/webhooks/trg_1' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/triggers/trg_1/webhook-secret');
  });
});
