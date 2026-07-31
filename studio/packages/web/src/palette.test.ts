import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContainerRunStatusSchema,
  EdgeOnSchema,
  NodeRunStatusSchema,
} from '@autonomy-studio/shared';
import { EDGE_VARIANTS } from './pages/pipeline/edgeCondition';
import { ALL_TONES, containerStatusTone, nodeStatusTone } from './pages/runs/runProjection';
import { customProps, findColorLiterals, readCssSource, ruleBody } from './testing/cssSource';

/**
 * The MVP shell (`index.css`) predates Fluent and paints from its OWN custom
 * properties, hardcoded dark. It cannot read Fluent's `--colorXxx` tokens:
 * Fluent scopes those to the FluentProvider ROOT ELEMENT, and `:root`/`body`
 * are ANCESTORS of that element — custom properties inherit downwards only, so
 * a `var(--colorNeutralBackground1)` on `body` resolves to nothing. So the
 * palette carries its own `[data-theme='light']` override block, driven by the
 * attribute `syncColorScheme` sets.
 *
 * The failure this guards is silent and easy: add a palette var (or a raw
 * colour) and forget the light override — light mode then keeps a dark patch
 * that only an eyeball catches. Asserted against the SOURCE TEXT because Vitest
 * returns '' for a `.css` import and jsdom computes no cascade.
 */
const css = readCssSource(join(import.meta.dirname, 'index.css'));

const BASE_SELECTOR = ':root';
const LIGHT_SELECTOR = ":root[data-theme='light']";

const base = customProps(ruleBody(css, BASE_SELECTOR));
const light = customProps(ruleBody(css, LIGHT_SELECTOR));

