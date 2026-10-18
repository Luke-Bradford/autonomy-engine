import { describe, expect, it } from 'vitest';
import {
  getActivity,
  HTTP_SECRET_HEADERS_FIELD,
  WEB_ACTIVITY_TYPE,
  WEB_DEFAULT_MAX_RESPONSE_BYTES,
  WEB_MAX_REQUEST_TIMEOUT_SECONDS,
  WEB_MAX_RESPONSE_BYTES,
  webConfigSchema,
  type Node,
} from '../../index.js';
import { activityNodeErrors } from '../../engine/activity-config-check.js';

const issuesOf = (cfg: Record<string, unknown>) => {
  const r = webConfigSchema.safeParse(cfg);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('web config (#1600 OR41 C11a)', () => {
  it("defaults to ADF's: a GET that fails on an HTTP error, JSON, 4 MB", () => {
    expect(webConfigSchema.parse({ url: '/x' })).toEqual({
      url: '/x',
      method: 'GET',
      failOnHttpError: true,
      parseAs: 'json',
      maxResponseBytes: WEB_DEFAULT_MAX_RESPONSE_BYTES,
      whenOverLimit: 'fail',
      retryOnThrottle: true,
    });
    expect(WEB_DEFAULT_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('needs a URL, and takes only the listed methods', () => {
    expect(issuesOf({})).toHaveLength(1);
    expect(issuesOf({ url: '' })).toHaveLength(1);
    expect(issuesOf({ url: '/x', method: 'OPTIONS' })).toHaveLength(1);
    expect(issuesOf({ url: '/x', method: 'HEAD' })).toEqual([]);
  });

  it('bounds the timeout at ten minutes and Max size at the read ceiling', () => {
    expect(
      issuesOf({ url: '/x', httpRequestTimeoutSeconds: WEB_MAX_REQUEST_TIMEOUT_SECONDS }),
    ).toEqual([]);
    expect(
      issuesOf({ url: '/x', httpRequestTimeoutSeconds: WEB_MAX_REQUEST_TIMEOUT_SECONDS + 1 }),
    ).toHaveLength(1);
    expect(issuesOf({ url: '/x', httpRequestTimeoutSeconds: 0 })).toHaveLength(1);
    expect(issuesOf({ url: '/x', maxResponseBytes: WEB_MAX_RESPONSE_BYTES })).toEqual([]);
    expect(issuesOf({ url: '/x', maxResponseBytes: WEB_MAX_RESPONSE_BYTES + 1 })).toHaveLength(1);
  });

  it('refuses a setting that would be ignored, rather than ignore it', () => {
    expect(issuesOf({ url: '/x', failOnHttpError: false, successStatusCodes: [404] })).toEqual([
      'successStatusCodes: only read when Fail on HTTP error is on',
    ]);
    expect(issuesOf({ url: '/x', whenOverLimit: 'truncate' })).toEqual([
      'whenOverLimit: Truncate needs Parse as Text: a JSON prefix is not JSON',
    ]);
    expect(issuesOf({ url: '/x', whenOverLimit: 'truncate', parseAs: 'text' })).toEqual([]);
    expect(issuesOf({ url: '/x', successStatusCodes: [99] })).toHaveLength(1);
  });

  it('refuses a body on a GET or HEAD, but not an empty Body box', () => {
    expect(issuesOf({ url: '/x', body: 'a' })).toEqual(['body: an HTTP GET cannot carry a body']);
    expect(issuesOf({ url: '/x', method: 'HEAD', body: 'a' })).toHaveLength(1);
    expect(issuesOf({ url: '/x', body: '' })).toEqual([]);
    expect(issuesOf({ url: '/x', method: 'POST', body: 'a' })).toEqual([]);
  });

  it('takes dynamic content in its fields at save (UI STANDARD rule 4)', () => {
    const node = {
      id: 'w',
      type: WEB_ACTIVITY_TYPE,
      connectionId: 'c',
      config: {
        url: '${pipeline().parameters.url}',
        failOnHttpError: '${pipeline().parameters.strict}',
        maxResponseBytes: '${pipeline().parameters.max}',
      },
    } as unknown as Node;
    expect(activityNodeErrors(node)).toEqual([]);
    const literal = { ...node, config: { ...node.config, maxResponseBytes: 0 } } as Node;
    expect(activityNodeErrors(literal)).toHaveLength(1);
  });

  it('is a non-idempotent http activity with a secret-header sink and §4.6 outputs', () => {
    const entry = getActivity(WEB_ACTIVITY_TYPE)!;
    expect(entry).toMatchObject({
      title: 'Web',
      idempotent: false,
      connectionKinds: ['http'],
      secretSinkFields: [HTTP_SECRET_HEADERS_FIELD],
    });
    expect(entry.tabs?.map((t) => t.key)).toEqual(['request', 'auth', 'settings']);
    expect(entry.outputs.map((o) => [o.name, o.type, o.optional === true])).toEqual([
      ['status', 'number', false],
      ['headers', 'json', false],
      ['body', 'json', false],
      ['bytes', 'number', false],
      ['durationMs', 'number', false],
      ['truncated', 'boolean', false],
      // C11c fills it; declared now so a C11a node needs no contract refresh.
      ['callback', 'json', true],
    ]);
  });
});
