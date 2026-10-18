import { describe, expect, it } from 'vitest';
import {
  getActivity,
  HTTP_SECRET_HEADERS_FIELD,
  WEB_ACTIVITY_TYPE,
  WEB_DEFAULT_MAX_RESPONSE_BYTES,
  WEB_MAX_REQUEST_TIMEOUT_SECONDS,
  WEB_MAX_RESPONSE_BYTES,
  webConfigSchema,
  webCallbackBody,
  callbackReportedError,
  WEB_MAX_CALLBACK_TIMEOUT_SECONDS,
  webWaitsOnly,
  WEB_NO_REQUEST_OUTPUTS,
  timeoutApplies,
  userPropertiesApply,
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
      waitForCallback: false,
      reportStatusOnCallback: false,
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

describe('web config — Wait for callback (#1600 OR41 C11c)', () => {
  const wait = { url: '/x', method: 'POST', waitForCallback: true };

  it('is off by default, and its two settings are refused while it is off', () => {
    expect(issuesOf({ url: '/x', method: 'POST', callbackTimeoutSeconds: 60 })).toEqual([
      'callbackTimeoutSeconds: only read when Wait for callback is on',
    ]);
    expect(issuesOf({ url: '/x', method: 'POST', reportStatusOnCallback: true })).toEqual([
      'reportStatusOnCallback: only read when Wait for callback is on',
    ]);
    expect(issuesOf({ ...wait, callbackTimeoutSeconds: 60, reportStatusOnCallback: true })).toEqual(
      [],
    );
  });

  it('bounds the callback timeout at seven days', () => {
    expect(issuesOf({ ...wait, callbackTimeoutSeconds: WEB_MAX_CALLBACK_TIMEOUT_SECONDS })).toEqual(
      [],
    );
    expect(
      issuesOf({ ...wait, callbackTimeoutSeconds: WEB_MAX_CALLBACK_TIMEOUT_SECONDS + 1 }),
    ).toHaveLength(1);
    expect(issuesOf({ ...wait, callbackTimeoutSeconds: 0 })).toHaveLength(1);
  });

  it('refuses a GET or HEAD, which cannot carry callBackUri', () => {
    expect(issuesOf({ ...wait, method: 'GET' })).toEqual([
      'method: Wait for callback sends callBackUri in the body, which an HTTP GET cannot carry',
    ]);
    expect(issuesOf({ ...wait, method: 'HEAD' })).toHaveLength(1);
  });

  it('refuses a literal body that is not a JSON object, and leaves a ${} body to dispatch', () => {
    expect(issuesOf({ ...wait, body: '{"job":1}' })).toEqual([]);
    expect(issuesOf({ ...wait, body: '[1]' })).toHaveLength(1);
    expect(issuesOf({ ...wait, body: 'plain text' })).toHaveLength(1);
    expect(issuesOf({ ...wait, body: '${pipeline().parameters.payload}' })).toEqual([]);
  });

  it('adds callBackUri to the body, replacing an author key of that name', () => {
    const uri = 'http://127.0.0.1:8080/api/external-wait/tok';
    expect(webCallbackBody(undefined, uri)).toEqual({
      ok: true,
      json: JSON.stringify({ callBackUri: uri }),
    });
    expect(webCallbackBody('  ', uri)).toEqual({
      ok: true,
      json: JSON.stringify({ callBackUri: uri }),
    });
    expect(webCallbackBody('{"job":1,"callBackUri":"mine"}', uri)).toEqual({
      ok: true,
      json: JSON.stringify({ job: 1, callBackUri: uri }),
    });
    expect(webCallbackBody('null', uri).ok).toBe(false);
    expect(webCallbackBody('"s"', uri).ok).toBe(false);
  });

  it("reads ADF's reported status: StatusCode 400 or above, number or numeric string", () => {
    expect(
      callbackReportedError({
        Output: {},
        Error: { ErrorCode: 'E1', Message: 'bad input' },
        StatusCode: '403',
      }),
    ).toBe('the callback reported StatusCode 403: E1: bad input');
    expect(callbackReportedError({ StatusCode: 500 })).toBe('the callback reported StatusCode 500');
    expect(callbackReportedError({ StatusCode: 399 })).toBeUndefined();
    expect(callbackReportedError({ StatusCode: '200' })).toBeUndefined();
    expect(callbackReportedError({ StatusCode: 'oops' })).toBeUndefined();
    expect(callbackReportedError({ StatusCode: 404.5 })).toBeUndefined();
    expect(callbackReportedError({ Output: { ok: 1 } })).toBeUndefined();
    expect(callbackReportedError([{ StatusCode: 500 }])).toBeUndefined();
    expect(callbackReportedError(null)).toBeUndefined();
  });
});

describe('web config — no Request URL (#1600 OR41 C11c-2)', () => {
  it('refuses no URL, or an empty one, unless Wait for callback is on', () => {
    expect(issuesOf({})).toEqual(['url: required']);
    expect(issuesOf({ url: '' })).toEqual(['url: required']);
    expect(issuesOf({ waitForCallback: true })).toEqual([]);
    expect(issuesOf({ url: '', waitForCallback: true, callbackTimeoutSeconds: 60 })).toEqual([]);
  });

  it('accepts the default GET, which only matters when a request is sent', () => {
    expect(issuesOf({ waitForCallback: true, method: 'GET' })).toEqual([]);
    expect(issuesOf({ url: '/x', waitForCallback: true, method: 'GET' })).toHaveLength(1);
  });

  it('refuses a request setting, which has nothing to apply to', () => {
    expect(
      issuesOf({
        waitForCallback: true,
        body: '{}',
        headers: { a: 'b' },
        [HTTP_SECRET_HEADERS_FIELD]: { k: { $secret: 's' } },
        httpRequestTimeoutSeconds: 5,
        successStatusCodes: [404],
      }),
    ).toEqual([
      'body: only sent with a Request URL',
      'headers: only sent with a Request URL',
      `${HTTP_SECRET_HEADERS_FIELD}: only sent with a Request URL`,
      'httpRequestTimeoutSeconds: only sent with a Request URL',
      'successStatusCodes: only sent with a Request URL',
    ]);
    // An empty Body box is no body.
    expect(issuesOf({ waitForCallback: true, body: '' })).toEqual([]);
  });

  it('webWaitsOnly reads the stored config: Wait for callback on and no URL', () => {
    expect(webWaitsOnly({ waitForCallback: true })).toBe(true);
    expect(webWaitsOnly({ waitForCallback: true, url: '' })).toBe(true);
    expect(webWaitsOnly({ waitForCallback: true, url: '${pipeline().parameters.u}' })).toBe(false);
    expect(webWaitsOnly({ url: '' })).toBe(false);
  });
});

describe('web config — no Request URL, review follow-ups (#1600 OR41 C11c-2)', () => {
  it('an emptied table or list is not a request setting', () => {
    expect(
      issuesOf({
        waitForCallback: true,
        headers: {},
        [HTTP_SECRET_HEADERS_FIELD]: {},
        successStatusCodes: [],
      }),
    ).toEqual([]);
  });

  it('with Wait for callback off, a missing URL does not hide the other rules', () => {
    expect(issuesOf({ callbackTimeoutSeconds: 60 })).toEqual([
      'url: required',
      'callbackTimeoutSeconds: only read when Wait for callback is on',
    ]);
  });

  it('its null request outputs name every Web output but callback', () => {
    const names = getActivity(WEB_ACTIVITY_TYPE)!
      .outputs.map((o) => o.name)
      .filter((n) => n !== 'callback');
    expect(Object.keys(WEB_NO_REQUEST_OUTPUTS).sort()).toEqual(names.sort());
  });

  it('takes no activity timeout or user properties: it is never dispatched', () => {
    const node = (config: Record<string, unknown>) =>
      ({ type: WEB_ACTIVITY_TYPE, config }) as Pick<Node, 'type' | 'config'>;
    expect(timeoutApplies(node({ waitForCallback: true }))).toBe(false);
    expect(userPropertiesApply(node({ waitForCallback: true }))).toBe(false);
    expect(timeoutApplies(node({ waitForCallback: true, url: '/x' }))).toBe(true);
    expect(timeoutApplies(node({ url: '/x' }))).toBe(true);
  });
});
