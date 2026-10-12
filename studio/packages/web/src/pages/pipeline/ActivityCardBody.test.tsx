import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ActivityCardBody } from './ActivityCardBody';

describe("ActivityCardBody — the description's hover (#1600 OR41 C0b)", () => {
  const titleOf = (description?: string | null) =>
    render(
      <ActivityCardBody
        type="wait"
        title="Wait 1"
        summary={null}
        badges={[]}
        description={description}
      />,
    ).container.querySelector('.flow-node-title')!;

  it('follows the name in the tooltip and is its accessible description', () => {
    const title = titleOf('Waits for the export');
    expect(title.getAttribute('title')).toBe('Wait 1\n\nWaits for the export');
    expect(title.getAttribute('aria-description')).toBe('Waits for the export');
  });

  it('none, null or whitespace alone leave the bare name and no description', () => {
    for (const description of [undefined, null, '', '  \n ']) {
      const title = titleOf(description);
      expect(title.getAttribute('title')).toBe('Wait 1');
      expect(title.hasAttribute('aria-description')).toBe(false);
    }
  });
});
