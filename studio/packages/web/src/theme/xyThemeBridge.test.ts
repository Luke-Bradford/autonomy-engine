import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The bridge is a pure CSS artifact — Vitest returns '' for a `.css` import
// (and even `?raw` is empty under its CSS handling), and jsdom computes no
// cascade anyway — so we assert against the SOURCE TEXT read from disk. This is
// the real regression guard against the "canvas chrome stays white in dark
// mode" bug returning: every RF chrome var the spike named must be remapped to
// a Fluent design token (`var(--color…)`), and no override may reintroduce a
// hardcoded light hex. `import.meta.dirname` = this file's dir (src/theme).
const bridgeCss = readFileSync(join(import.meta.dirname, 'xyThemeBridge.css'), 'utf8');

// Strip block comments so `#fff` etc. mentioned in prose never trip the
// no-hardcoded-color assertion.
const css = bridgeCss.replace(/\/\*[\s\S]*?\*\//g, '');

// The `--xy-*` names React Flow ACTUALLY consumes as override slots: the first
// argument of every `var(--xy-…, <fallback>)` read in RF's own stylesheet.
// Overriding any var NOT in this set is dead code — RF never reads it, so the
// chrome silently keeps RF's light default (exactly how the dead
// `--xy-background-pattern-dots-color` override slipped past the form-only
// checks). Derived from the installed RF package, not hand-listed, so it tracks
// the pinned version.
const rfRequire = createRequire(import.meta.url);
const rfCss = readFileSync(rfRequire.resolve('@xyflow/react/dist/style.css'), 'utf8');
const RF_OVERRIDE_SLOTS = new Set([...rfCss.matchAll(/var\((--xy-[a-z-]+)\s*,/g)].map((m) => m[1]));

// The `--xy-*` slots RF consumes as a FULL `border` shorthand, i.e.
// `border: var(--xy-…, …)` (not `border: 1px solid var(--xy-…-color, …)`, where
// the var is only the colour). A shorthand slot MUST carry width + style, not a
// bare colour token — a colour-only value resets `border-style` to `none` and
// the border disappears. Derived from RF's stylesheet so it tracks the version.
const RF_BORDER_SHORTHAND_SLOTS = new Set(
  [...rfCss.matchAll(/border:\s*var\((--xy-[a-z-]+)\s*,/g)].map((m) => m[1]),
);

// The white-in-dark surfaces the U0 spike explicitly called out (Controls,
// MiniMap, edge-label), plus the canvas background. If any of these regresses
// to an unmapped/hardcoded value, dark-mode chrome breaks again.
const REQUIRED_XY_VARS = [
  '--xy-background-color',
  '--xy-controls-button-background-color',
  '--xy-controls-button-background-color-hover',
  '--xy-controls-button-color',
  '--xy-controls-button-border-color',
  '--xy-minimap-background-color',
  '--xy-minimap-mask-background-color',
  '--xy-minimap-node-background-color',
  '--xy-edge-label-background-color',
  '--xy-edge-label-color',
];

describe('xyThemeBridge.css', () => {
  it('is keyed on the FluentProvider root class (tokens are scoped there, not :root)', () => {
    expect(css).toMatch(/\.app-fluent-root\s*\{/);
    // Must NOT key the token-consuming overrides on html/:root — the Fluent
    // `--color*` tokens are undefined there, so the bridge would silently fail.
    expect(css).not.toMatch(/:root\s*\{[^}]*--xy-/);
  });

  it('stays layout-neutral so it cannot regress the shipped MVP shell', () => {
    expect(css).toMatch(/display:\s*contents/);
  });

  it('remaps every white-in-dark RF chrome var to a Fluent token', () => {
    for (const name of REQUIRED_XY_VARS) {
      const decl = new RegExp(
        `${name.replace(/[-]/g, '\\-')}\\s*:\\s*var\\(--color[A-Za-z0-9]+\\)`,
      );
      expect(css, `${name} must map to a Fluent --color* token`).toMatch(decl);
    }
  });

  it('overrides only --xy-* vars React Flow actually reads (no dead overrides)', () => {
    const names = [...css.matchAll(/(--xy-[a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(REQUIRED_XY_VARS.length);
    for (const name of names) {
      expect(
        RF_OVERRIDE_SLOTS.has(name),
        `${name} is not an override slot React Flow reads — the override is dead`,
      ).toBe(true);
    }
  });

  it('gives border-shorthand slots a full value (width + style), not a bare color', () => {
    // Guards the value-SHAPE regression the slot-existence check can't: a slot
    // RF reads as `border: var(--xy-…)` needs `1px dotted <token>`, not just
    // `<token>` (which would blank border-style → the outline vanishes).
    for (const [, name, value] of css.matchAll(/(--xy-[a-z-]+)\s*:\s*([^;]+);/g)) {
      if (!RF_BORDER_SHORTHAND_SLOTS.has(name)) continue;
      expect(value, `${name} is a border shorthand and needs a style keyword`).toMatch(
        /\b(solid|dotted|dashed|double|groove|ridge|inset|outset)\b/,
      );
    }
    // Sanity: the guard actually has a slot to check (else it is vacuous).
    expect(RF_BORDER_SHORTHAND_SLOTS.size).toBeGreaterThan(0);
  });

  it('never hardcodes a color in an --xy-* override (must derive from tokens)', () => {
    // Grab every `--xy-…: <value>;` declaration and assert the value carries a
    // `var(--…)` reference and no literal hex/rgb — the whole point of the
    // bridge is that RF chrome follows the active Fluent theme.
    const decls = css.match(/--xy-[a-z-]+\s*:\s*[^;]+;/g) ?? [];
    expect(decls.length).toBeGreaterThanOrEqual(REQUIRED_XY_VARS.length);
    for (const decl of decls) {
      expect(decl, `${decl} must reference a token`).toMatch(/var\(--/);
      expect(decl, `${decl} must not hardcode a hex color`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(decl, `${decl} must not hardcode an rgb/rgba color`).not.toMatch(/rgba?\(/);
    }
  });
});
