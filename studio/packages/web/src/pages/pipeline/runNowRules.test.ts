import { describe, expect, it } from 'vitest';
import type { Param } from '@autonomy-studio/shared';
import { buildRunNowParams, runDisabledReason, runNowRows, runTitle } from './runNowRules';

const params: Param[] = [
  { name: 'city', type: 'string', required: false, default: 'Leeds' },
  { name: 'count', type: 'number', required: true },
  { name: 'dry', type: 'boolean', required: false, default: false },
  { name: 'opts', type: 'json', required: false, default: { a: 1 } },
];

describe('runNowRows', () => {
  it('shows every declared param, prefilled with its default where it has one', () => {
    expect(runNowRows(params)).toEqual({
      city: 'Leeds',
      count: '',
      dry: 'false',
      opts: '{"a":1}',
    });
  });
});

describe('buildRunNowParams', () => {
  it('turns the rows back into typed values', () => {
    expect(
      buildRunNowParams({ city: 'York', count: '3', dry: 'true', opts: '{"b":2}' }, params),
    ).toEqual({ ok: true, value: { city: 'York', count: 3, dry: true, opts: { b: 2 } } });
  });

  it('sends nothing for a blank row, so the default applies', () => {
    expect(buildRunNowParams({ city: '', count: '1', dry: '', opts: '' }, params)).toEqual({
      ok: true,
      value: { count: 1 },
    });
  });

  it('refuses a value the type cannot take, naming the param', () => {
    expect(buildRunNowParams({ count: 'three' }, params)).toEqual({
      ok: false,
      error: 'count: expected a number',
    });
  });

  it('refuses a blank required param that has no default', () => {
    expect(buildRunNowParams({ count: '' }, params)).toEqual({
      ok: false,
      error: 'count: a value is required',
    });
  });

  it('accepts a blank required param that HAS a default — the default satisfies it', () => {
    const p: Param[] = [{ name: 'n', type: 'number', required: true, default: 2 }];
    expect(buildRunNowParams({ n: '' }, p)).toEqual({ ok: true, value: {} });
  });

  it('treats ${…} as literal text: a number param refuses it', () => {
    expect(buildRunNowParams({ count: '${params.x}' }, params).ok).toBe(false);
  });
});

describe('runDisabledReason', () => {
  const ok = { ready: true, archived: false, headVersion: 3, previewing: false };

  it('is null when there is a saved version to run', () => {
    expect(runDisabledReason(ok)).toBeNull();
  });

  it('names each refusal', () => {
    expect(runDisabledReason({ ...ok, ready: false })).toBe('Wait for the pipeline to load.');
    expect(runDisabledReason({ ...ok, archived: true })).toMatch(/archived/);
    expect(runDisabledReason({ ...ok, headVersion: null })).toMatch(/Save a version first/);
    expect(runDisabledReason({ ...ok, previewing: true })).toMatch(/Leave the preview/);
  });
});

describe('runTitle', () => {
  it('says which version runs, and that unsaved edits are left out', () => {
    expect(runTitle(3, false)).toBe('Run v3, the latest saved version.');
    expect(runTitle(3, true)).toBe(
      'Run v3, the latest saved version. Your unsaved edits are not included.',
    );
  });
});
