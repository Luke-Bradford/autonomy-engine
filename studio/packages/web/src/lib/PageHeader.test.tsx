import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader, ToolbarDivider } from './PageHeader';

describe('PageHeader', () => {
  it('titles the page with an h2 that a section can be labelled by', () => {
    render(
      <section aria-labelledby="things-heading">
        <PageHeader title="Things" headingId="things-heading" headingTitle="All the things" />
      </section>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Things' });
    expect(heading.id).toBe('things-heading');
    expect(heading.title).toBe('All the things');
    expect(screen.getByRole('region', { name: 'Things' })).toBeTruthy();
  });

  it('draws no toolbar for a page with no actions, or none showing', () => {
    const { container } = render(<PageHeader title="Home" />);
    expect(container.querySelector('.toolbar')).toBeNull();
    const off = false as boolean;
    const { container: conditional } = render(
      <PageHeader title="Runs">
        {off && <button type="button">Refresh</button>}
        {null}
      </PageHeader>,
    );
    expect(conditional.querySelector('.toolbar')).toBeNull();
  });

  it('puts the controls in the toolbar and the adornment outside the heading', () => {
    const { container } = render(
      <PageHeader title="Runs" adornment={<span>badge</span>}>
        <button type="button">Refresh</button>
        <ToolbarDivider />
        <button type="button">Export</button>
      </PageHeader>,
    );
    const toolbar = container.querySelector('.page-header > .toolbar')!;
    expect([...toolbar.children].map((c) => c.textContent)).toEqual(['Refresh', '', 'Export']);
    expect(toolbar.querySelector('.toolbar__divider')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Runs');
  });
});
