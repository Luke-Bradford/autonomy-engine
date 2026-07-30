import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionBadge } from './VersionBadge';
import * as api from '../api/version';

afterEach(() => vi.restoreAllMocks());

describe('VersionBadge', () => {
  it('shows the running version once loaded', async () => {
    vi.spyOn(api, 'getVersion').mockResolvedValue({
      version: '2026.07.30',
      commit: 'e93ebf8',
      builtAt: '2026-07-30T09:12:44.000Z',
      arch: 'arm64',
    });
    render(<VersionBadge />);
    await waitFor(() => expect(screen.getByText('2026.07.30')).toBeInTheDocument());
  });

  // A failed version fetch must not put an error in the chrome of every page.
  // It is decoration; the app is fully usable without it.
  it('renders nothing when the version cannot be read', async () => {
    vi.spyOn(api, 'getVersion').mockRejectedValue(new Error('offline'));
    const { container } = render(<VersionBadge />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
