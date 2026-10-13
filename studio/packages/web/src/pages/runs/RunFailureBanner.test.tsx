import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RunFailureBanner } from './RunFailureBanner';
import { INACTIVE_CONTAINER_FAILED_MESSAGE, runFailure } from './runFailure';

/** #1600 C0e — an inactive container marked Failed has no row to quote, so the
 * banner says why it failed instead of a bare reason code. */
describe('RunFailureBanner — an inactive container marked Failed', () => {
  it('names the container and says it is inactive and marked as Failed', () => {
    const failure = runFailure(
      'node_failed:fe',
      { fe: { status: 'failure', round: 0, outputs: {}, reason: 'inactive', inactive: true } },
      [],
    );
    expect(failure).toEqual({ kind: 'container', containerId: 'fe', reason: 'inactive' });
    render(
      <MemoryRouter>
        <RunFailureBanner
          failure={failure}
          nameOf={(id) => (id === 'fe' ? 'Each file' : null)}
          versionHref={null}
          onShowActivity={() => {}}
        />
      </MemoryRouter>,
    );
    const banner = screen.getByRole('group', { name: 'Failure' });
    expect(banner).toHaveTextContent('Failed: Each file');
    expect(banner).toHaveTextContent(INACTIVE_CONTAINER_FAILED_MESSAGE);
  });
});
