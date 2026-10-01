import { describe, expect, it } from 'vitest';
import type { SubstitutionContext } from '../types.js';
import { FUNCTIONS, fnSignature, listFunctions } from '../functions.js';
import { FUNCTION_DOCS, functionDoc } from '../functionDocs.js';
import { substitute } from '../params.js';

// #1413 OR22 — every expression function says what it does, names its
// parameters and shows an example. `FUNCTIONS` is a `Record<string, …>`, so a
// function added without docs is NOT a compile error: the key-set test below is
// the only guard, and it is the one that has to stay.

function ctx(): SubstitutionContext {
  return {
    params: {},
    nodeOutputs: {},
    nodeStatuses: {},
    run: {},
    trigger: {},
    variables: {},
    globals: {},
  };
}

const names = listFunctions();

describe('function docs (#1413)', () => {
  it('documents every catalog function, and nothing else', () => {
    expect(Object.keys(FUNCTION_DOCS).sort()).toEqual(names);
  });

  it.each(names)('%s has a one-sentence description', (name) => {
    const { description } = FUNCTION_DOCS[name]!;
    // ONE sentence: ends in a full stop and has no sentence break before it —
    // so it is not blank and not a paragraph.
    expect(description).toMatch(/^[^.!?]+\.$/);
    expect(description.length).toBeLessThanOrEqual(120);
  });

  it('no two functions share a description', () => {
    const all = names.map((n) => FUNCTION_DOCS[n]!.description);
    expect(new Set(all).size).toBe(names.length);
  });

  it.each(names)('%s names each parameter once', (name) => {
    const { params } = FUNCTION_DOCS[name]!;
    // One name per declared arg type — a variadic's last entry is the repeated one.
    expect(params).toHaveLength(FUNCTIONS[name]!.args.length);
    expect(new Set(params).size).toBe(params.length);
    for (const p of params) expect(p).toMatch(/^[a-z][A-Za-z]*$/);
  });

  // The examples are EXECUTED, so the docs cannot claim a behaviour the
  // evaluator does not have. Literals only (and `item` inside a lambda): an
  // example that needed a graph would not run here, nor read on its own.
  it.each(names)('%s shows 1–2 examples that evaluate to what they claim', (name) => {
    const { examples } = FUNCTION_DOCS[name]!;
    expect(examples.length).toBeGreaterThanOrEqual(1);
    expect(examples.length).toBeLessThanOrEqual(2);
    for (const { expr, result } of examples) {
      expect(expr.startsWith(`${name}(`)).toBe(true);
      expect(expr).not.toMatch(
        /\b(nodes|params|vars|variables|global|globals|run|pipeline|trigger)\./,
      );
      expect(substitute(`\${${expr}}`, ctx())).toEqual(result);
    }
  });

  it('prints the signature with parameter names, agreeing with the typed one', () => {
    expect(functionDoc('substring').signature).toBe(
      'substring(text: string, start: number, length?: number) → string',
    );
    expect(functionDoc('count').signature).toBe(
      'count(array: array, condition?: boolean) → number',
    );
    expect(functionDoc('and').signature).toBe(
      'and(condition: boolean, condition: boolean, ...condition: boolean) → boolean',
    );
    // Same arity/optionality text as the unnamed form, label for label.
    for (const name of names) {
      const unnamed = fnSignature(name);
      expect(functionDoc(name).signature.replace(/\b[a-z][A-Za-z]*(\??): (\w+)/g, '$2$1')).toBe(
        unnamed,
      );
    }
  });

  it('formats an example as call → JSON result', () => {
    expect(functionDoc('toUpper').example).toBe('toUpper(\'hello\') → "HELLO"');
    expect(functionDoc('toUpper').returns).toBe('string');
  });

  it('refuses a name outside the catalog', () => {
    expect(() => functionDoc('nope')).toThrow(/not in the catalog/);
  });
});
