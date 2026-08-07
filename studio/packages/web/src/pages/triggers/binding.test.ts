import { describe, expect, it } from 'vitest';
import {
  activeBindingAdvice,
  bindingCreateFields,
  bindingIsBound,
  bindingPatchField,
  type BindingSelection,
} from './binding';

const ACTIVE = { versionId: 'plv_2', commit: 'abc1234', blob: 'blob1' };

describe('bindingCreateFields — the wire shape of a create body', () => {
  it('sends an explicit null for a deliberately unbound trigger', () => {
    expect(bindingCreateFields({ kind: 'unbound' })).toEqual({ pipelineVersionId: null });
  });

  it('sends the concrete id for a directly-bound trigger', () => {
    expect(bindingCreateFields({ kind: 'concrete', pipelineVersionId: 'plv_7' })).toEqual({
      pipelineVersionId: 'plv_7',
    });
  });

  /*
   * The XOR keys on PRESENCE, and `JSON.stringify` keeps `null` while dropping
   * `undefined`. A bind-to-active body carrying `pipelineVersionId: null` would
   * therefore reach the server as BOTH fields supplied and 400 — so the key must
   * be absent, not nulled. `toEqual` ignores undefined-valued keys, hence the
   * explicit `in` assertion.
   */
  it('OMITS pipelineVersionId entirely when binding to active', () => {
    const fields = bindingCreateFields({ kind: 'active', pipelineId: 'pl_1' });
    expect(fields).toEqual({ bindToActive: { pipelineId: 'pl_1' } });
    expect('pipelineVersionId' in fields).toBe(false);
    expect(JSON.stringify(fields)).not.toContain('pipelineVersionId');
  });
});

describe('bindingPatchField — a PATCH is concrete-only, and says so', () => {
  it('passes a concrete binding through', () => {
    expect(bindingPatchField({ kind: 'concrete', pipelineVersionId: 'plv_7' })).toEqual({
      ok: true,
      pipelineVersionId: 'plv_7',
    });
  });

  it('sends an explicit null for a deliberately unbound trigger', () => {
    expect(bindingPatchField({ kind: 'unbound' })).toEqual({ ok: true, pipelineVersionId: null });
  });

  it('REFUSES bind-to-active rather than coercing it to null', () => {
    /*
     * The whole point. `pipelineVersionId: null` is a legal write — a disabled
     * trigger may be deliberately unbound — so a ternary falling through to
     * `null` here would be ACCEPTED by the server and would silently drop the
     * operator's binding. Unreachable today (the form does not offer
     * bind-to-active while editing); this asserts that if it ever becomes
     * reachable it is a refusal and not a silent unbind.
     */
    const result = bindingPatchField({ kind: 'active', pipelineId: 'pl_1' });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('pipelineVersionId');
    if (!result.ok) expect(result.reason).toMatch(/specific version/i);
  });
});

describe('bindingIsBound — the client mirror of assertBindableIfEnabled', () => {
  const cases: Array<[BindingSelection, boolean]> = [
    [{ kind: 'unbound' }, false],
    [{ kind: 'concrete', pipelineVersionId: 'plv_7' }, true],
    // Bind-to-active carries no concrete id client-side, but the server resolves
    // one BEFORE it runs assertBindableIfEnabled — so an enabled bind-to-active
    // create is legal and must not be refused by the mirror.
    [{ kind: 'active', pipelineId: 'pl_1' }, true],
  ];
  it.each(cases)('%o -> %s', (selection, expected) => {
    expect(bindingIsBound(selection)).toBe(expected);
  });
});

describe('activeBindingAdvice', () => {
  it('says nothing definite while the reading is in flight', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: 'loading',
      activeVersion: undefined,
    });
    expect(advice.refusal).toBeNull();
    expect(advice.text).toMatch(/checking/i);
  });

  /*
   * An unread pair must not be reported as "nothing is published" (the #979
   * ActiveVersionState doctrine), and must not refuse either: the client mirror
   * is a courtesy, the SERVER owns the gate. Refusing on a failed read would
   * block a create the server would have accepted.
   */
  it('neither claims nor refuses when the reading failed', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: 'unread',
      activeVersion: undefined,
    });
    expect(advice.refusal).toBeNull();
    expect(advice.text).toMatch(/could not check/i);
    expect(advice.text).not.toMatch(/nothing is published|never been published/i);
  });

  it('refuses, and names the act, when a git workspace has published nothing', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: { active: null, gitConnected: true },
      activeVersion: null,
    });
    expect(advice.refusal).not.toBeNull();
    expect(advice.refusal).toMatch(/publish/i);
    expect(advice.refusal).toContain('Nightly');
  });

  /* The server's refusal names an internal DB id; this one must not echo it. */
  it('does not leak an internal id in the refusal', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: { active: null, gitConnected: true },
      activeVersion: null,
    });
    expect(advice.refusal).not.toMatch(/pl_|plv_/);
  });

  it('names the version a git workspace will resolve to, and says it is a snapshot', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: { active: ACTIVE, gitConnected: true },
      activeVersion: 2,
    });
    expect(advice.refusal).toBeNull();
    expect(advice.text).toContain('v2');
    expect(advice.text).toMatch(/does not follow/i);
  });

  /*
   * A version published by another session after this page loaded is genuinely
   * active and genuinely unnameable here. It must not read as "nothing
   * published" — that is the opposite of the truth, and it must not refuse.
   */
  it('handles an active version this page cannot name', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: { active: ACTIVE, gitConnected: true },
      activeVersion: 'unnamed',
    });
    expect(advice.refusal).toBeNull();
    expect(advice.text).not.toMatch(/nothing is published/i);
    expect(advice.text).toMatch(/published/i);
  });

  it('binds to the latest version, with no publish precondition, in a DB-only workspace', () => {
    const advice = activeBindingAdvice({
      pipelineName: 'Nightly',
      reading: { active: null, gitConnected: false },
      activeVersion: null,
    });
    expect(advice.refusal).toBeNull();
    expect(advice.text).toMatch(/latest/i);
    expect(advice.text).not.toMatch(/publish a version/i);
  });
});
