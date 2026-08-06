import { describe, expect, it } from 'vitest';
import { paramDefaultDefect, resolveRunParams, validatePipelineDoc } from '../params.js';
import type { Node, Param, ParamType } from '../../index.js';

const NODE: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };

function doc(params: Param[]) {
  return { params, nodes: [NODE], edges: [], containers: [] };
}

/**
 * #843 — a param whose `default` disagrees with its declared `type` used to save
 * clean and fail only at run start, inside a version that is IMMUTABLE and so
 * could never be repaired, only re-authored.
 *
 * `paramDefaultDefect` is not a mirror of run-start resolution — it IS run-start
 * resolution, over one param. These tests therefore cannot catch it "drifting
 * from `coerce`" (nothing can; there is one implementation). What they pin is
 * the ACCEPTED SET itself, so a later narrowing or widening of `coerce` is a
 * visible decision rather than a silent change to what the save gate refuses.
 */
describe('paramDefaultDefect — the accepted set', () => {
  const ACCEPTED: { type: ParamType; value: unknown }[] = [
    { type: 'number', value: 42 },
    { type: 'number', value: -2.5 },
    // `coerce` is deliberately looser than `matchesType`: the STRING '5' is a
    // fine default for a `number` param, so refusing it would bar a save that
    // runs perfectly.
    { type: 'number', value: '5' },
    { type: 'number', value: ' 7 ' },
    { type: 'boolean', value: true },
    { type: 'boolean', value: false },
    { type: 'boolean', value: 'true' },
    { type: 'boolean', value: 'false' },
    { type: 'string', value: 'hi' },
    { type: 'string', value: '' },
    // A `json` param's value is returned as-is, so nothing about it can be wrong.
    { type: 'json', value: { a: 1 } },
    { type: 'json', value: [1, 2] },
    { type: 'json', value: 'anything' },
    { type: 'json', value: 5 },
    { type: 'secret', value: 'my.key_1-A' },
  ];

  const REFUSED: { type: ParamType; value: unknown; says: string }[] = [
    { type: 'number', value: 'abc', says: 'expected a finite number' },
    { type: 'number', value: Infinity, says: 'expected a finite number' },
    { type: 'number', value: true, says: 'expected a finite number' },
    { type: 'number', value: '1e400', says: 'expected a finite number' },
    { type: 'boolean', value: 'yes', says: 'expected boolean' },
    { type: 'boolean', value: 1, says: 'expected boolean' },
    { type: 'string', value: 7, says: 'expected string' },
    { type: 'string', value: null, says: 'expected string' },
    { type: 'secret', value: 'has space', says: 'credential label' },
    { type: 'secret', value: 'a'.repeat(65), says: 'credential label' },
    { type: 'secret', value: 42, says: 'credential label' },
  ];

  for (const { type, value } of ACCEPTED) {
    it(`accepts a ${type} default of ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(paramDefaultDefect({ name: 'x', type, required: false, default: value })).toBeNull();
    });
  }

  for (const { type, value, says } of REFUSED) {
    it(`refuses a ${type} default of ${JSON.stringify(value) ?? String(value)}`, () => {
      const defect = paramDefaultDefect({ name: 'x', type, required: false, default: value });
      expect(defect).toContain(says);
      // The message names its subject, because a doc-level badge lists it beside
      // issues about other params.
      expect(defect).toContain("param 'x'");
    });
  }

  it('never echoes a secret default, whatever was pasted there', () => {
    const defect = paramDefaultDefect({
      name: 'k',
      type: 'secret',
      required: false,
      default: 'sk-live-REAL CREDENTIAL',
    });
    expect(defect).not.toBeNull();
    expect(defect).not.toContain('sk-live');
  });

  it('reports nothing for a param with NO default key, required or not', () => {
    // Load-bearing, not a formality: `resolveRunParams` THROWS
    // `required param 'r' has no value` for exactly this param, so a predicate
    // that skipped the guard would refuse every well-formed required param and
    // make the save gate unusable.
    expect(paramDefaultDefect({ name: 'r', type: 'string', required: true })).toBeNull();
    expect(paramDefaultDefect({ name: 'o', type: 'number', required: false })).toBeNull();
  });

  it('reports on a REQUIRED param that carries a bad default', () => {
    // `resolveRunParams` reads `hasOwnProperty(p, 'default')` BEFORE `p.required`,
    // so a required param resolves FROM its default and fails at run exactly like
    // an optional one. Skipping the check for required params would stay silent
    // about a guaranteed failure.
    expect(paramDefaultDefect({ name: 'r', type: 'number', required: true, default: 'abc' })).toBe(
      "param 'r': expected a finite number",
    );
  });

  it('is a pure predicate — it does not mutate the param', () => {
    const p: Param = { name: 'x', type: 'number', required: false, default: 'abc' };
    paramDefaultDefect(p);
    expect(p).toEqual({ name: 'x', type: 'number', required: false, default: 'abc' });
  });

  it('a default it accepts is one `resolveRunParams` accepts, and vice versa', () => {
    // The agreement is by CONSTRUCTION (the predicate calls the resolver), so
    // this asserts the construction has not been replaced by a copy.
    for (const { type, value } of [...ACCEPTED, ...REFUSED]) {
      const p: Param = { name: 'x', type, required: false, default: value };
      let engineRejects = false;
      try {
        resolveRunParams({ params: [p] }, {});
      } catch {
        engineRejects = true;
      }
      expect(paramDefaultDefect(p) !== null).toBe(engineRejects);
    }
  });
});

describe('the save gate refuses a default the run would reject (#843)', () => {
  it('reports the defect from `validatePipelineDoc`', () => {
    expect(
      validatePipelineDoc(doc([{ name: 'n', type: 'number', required: false, default: 'abc' }])),
    ).toEqual(["param 'n': expected a finite number"]);
  });

  it('accepts a default the run resolves', () => {
    expect(
      validatePipelineDoc(doc([{ name: 'n', type: 'number', required: false, default: 5 }])),
    ).toEqual([]);
  });

  it('reports every offending param, not just the first', () => {
    expect(
      validatePipelineDoc(
        doc([
          { name: 'a', type: 'number', required: false, default: 'x' },
          { name: 'b', type: 'string', required: false, default: 7 },
        ]),
      ),
    ).toEqual(["param 'a': expected a finite number", "param 'b': expected string"]);
  });

  it('reports ONE issue for a non-finite `number` default, not two', () => {
    // #547's replay-safety walk fires on the same value ("cannot be durably
    // replayed"), and the type defect is the more useful of the two answers for
    // someone who typed it into a `number` field. Two sentences about one field
    // read as two separate problems.
    expect(
      validatePipelineDoc(doc([{ name: 'n', type: 'number', required: false, default: Infinity }])),
    ).toEqual(["param 'n': expected a finite number"]);
  });

  it('still reports #547 replay safety where the type check cannot see it', () => {
    // A `json` default passes `coerce` untouched, so the non-finite inside it is
    // caught ONLY by the replay-safety walk. Suppressing that would reopen #547.
    const issues = validatePipelineDoc(
      doc([{ name: 'j', type: 'json', required: false, default: { a: Infinity } }]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('replayed');
  });
});
