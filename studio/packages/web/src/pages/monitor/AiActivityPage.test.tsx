import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AiActivitySnapshot, RunCost, TokenSeriesBucket } from '@autonomy-studio/shared';
import * as monitorApi from '../../api/monitor';
import { AiActivityPage } from './AiActivityPage';

vi.mock('../../api/monitor', async (importActual) => ({
  ...(await importActual<typeof monitorApi>()),
  fetchAiActivity: vi.fn(),
  fetchAccountQuotaDisplay: vi.fn(),
}));

const activityMock = vi.mocked(monitorApi.fetchAiActivity);
const quotaMock = vi.mocked(monitorApi.fetchAccountQuotaDisplay);

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
    series: { bucketMs: 300_000, buckets: [] },
    ...over,
  };
}

/** One token-flow bucket, defaulting to a measured, complete, empty one. */
function bucket(over: Partial<TokenSeriesBucket> = {}): TokenSeriesBucket {
  return {
    bucketStart: 1_785_996_400_000,
    bucketEnd: 1_785_996_700_000,
    partial: false,
    cost: cost(),
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
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

  /**
   * EVERY non-terminal status must reach a tile. The server seeds all of them
   * from `LIVE_RUN_STATUSES` precisely so none can be dropped; a hand-picked
   * list in the component re-opened that hole one layer up and made `pending`
   * runs — real, non-terminal, with a row but no drive yet — invisible.
   */
  it('shows a figure for every non-terminal status, including pending', async () => {
    const runs = { pending: 3, queued: 4, running: 1, waiting: 7 };
    activityMock.mockResolvedValue(snapshot({ runs }));

    render(<AiActivityPage />);

    await waitFor(() => expect(screen.getByText('Pending')).toBeInTheDocument());
    expect(screen.getByText('Pending').parentElement).toHaveTextContent('3');

    // Nothing the response carries about live runs may go unrendered.
    for (const [status, n] of Object.entries(runs)) {
      const tiles = screen.getAllByRole('definition').map((d) => d.textContent);
      expect(tiles, `no tile rendered the ${status} count`).toContain(String(n));
    }
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
    await waitFor(() => expect(panel).toHaveTextContent('Claude quota UNREADABLE.'));
    expect(panel.textContent ?? '').not.toContain('%');
  });

  /**
   * #990 — codex beside claude, and the three states kept apart.
   */
  describe('codex quota (#990)', () => {
    const CLAUDE = {
      five_hour: { utilization: 0.08, resets_at: 1_786_003_600 },
      seven_day: { utilization: 0.07, resets_at: 1_786_600_000 },
    };

    it('does not mention codex at all when it is ABSENT from the host', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: CLAUDE },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Claude'));
      // Absent is SILENT. Naming a provider the operator has not installed and
      // calling it unreadable is a fault they cannot act on.
      expect(panel.textContent ?? '').not.toContain('Codex');
      expect(panel.textContent ?? '').not.toContain('UNREADABLE');
    });

    it('renders a codex reading with its scrape age, beside claude', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: {
          claude: CLAUDE,
          codex: {
            seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
            read_at: 1_786_000_000 - 750,
          },
        },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Codex'));
      expect(panel).toHaveTextContent('64%');
      // Claude's own figure is still there — one provider does not displace the other.
      expect(panel).toHaveTextContent('7%');
      // THE HONESTY BIT: a scraped number states how old it is. Without this it
      // sits in the same table as a live figure and reads as equally current.
      expect(panel).toHaveTextContent('12m 30s ago');
    });

    it('renders an UNREADABLE codex as a named reason and never a number', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: CLAUDE, codex: null },
        unavailable: { codex: 'no_reading' },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Codex quota UNREADABLE.'));
      // It says what to DO about it, rather than emitting the enum token.
      expect(panel).toHaveTextContent('has not run recently enough');
      expect(panel.textContent ?? '').not.toContain('no_reading');
      // Claude's reading survives its neighbour's failure.
      expect(panel).toHaveTextContent('7%');
    });
  });

  /**
   * #987 — the panel said UNREADABLE most of the time, because the provider 429s
   * most of the time, while a real number had been read minutes earlier.
   */
  describe('last-known quota reading (#987)', () => {
    const LAST_KNOWN = {
      five_hour: { utilization: 0.31, resets_at: 1_786_003_600 },
      seven_day: { utilization: 0.58, resets_at: 1_786_600_000 },
    };

    it('shows the last known number, with its age, beneath the UNREADABLE statement', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: LAST_KNOWN, read_at: 1_786_000_000 - 750 },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      // The UNREADABLE statement STAYS. The number is an addition to it, never
      // a replacement for it — an old figure presented as live is the fail-open
      // failure this surface exists to prevent.
      await waitFor(() => expect(panel).toHaveTextContent('Claude quota UNREADABLE.'));
      expect(panel).toHaveTextContent('Last known reading');
      expect(panel).toHaveTextContent('58%');
      // 750s → the shared elapsed formatter's two most significant units.
      expect(panel).toHaveTextContent('12m 30s ago');
      expect(panel).toHaveTextContent('not a current figure');
    });

    it('warns in words once the reading is older than the reader refreshes', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: LAST_KNOWN, read_at: 1_786_000_000 - 750 },
      });

      render(<AiActivityPage />);
      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('has been failing for a while'));
    });

    it('says nothing of the sort for a reading taken seconds ago', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: LAST_KNOWN, read_at: 1_786_000_000 - 30 },
      });

      render(<AiActivityPage />);
      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Last known reading'));
      expect(panel).toHaveTextContent('30s ago');
      expect(panel.textContent ?? '').not.toContain('has been failing for a while');
    });

    it('shows no number at all when nothing has ever been read', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: null },
        unavailable: { claude: 'no_credential' },
      });

      render(<AiActivityPage />);
      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Claude quota UNREADABLE.'));
      expect(panel.textContent ?? '').not.toContain('Last known reading');
      expect(panel.textContent ?? '').not.toContain('%');
    });

    it('stamps when the browser last CHECKED, which is not how old the number is', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: LAST_KNOWN, read_at: 1_786_000_000 - 750 },
      });

      render(<AiActivityPage />);
      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('Last checked'));
      // Two freshness facts were on screen and the louder one was about the
      // REQUEST, not the number — so it now names what it stamps.
      expect(panel.textContent ?? '').not.toContain('Quota as of');
    });
  });

  describe('the token-flow chart (#967)', () => {
    /** Renders the page with a series and returns the chart's bars. */
    async function renderBars(
      buckets: TokenSeriesBucket[],
      over: Partial<AiActivitySnapshot> = {},
    ) {
      activityMock.mockResolvedValue(
        snapshot({
          models: [
            {
              provider: 'anthropic_api',
              model: 'claude-opus-4-8',
              lastAt: 1_785_996_500_000,
              cost: cost({ responseCount: 1, inputTokens: 10 }),
            },
          ],
          totals: cost({ responseCount: 1, inputTokens: 10 }),
          series: { bucketMs: 300_000, buckets },
          ...over,
        }),
      );
      const { container } = render(<AiActivityPage />);
      await waitFor(() => expect(container.querySelector('.token-flow')).not.toBeNull());
      return container;
    }

    it('draws one bar per bucket, scaled to the tallest stack', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({ responseCount: 1, inputTokens: 50, outputTokens: 50 }),
          inputReportedResponseCount: 1,
          outputReportedResponseCount: 1,
        }),
        bucket({
          bucketStart: 2,
          cost: cost({ responseCount: 1, inputTokens: 25, outputTokens: 25 }),
          inputReportedResponseCount: 1,
          outputReportedResponseCount: 1,
        }),
      ]);

      expect(container.querySelectorAll('.token-flow-bucket')).toHaveLength(2);
      const segments = container.querySelectorAll<HTMLElement>('.token-flow-seg--in');
      // The tallest stack is 100 tokens, so its input half is 50% of the plot
      // and the half-sized bucket's is 25%.
      expect(segments[0]?.style.height).toBe('50%');
      expect(segments[1]?.style.height).toBe('25%');
    });

    /**
     * THE CASE THE WHOLE HONESTY MECHANISM EXISTS FOR. An agent-CLI exchange is
     * real billed AI work carrying no token counts, and the SQL's
     * `coalesce(…, 0)` hands it over as a zero. Drawn as a zero-height bar it
     * would state that nothing happened.
     */
    it('draws an UNMEASURED bucket as a marker, never as a zero-height bar', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({ responseCount: 3, inputTokens: 0, outputTokens: 0 }),
          inputReportedResponseCount: 0,
          outputReportedResponseCount: 0,
        }),
      ]);

      expect(container.querySelector('.token-flow-unmeasured')).not.toBeNull();
      expect(container.querySelectorAll('.token-flow-seg')).toHaveLength(0);
      expect(screen.getByTitle(/3 exchanges, tokens not reported/)).toBeTruthy();
    });

    it('distinguishes a genuinely empty bucket from an unmeasured one', async () => {
      const container = await renderBars([
        bucket({ bucketStart: 1, cost: cost({ responseCount: 0 }) }),
      ]);

      // No exchanges at all IS a measured zero, so it draws as a bar of no
      // height rather than as the "not counted" marker.
      expect(container.querySelector('.token-flow-unmeasured')).toBeNull();
      expect(screen.getByTitle(/no billed exchanges/)).toBeTruthy();
    });

    it('marks a partial bucket and says so in text, not by colour alone', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          partial: true,
          cost: cost({ responseCount: 1, inputTokens: 10 }),
          inputReportedResponseCount: 1,
        }),
      ]);

      expect(container.querySelector('.token-flow-stack[data-partial="true"]')).not.toBeNull();
      expect(screen.getByTitle(/period incomplete/)).toBeTruthy();
    });

    /** A tooltip must never be the only way to reach a value. */
    it('repeats every bucket sentence in visually-hidden text', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({ responseCount: 2, inputTokens: 10, outputTokens: 4 }),
          inputReportedResponseCount: 2,
          outputReportedResponseCount: 2,
        }),
      ]);

      const hidden = container.querySelector('.token-flow-stack .visually-hidden');
      expect(hidden?.textContent).toContain('2 exchanges');
      expect(hidden?.textContent).toContain('10 in / 4 out');
    });

    /*
     * Pins the guard the chart actually sits behind — `models`/`agentCli`, NOT
     * its own `buckets`. An earlier version of this passed `buckets: []`, which
     * is the fixture default and so varied nothing: it read as though an empty
     * series were what hides the chart, when a row of zero-height bars on a
     * baseline is exactly what it exists to avoid drawing. Asserting the TABLE
     * is gone too is the point — the two are one guard, so the chart cannot come
     * back on its own and state "no tokens" where the notice states "nothing
     * happened".
     */
    it('is hidden by the same empty-window guard as the model table', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          models: [],
          agentCli: { invocations: 0, completed: 0, notCompleted: 0, lastAt: null },
        }),
      );
      const { container } = render(<AiActivityPage />);
      await waitFor(() =>
        expect(screen.getByText(/No AI or agent activity in this window/)).toBeTruthy(),
      );
      expect(container.querySelector('.token-flow')).toBeNull();
      expect(container.querySelector('.ai-model-table')).toBeNull();
    });
  });
});
