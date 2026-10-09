import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { customProps, literalDeclarations, readCssSource, ruleBody } from '../testing/cssSource';

/**
 * #1594 OR40 S1 — the design tokens are the one source of truth for type,
 * spacing, radius and control height.
 *
 * Asserted against the SOURCE TEXT, as `palette.test.ts` is: Vitest returns ''
 * for a `.css` import and jsdom computes no cascade. What the browser does with
 * these values is `e2e/design-tokens.spec.ts`.
 */
const dir = import.meta.dirname;
const tokens = readCssSource(join(dir, 'tokens.css'));
const sheets = {
  'theme/tokens.css': tokens,
  'index.css': readCssSource(join(dir, '..', 'index.css')),
  'theme/xyThemeBridge.css': readCssSource(join(dir, 'xyThemeBridge.css')),
};

const compact = customProps(ruleBody(tokens, ':root'));
const comfortable = customProps(ruleBody(tokens, ":root[data-density='comfortable']"));

/** A token's value at a density: comfortable overrides, else the shared block. */
const at = (density: 'compact' | 'comfortable', name: string) =>
  density === 'comfortable' ? (comfortable.get(name) ?? compact.get(name)) : compact.get(name);

describe('design tokens', () => {
  /** The UI standard's type ramp and heights, per density. */
  it.each([
    ['--type-caption-size', '12px', '12px'],
    ['--type-caption-line', '16px', '16px'],
    ['--type-body-size', '13px', '14px'],
    ['--type-body-line', '20px', '20px'],
    ['--type-section-size', '14px', '16px'],
    ['--type-section-line', '20px', '22px'],
    ['--type-title-size', '20px', '20px'],
    ['--type-title-line', '28px', '28px'],
    ['--control-h', '28px', '32px'],
    ['--row-h', '32px', '36px'],
  ])('%s is %s compact, %s comfortable', (name, compactValue, comfortableValue) => {
    expect(at('compact', name)).toBe(compactValue);
    expect(at('comfortable', name)).toBe(comfortableValue);
  });

  it('declares the spacing scale exactly, and the same in both densities', () => {
    const scale = [...compact].filter(([name]) => name.startsWith('--space-'));
    expect(scale).toEqual([
      ['--space-1', '4px'],
      ['--space-2', '8px'],
      ['--space-3', '12px'],
      ['--space-4', '16px'],
      ['--space-5', '24px'],
      ['--space-6', '32px'],
    ]);
    expect([...comfortable.keys()].filter((name) => name.startsWith('--space-'))).toEqual([]);
  });

  it('has two weights, 400 and 600', () => {
    const weights = [...compact].filter(([name]) => name.startsWith('--weight-'));
    expect(weights).toEqual([
      ['--weight-regular', '400'],
      ['--weight-strong', '600'],
    ]);
  });

  it('declares radius and the font stacks', () => {
    expect(compact.get('--radius-control')).toBe('4px');
    expect(compact.get('--radius-surface')).toBe('6px');
    expect(compact.get('--font-sans')).toMatch(/^'Segoe UI'/);
    expect(compact.get('--font-mono')).toMatch(/^ui-monospace, 'Cascadia Code'/);
  });

  /** S2 — one focus ring; the inset form is derived, so the width has one source. */
  it('declares the focus ring', () => {
    expect(compact.get('--focus-ring-width')).toBe('2px');
    expect(compact.get('--focus-ring-offset')).toBe('1px');
    expect(compact.get('--focus-ring-inset')).toBe('calc(-1 * var(--focus-ring-width))');
    expect(compact.get('--focus-ring-outset')).toBe(
      'calc(2 * var(--focus-ring-offset) + var(--focus-ring-width))',
    );
    expect([...comfortable.keys()].filter((name) => name.startsWith('--focus-'))).toEqual([]);
  });

  /**
   * A `font` shorthand with no family is invalid at computed-value time, so a
   * `font: var(--type-x)` would silently fall back to the inherited font.
   */
  it.each([
    ['--type-caption', '--weight-regular', 'caption'],
    ['--type-body', '--weight-regular', 'body'],
    ['--type-body-strong', '--weight-strong', 'body'],
    ['--type-section', '--weight-strong', 'section'],
    ['--type-title', '--weight-strong', 'title'],
  ])('%s is a full font shorthand', (name, weight, step) => {
    expect(compact.get(name)?.replace(/\s+/g, ' ')).toBe(
      `var(${weight}) var(--type-${step}-size) / var(--type-${step}-line) var(--font-sans)`,
    );
  });

  it('declares every token a stylesheet reads', () => {
    const declared = new Set(compact.keys());
    for (const [file, css] of Object.entries(sheets)) {
      const read = [
        ...css.matchAll(
          /var\(\s*(--(?:space|type|weight|radius|font|root|focus)[\w-]*|--control-h|--row-h)/g,
        ),
      ].map(([, name = '']) => name);
      expect(
        read.filter((name) => !declared.has(name)),
        file,
      ).toEqual([]);
    }
  });

  it('leaves no copy of the old dock-only density tokens', () => {
    for (const [file, css] of Object.entries(sheets)) {
      expect(css, file).not.toContain('--density-');
    }
  });
});

/**
 * The literal RATCHET. Every font size, weight, line height, padding, margin,
 * gap and radius outside a token is counted. The count may only fall: S6 moves
 * each page onto the tokens and brings it to 0, and then it becomes a hard rule.
 *
 * Inline TSX `style={{}}` and Fluent `makeStyles` values are not stylesheets and
 * are not counted here.
 */
const BASELINE = 538;

describe('design-token literal ratchet', () => {
  const literals = Object.entries(sheets).flatMap(([file, css]) =>
    literalDeclarations(css).map((declaration) => `${file}: ${declaration}`),
  );

  it('adds no literal outside the tokens', () => {
    expect(
      literals.length,
      `${literals.length} literals against a baseline of ${BASELINE}. Use a token from theme/tokens.css instead.`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it('records each literal removed, so the baseline only falls', () => {
    expect(
      literals.length,
      `Literals fell to ${literals.length}. Lower BASELINE in theme/tokens.test.ts to match.`,
    ).toBeGreaterThanOrEqual(BASELINE);
  });

  it('keeps the token sheet itself literal-free', () => {
    expect(literalDeclarations(tokens)).toEqual([]);
  });
});