describe('MVP palette light/dark parity', () => {
  it('declares a dark base palette', () => {
    expect(base.size).toBeGreaterThan(0);
  });

  it('overrides EVERY base palette variable in light mode, and adds none of its own', () => {
    expect([...light.keys()].sort()).toEqual([...base.keys()].sort());
  });

  it('gives every light variable a value distinct from the dark one', () => {
    for (const [name, darkValue] of base) {
      expect(light.get(name), `${name} is identical in both themes`).not.toBe(darkValue);
    }
  });

  /**
   * `:root[data-theme='light']` has specificity (0,2,0) — a pseudo-class plus
   * an attribute selector, both class-column, with no element selector — and so
   * beats the base `:root` (0,1,0) wherever it sits in the file. Dropping the
   * `:root` prefix (a bare `[data-theme='light']`, specificity (0,1,0)) would
   * tie with the base rule and then depend on source order — a silent way to
   * lose light mode.
   */
  it('keys light mode on a selector that outranks the base rule', () => {
    expect(css).toContain(`${LIGHT_SELECTOR} {`);
  });

  /**
   * Status colours were once inline literals (`#58d68d`) outside the palette,
   * so they stayed dark-mode green in light mode. Every colour literal must now
   * live in one of the two palette blocks — checked with the SAME matcher the
   * `--xy-*` bridge guard uses, so the two cannot drift (a weaker copy of this
   * check let a `crimson` through in review).
   */
  it('keeps colour literals inside the palette blocks', () => {
    const outside = [BASE_SELECTOR, LIGHT_SELECTOR].reduce(
      (rest, selector) => rest.replace(ruleBody(css, selector), ''),
      css,
    );
    expect(findColorLiterals(outside)).toEqual([]);
    // Sanity: the matcher is not vacuous — the palette blocks are full of them.
    expect(findColorLiterals(ruleBody(css, BASE_SELECTOR)).length).toBe(base.size);
  });

  /**
   * The `● live` stream indicator animates indefinitely. The shell's a11y
   * criteria include reduced motion, and an infinite pulse is exactly the kind
   * of animation `prefers-reduced-motion` exists to stop.
   */
  it('honours prefers-reduced-motion for the infinite live-pulse animation', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

/**
 * U6a — the condition → hue mapping for canvas edges.
 *
 * Asserted against the CSS SOURCE because nothing else can see it: the unit
 * tests assert class NAMES, and the e2e asserts the five hues are distinct,
 * opaque and readable. All of that stays green if `--success` and `--error` are
 * swapped — the canvas would paint failures green and nobody would fail. This
 * is also the check behind the claim that the canvas and the Monitor overlay
 * (U11) read one palette: both sides name the same vars, here and in the
 * `.run-status-*` / `.node-status-*` rules below them.
 */
describe('U6a edge variant hues', () => {
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ['success', '--success'],
    ['failure', '--error'],
    ['completion', '--accent'],
    ['skipped', '--muted'],
    ['branch', '--branch'],
  ];

  it.each(EXPECTED)('paints edge-variant-%s with var(%s)', (condition, cssVar) => {
    const body = ruleBody(css, `.react-flow__edge.edge-variant-${condition}`);
    expect(customProps(body).get('--edge-color')).toBe(`var(${cssVar})`);
  });

  /**
   * `OPERATIONAL_CONDITIONS` is `EdgeOnSchema.options`, so a FIFTH engine
   * outcome becomes authorable the moment the engine lands it. That is a
   * deliberate reversal of the `AUTHORABLE_EDGE_ON` pin, and this is the
   * safety net it needs: without a matching rule the new condition would paint
   * an unstyled edge (falling through to the Fluent neutral), which is a
   * rendered change nobody browser-verified. Adding an outcome now fails here
   * instead.
   */
  /**
   * U11 — the run overlay's tones, in BOTH directions.
   *
   * `runFlow.ts` builds a class by string concat (`run-node-${tone}`), so a tone
   * with no rule paints nothing and a rule with no tone is dead weight nobody
   * notices. The node and container vocabularies differ deliberately (no
   * container status is `holding`), which is exactly the kind of asymmetry that
   * rots — so each side is enumerated from the CODE, not from a copy of it.
   */
  it('has a run-overlay rule for every tone the projection can emit, and no others', () => {
    const nodeTones = new Set(NodeRunStatusSchema.options.map(nodeStatusTone));
    for (const tone of nodeTones) {
      expect(ruleBody(css, `.run-node-${tone}`), `no .run-node-${tone} rule`).not.toBe('');
    }
    const containerTones = new Set(ContainerRunStatusSchema.options.map(containerStatusTone));
    for (const tone of containerTones) {
      expect(ruleBody(css, `.run-container-${tone}`), `no .run-container-${tone} rule`).not.toBe(
        '',
      );
    }

    // …and nothing beyond them. A `.run-container-holding` rule survived the
    // first cut of U11 despite no container status mapping to `holding`.
    // `includes`, not `ruleBody`: the latter THROWS on an absent rule, which is
    // the outcome this half is asserting.
    for (const tone of ALL_TONES) {
      if (containerTones.has(tone)) continue;
      expect(
        css.includes(`.run-container-${tone} {`),
        `.run-container-${tone} exists but no container status maps to it`,
      ).toBe(false);
    }
  });

  it('has a variant rule for every operational outcome the picker offers', () => {
    for (const on of EdgeOnSchema.options) {
      const body = ruleBody(css, `.react-flow__edge.edge-variant-${on}`);
      expect(body, `no .edge-variant-${on} rule — the picker offers it`).not.toBe('');
    }
  });

  /**
   * U6b — the ARROWHEAD hue must equal the STROKE hue it caps.
   *
   * The two cannot be one declaration: SVG renders a `<marker>` outside the edge
   * `<g>` that references it, so `--edge-color` set on the edge never reaches it
   * (the reason U6a shipped with no arrowheads at all). Two lists that must agree
   * are therefore asserted equal here rather than left to inspection — a green
   * edge ending in a red arrowhead is a rendered defect no unit test can see, and
   * `EDGE_VARIANTS` is what makes "every variant" checkable rather than assumed.
   */
  it('gives every edge variant an arrowhead marker in the SAME hue as its stroke', () => {
    expect([...EDGE_VARIANTS].sort()).toEqual(EXPECTED.map(([c]) => c).sort());
    for (const [condition, cssVar] of EXPECTED) {
      const stroke = customProps(ruleBody(css, `.react-flow__edge.edge-variant-${condition}`));
      const arrow = customProps(ruleBody(css, `#edge-arrow-${condition}`));
      expect(arrow.get('--edge-color'), `#edge-arrow-${condition} hue`).toBe(`var(${cssVar})`);
      expect(arrow.get('--edge-color')).toBe(stroke.get('--edge-color'));
    }
  });
});

/**
 * U6c — the container wash is the NEUTRAL grey, and provably not an edge hue.
 *
 * It shipped as `rgba(110, 168, 254, …)`, which is `--accent` — the `completion`
 * edge hue above, and the selection colour — under a comment claiming "a neutral
 * grey wash". Every check passed: the e2e asserts the fill resolves, is not
 * transparent, and differs between themes, all of which a wrong hue satisfies.
 * Nothing could see the semantics, so this asserts them.
 *
 * A hue, not a whole value: `--container-fill` carries the palette's grey at low
 * alpha, so it cannot be `var(--muted)` itself — this file's own non-vacuity check
 * requires exactly one colour LITERAL per palette variable.
 */
describe('U6c container fill', () => {
  /** `#aabbcc` or `rgba(r, g, b, a)` → `r,g,b`. */
  function hue(value: string): string {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
    if (hex)
      return hex
        .slice(1, 4)
        .map((h) => parseInt(h, 16))
        .join(',');
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value.trim());
    expect(rgb, `cannot read a hue out of '${value}'`).not.toBeNull();
    return rgb!.slice(1, 4).join(',');
  }

  it.each([
    ['dark', base],
    ['light', light],
  ])('paints %s mode with --muted, the no-semantics grey', (_theme, palette) => {
    const fill = palette.get('--container-fill');
    expect(fill).toBeDefined();
    expect(hue(fill!)).toBe(hue(palette.get('--muted')!));
  });

  it.each([
    ['dark', base],
    ['light', light],
  ])('does NOT reuse an OUTCOME hue in %s mode', (_theme, palette) => {
    // A grouping is not an outcome: --accent is `completion` (and selection),
    // --success/--error are the success/failure edges, --branch is routing.
    const fill = hue(palette.get('--container-fill')!);
    for (const taken of ['--accent', '--success', '--error', '--branch']) {
      expect(fill, `the container wash reuses ${taken}`).not.toBe(hue(palette.get(taken)!));
    }
  });

  /** Translucent, or the box stops being a region behind its children. */
  it.each([
    ['dark', base],
    ['light', light],
  ])('keeps the %s wash translucent', (_theme, palette) => {
    const alpha = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\)/.exec(
      palette.get('--container-fill')!,
    );
    expect(alpha, 'the container fill is not an rgba() with an alpha').not.toBeNull();
    expect(Number(alpha![1])).toBeGreaterThan(0);
    expect(Number(alpha![1])).toBeLessThan(0.2);
  });
});
