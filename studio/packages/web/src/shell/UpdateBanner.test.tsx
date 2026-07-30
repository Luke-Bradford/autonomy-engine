import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';
import * as api from '../api/version';

const build = (version: string) => ({
  version,
  commit: 'x',
  builtAt: '2026-07-30T00:00:00.000Z',
  arch: 'arm64',
});
afterEach(() => vi.restoreAllMocks());

describe('UpdateBanner', () => {
  it('announces an available update and names the version', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.29'),
      latest: build('2026.07.30'),
      updateAvailable: true,
      notes: null,
    });
    render(<UpdateBanner />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2026.07.30'));
  });

  it('renders nothing when up to date', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.30'),
      latest: build('2026.07.30'),
      updateAvailable: false,
      notes: null,
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  // latest=null means the check could not be made. It must look like silence,
  // NOT like "up to date" — the server already distinguishes them and the UI
  // must not collapse the distinction it was given.
  it('renders nothing when the check could not be made', async () => {
    vi.spyOn(api, 'getUpdateStatus').mockResolvedValue({
      current: build('2026.07.29'),
      latest: null,
      updateAvailable: false,
      notes: null,
    });
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
