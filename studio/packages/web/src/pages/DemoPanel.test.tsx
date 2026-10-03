import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DemoPanel } from './DemoPanel';
import * as api from '../api/demo';
import { ApiError } from '../api/client';
import { renderWithRouter } from '../testing/renderWithRouter';
import { answerConfirm } from '../testing/confirmDialog';

vi.mock('../api/demo', async () => (await import('../testing/apiModuleMocks')).demoModuleMock());

const SEEDED = {
  demoDir: '/data/demo/local',
  created: 28,
  reused: 0,
  pipelines: [],
  scheduleTriggerId: 'trg_h',
};

describe('#1481 DemoPanel', () => {
  beforeEach(() => {
    vi.mocked(api.getDemoStatus).mockReset().mockResolvedValue({ loaded: false });
    vi.mocked(api.loadDemo).mockReset().mockResolvedValue(SEEDED);
    vi.mocked(api.removeDemo).mockReset().mockResolvedValue({ removed: 23, runsRemoved: 4 });
  });

  it('loads the demo, then offers Remove and tells the caller', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderWithRouter(<DemoPanel onChanged={onChanged} />);
    await user.click(await screen.findByRole('button', { name: 'Load demo' }));
    expect(api.loadDemo).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Remove demo' })).toBeEnabled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('asks before removing, and a Cancel removes nothing', async () => {
    vi.mocked(api.getDemoStatus).mockResolvedValue({ loaded: true });
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderWithRouter(<DemoPanel onChanged={onChanged} />);

    await user.click(await screen.findByRole('button', { name: 'Remove demo' }));
    const asked = await answerConfirm(user, 'cancel');
    expect(asked).toContain('all of their runs');
    expect(api.removeDemo).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove demo' }));
    await answerConfirm(user, 'accept');
    expect(api.removeDemo).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Load demo' })).toBeEnabled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and stays as it was", async () => {
    vi.mocked(api.loadDemo).mockRejectedValue(
      new ApiError(409, 'a pipeline named "Demo — 3 Clean and aggregate" already exists'),
    );
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderWithRouter(<DemoPanel onChanged={onChanged} />);
    await user.click(await screen.findByRole('button', { name: 'Load demo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByRole('button', { name: 'Load demo' })).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('reports a failed status read as a failure, never as "not loaded"', async () => {
    vi.mocked(api.getDemoStatus).mockRejectedValue(new Error('network down'));
    renderWithRouter(<DemoPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.queryByRole('button', { name: 'Load demo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove demo' })).not.toBeInTheDocument();

    vi.mocked(api.getDemoStatus).mockResolvedValue({ loaded: false });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Load demo' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("Home's form links to the loaded demo and never offers Remove", async () => {
    vi.mocked(api.getDemoStatus).mockResolvedValue({ loaded: true });
    renderWithRouter(<DemoPanel allowRemove={false} />);
    expect(await screen.findByRole('link', { name: 'Open the demo pipelines' })).toHaveAttribute(
      'href',
      '/author/pipelines',
    );
    // The link renders from the same `loaded` answer a Remove button would.
    expect(screen.queryByRole('button', { name: 'Remove demo' })).not.toBeInTheDocument();
  });
});
