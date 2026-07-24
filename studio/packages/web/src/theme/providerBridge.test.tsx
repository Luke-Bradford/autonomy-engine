import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { FLUENT_ROOT_CLASS } from './fluentTheme';

/**
 * Load-bearing invariant for the whole theme bridge: Fluent v9 emits its
 * `--color*` design tokens as a rule scoped to the FluentProvider's OWN root
 * element (via a generated `fui-FluentProvider…` theme class), NOT on
 * `:root`/`html`. The bridge stylesheet is keyed on `FLUENT_ROOT_CLASS`, so
 * that class MUST land on the same element that carries the token class — else
 * `var(--colorNeutralBackground1)` in the bridge resolves to nothing. This test
 * pins that the class we pass through reaches the token-bearing root.
 */
describe('FluentProvider theme-bridge scoping', () => {
  it('places FLUENT_ROOT_CLASS on the same element as the Fluent theme class', () => {
    const { container } = render(
      <FluentProvider theme={webDarkTheme} className={FLUENT_ROOT_CLASS}>
        <span>content</span>
      </FluentProvider>,
    );

    const root = container.querySelector(`.${FLUENT_ROOT_CLASS}`);
    expect(root).not.toBeNull();
    // The provider root carries Fluent's own root class; the token rule is
    // scoped to a class on this exact element, so our bridge class co-locates
    // with the `--color*` tokens it references.
    expect(root?.className).toMatch(/fui-FluentProvider/);
  });
});
