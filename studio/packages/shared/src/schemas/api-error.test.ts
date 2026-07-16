import { describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from './api-error.js';

describe('ApiErrorBodySchema', () => {
  it('parses a message-only branch (not_found / conflict / bad_request / import_error)', () => {
    const body = { error: 'not_found', message: 'connection "x" not found' };
    expect(ApiErrorBodySchema.parse(body)).toEqual(body);
  });

  it('parses the validation_error branch with capped-issue markers (#496)', () => {
    const body = {
      error: 'validation_error',
      issues: [
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ],
      truncated: true,
      totalIssues: 152,
    };
    expect(ApiErrorBodySchema.parse(body)).toEqual(body);
  });

  it('parses the invalid_pipeline_doc branch (message + object-shaped issues)', () => {
    const body = {
      error: 'invalid_pipeline_doc',
      message: 'node "n1": unknown activity',
      issues: [{ message: 'node "n1": unknown activity' }],
    };
    expect(ApiErrorBodySchema.parse(body)).toEqual(body);
  });

  it('parses the empty body (every field is optional — matches the pre-existing interface)', () => {
    expect(ApiErrorBodySchema.parse({})).toEqual({});
  });

  it('does NOT manufacture absent truncation markers (the #496/F13a absence-is-signal contract)', () => {
    const parsed = ApiErrorBodySchema.parse({ error: 'validation_error', issues: [] });
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.totalIssues).toBeUndefined();
  });

  it('rejects a wrong-typed known field (a genuine contract violation)', () => {
    expect(ApiErrorBodySchema.safeParse({ message: 5 }).success).toBe(false);
    expect(ApiErrorBodySchema.safeParse({ totalIssues: 'lots' }).success).toBe(false);
    expect(ApiErrorBodySchema.safeParse({ issues: [{ path: 7 }] }).success).toBe(false);
  });

  it('tolerates and strips an unknown future field (client forward-compat)', () => {
    const parsed = ApiErrorBodySchema.parse({ error: 'not_found', futureField: true });
    expect(parsed).toEqual({ error: 'not_found' });
    expect('futureField' in parsed).toBe(false);
  });

  it('accepts every known error code the central handler emits', () => {
    for (const error of [
      'validation_error',
      'not_found',
      'conflict',
      'import_error',
      'invalid_pipeline_doc',
      'bad_request',
      'internal_error',
    ]) {
      expect(ApiErrorBodySchema.parse({ error }).error).toBe(error);
    }
  });

  it('degrades an UNRECOGNISED future code to undefined but keeps the rest (client forward-compat)', () => {
    // A newer server sending a code this build does not know must NOT collapse
    // the whole body — `message` still surfaces to the (older) client. The
    // `error` field alone drops to undefined via `.catch`; the parse succeeds.
    const parsed = ApiErrorBodySchema.parse({ error: 'rate_limited', message: 'slow down' });
    expect(parsed.error).toBeUndefined();
    expect(parsed.message).toBe('slow down');
  });
});
