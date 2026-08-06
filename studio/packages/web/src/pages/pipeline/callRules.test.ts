import { describe, expect, it } from 'vitest';
import type { Param } from '@autonomy-studio/shared';
import { buildParams, sameSeed, storedBlankKeys, type Seed } from './callRules';

/**
 * #425 — the call editor's pure half, tested directly, on the
 * `containerRules.test.ts` / `paramRules.test.ts` precedent.
 *
 * `seedCall`'s read model and the mode switch are exercised through the panel in
 * `CallPanel.test.tsx`, where the rendering is the point. What is here is the two
 * rules a panel test would only reach incidentally: which blank means "send
 * nothing", and what counts as the same seed.
 */

function param(name: string, type: Param['type']): Param {
  return { name, type, required: false };
}

const DECLARED = new Map([
  ['query', param('query', 'string')],
  ['limit', param('limit', 'number')],
]);

const SEED: Seed = {
  mode: 'pick',
  pipelineId: 'p1',
  versionId: 'v1',
  expression: '',
  wait: false,
  params: { query: 'ships' },
  paramsJson: '',
};

describe('buildParams', () => {
  it('omits a blank row so the child default applies', () => {
    const built = buildParams({ query: '', limit: '25' }, DECLARED);
    expect(built).toEqual({ ok: true, value: { limit: 25 } });
  });

  it('PRESERVES a blank the node already carries as an explicit empty string', () => {
    // The loss this guards: `formatDefaultInput('')` renders a stored `''` as a
    // blank row, indistinguishable on screen from "nothing entered". Without
    // this, opening the node, editing some OTHER field and pressing Apply would
    // drop the argument silently.
    const built = buildParams({ query: '', limit: '25' }, DECLARED, storedBlankKeys(undefined));
    expect(built).toEqual({ ok: true, value: { limit: 25 } });

    const stored = storedBlankKeys({ pipelineVersionId: 'v1', params: { query: '' } });
    const kept = buildParams({ query: '', limit: '25' }, DECLARED, stored);
    expect(kept).toEqual({ ok: true, value: { query: '', limit: 25 } });
  });

  it('still omits a row the operator CLEARED, even beside a stored blank', () => {
    // `limit` held a real value and was cleared — that is how "let the child
    // decide" is said, and it must keep meaning that.
    const stored = storedBlankKeys({
      pipelineVersionId: 'v1',
      params: { query: '', limit: 25 },
    });
    expect(buildParams({ query: '', limit: '' }, DECLARED, stored)).toEqual({
      ok: true,
      value: { query: '' },
    });
  });

  it('stores a ${} value verbatim rather than coercing it against the declared type', () => {
    expect(buildParams({ limit: '${params.n}' }, DECLARED)).toEqual({
      ok: true,
      value: { limit: '${params.n}' },
    });
  });

  it('reports the offending row by name when a value does not fit its type', () => {
    const built = buildParams({ limit: 'nope' }, DECLARED);
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain('limit');
  });
});

describe('storedBlankKeys', () => {
  it('names only the keys stored as an explicit empty string', () => {
    expect(
      storedBlankKeys({ pipelineVersionId: 'v1', params: { a: '', b: 'x', c: 0, d: null } }),
    ).toEqual(new Set(['a']));
    expect(storedBlankKeys(undefined)).toEqual(new Set());
  });
});

describe('sameSeed', () => {
  it('is TRUE for an equal seed whose params were built in a different key order', () => {
    // The whole reason this is field-wise rather than `JSON.stringify` — a
    // spurious inequality re-seeds the form and clobbers an in-progress edit.
    const a: Seed = { ...SEED, params: { query: 'ships', limit: '25' } };
    const b: Seed = { ...SEED, params: { limit: '25', query: 'ships' } };
    expect(sameSeed(a, b)).toBe(true);
  });

  it('is FALSE on any field that differs', () => {
    expect(sameSeed(SEED, { ...SEED, mode: 'expression' })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, versionId: 'v2' })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, wait: true })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, expression: '${params.t}' })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, paramsJson: '{}' })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, params: { query: 'boats' } })).toBe(false);
    expect(sameSeed(SEED, { ...SEED, params: { query: 'ships', extra: '' } })).toBe(false);
  });
});
