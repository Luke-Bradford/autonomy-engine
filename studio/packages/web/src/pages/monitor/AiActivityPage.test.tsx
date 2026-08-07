import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AiActivitySnapshot, RunCost } from '@autonomy-studio/shared';
import * as monitorApi from '../../api/monitor';
import { AiActivityPage } from './AiActivityPage';

vi.mock('../../api/monitor', async (importActual) => ({
  ...(await importActual<typeof monitorApi>()),
  fetchAiActivity: vi.fn(),
  fetchAccountQuota: vi.fn(),
}));

const activityMock = vi.mocked(monitorApi.fetchAiActivity);
const quotaMock = vi.mocked(monitorApi.fetchAccountQuota);

function cost(over: Partial<RunCost> = {}): RunCost {
  return {
    currency: 'USD',
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    unpricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    complete: true,
    ...over,
  };
}

function snapshot(over: Partial<AiActivitySnapshot> = {}): AiActivitySnapshot {
  return {
    generatedAt: 1_786_000_000_000,
    since: '1h',
    windowStart: 1_785_996_400_000,
    runs: { pending: 0, queued: 0, running: 0, waiting: 0 },
    models: [],
    agentCli: { invocations: 0, completed: 0, notCompleted: 0, lastAt: null },
    totals: cost(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  quotaMock.mockResolvedValue({
    generated_at: 1_786_000_000,
    account: { claude: null },
    unavailable: { claude: 'no_credential' },
  });
});

describe('AiActivityPage', () => {
  /**
   * THE money-model guard. When exchanges happened but none could be priced, the
   * sum is a genuine `0` and `complete` is false — so a hand-rolled
   * `formatUsd(total)` plus an "at least" qualifier would render "$0.00 at
   * least", presenting a total nobody measured as if it were nearly free. The
   * shared `costFigure` ladder says "Cost unknown" instead, and this page must
   * route through it rather than write its own money prose.
   */
  it('says the cost is unknown rather than showing $0.00 for an unpriced window', async () => {
    activityMock.mockResolvedValue(
      snapshot({
        totals: cost({ responseCount: 3, costUnknownResponseCount: 3, complete: false }),
        models: [
          {
            provider: 'anthropic_api',
            model: 'some-unpriced-model',
            lastAt: 1_786_000_000_000,
            cost: cost({ responseCount: 3, costUnknownResponseCount: 3, complete: false }),
          },
        ],
      }),
    );

    render(<AiActivityPage />);

    await waitFor(() => expect(screen.getAllByText('Cost unknown').length).toBeGreaterThan(0));
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    expect(screen.queryByText(/at least/i)).toBeNull();
  });

  it('marks a partially-priced window as a floor, not a total', async () => {
    activityMock.mockResolvedValue(
      snapshot({
        totals: cost({
          responseCount: 4,
          pricedResponseCount: 3,
          costUnknownResponseCount: 1,
          totalCostEstimate: 1.25,
          complete: false,
        }),
      }),
    );

    render(<AiActivityPage />);

    await waitFor(() => expect(screen.getByText(/At least \$1\.25/)).toBeInTheDocument());
  });

  /**
   * `running` is the only status where work is executing. `queued` has not
   * started and `waiting` has released its concurrency slot, so they are
   * reported as themselves rather than summed into one "live" number that would
   * claim activity which is not happening.
   */
  it('reports executing, queued and waiting runs as separate figures', async () => {
    activityMock.mockResolvedValue(
      snapshot({ runs: { pending: 0, queued: 4, running: 1, waiting: 7 } }),
    );

    render(<AiActivityPage />);

    await waitFor(() => expect(screen.getByText('Runs executing')).toBeInTheDocument());
    const executing = screen.getByText('Runs executing').parentElement;
    const waiting = screen.getByText('Waiting').parentElement;
    expect(executing).toHaveTextContent('1');
    expect(waiting).toHaveTextContent('7');
  });

  it('labels the window with the shared prose, not a raw enum token', async () => {
    activityMock.mockResolvedValue(snapshot());

    render(<AiActivityPage />);

    const picker = await screen.findByLabelText('Activity window');
    expect(picker).toHaveTextContent('Last hour');
    expect(picker).toHaveTextContent('Last 7 days');
  });

  it('renders an unreadable quota as a reason and shows no percentage', async () => {
    activityMock.mockResolvedValue(snapshot());
    quotaMock.mockResolvedValue({
      generated_at: 1_786_000_000,
      account: { claude: null },
      unavailable: { claude: 'rate_limited' },
    });

    render(<AiActivityPage />);

    const panel = await screen.findByRole('region', { name: 'Account quota' });
    await waitFor(() => expect(panel).toHaveTextContent('Quota UNREADABLE.'));
    expect(panel.textContent ?? '').not.toContain('%');
  });
});
