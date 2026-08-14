import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type {
  AiActivitySnapshot,
  ExternalAgentActivity,
  ExternalReporterActivity,
  RunCost,
  TokenSeriesBucket,
} from '@autonomy-studio/shared';
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
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
    complete: true,
    ...over,
  };
}

/** #988 — reported external activity, defaulting to "nobody reported anything". */
function externalActivity(over: Partial<ExternalAgentActivity> = {}): ExternalAgentActivity {
  return {
    invocations: 0,
    completed: 0,
    notCompleted: 0,
    unknown: 0,
    inFlight: 0,
    lastAt: null,
    tokens: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      measuredInvocations: 0,
    },
    truncated: false,
    reporters: [],
    ...over,
  };
}

/** One reported (source, agent, model) group. */
function reporter(over: Partial<ExternalReporterActivity> = {}): ExternalReporterActivity {
  return {
    source: 'studio-build-loop',
    agent: 'claude',
    model: 'claude-opus-5',
    invocations: 1,
    completed: 1,
    notCompleted: 0,
    unknown: 0,
    inFlight: 0,
    lastAt: 1_785_999_000_000,
    tokens: {
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 56,
      cacheCreationTokens: 78,
      measuredInvocations: 1,
    },
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
    external: externalActivity(),
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
   * #1023 — what the panel shows once a partial reading is a reading.
   */
  describe('a reading the provider only partly reported (#1023)', () => {
    it('shows the 7-day row alone, and does not invent a 5-hour figure', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: { seven_day: { utilization: 0.07, resets_at: 1_786_600_000 } } },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('7-day'));
      // The row is absent, not blank. A row with an empty or zeroed cell is a
      // claim about a window nobody reported — and "0% used" is the single most
      // dangerous thing this surface can say.
      expect(panel.textContent ?? '').not.toContain('5-hour');
      // The reading is still a READING: no UNREADABLE banner over a good figure.
      expect(panel.textContent ?? '').not.toContain('UNREADABLE');
      expect(panel).toHaveTextContent('7%');
    });

    it('renders an unreported reset instant as an em-dash, never as 1970', async () => {
      activityMock.mockResolvedValue(snapshot());
      quotaMock.mockResolvedValue({
        generated_at: 1_786_000_000,
        account: { claude: { seven_day: { utilization: 0.07, resets_at: null } } },
      });

      render(<AiActivityPage />);

      const panel = await screen.findByRole('region', { name: 'Account quota' });
      await waitFor(() => expect(panel).toHaveTextContent('7-day'));
      const text = panel.textContent ?? '';
      expect(text).toContain('—');
      // The failure this guards is the plausible one, not the visible one:
      // epoch 0 renders as a real-looking date with no relative suffix.
      expect(text).not.toContain('1970');
      // And no "(in …)" countdown computed against it.
      expect(text).not.toContain('(in ');
      // The measurement beside it is untouched — that is the whole point.
      expect(panel).toHaveTextContent('7%');
    });
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
          cost: cost({
            responseCount: 1,
            inputTokens: 50,
            outputTokens: 50,
            inputReportedResponseCount: 1,
            outputReportedResponseCount: 1,
          }),
        }),
        bucket({
          bucketStart: 2,
          cost: cost({
            responseCount: 1,
            inputTokens: 25,
            outputTokens: 25,
            inputReportedResponseCount: 1,
            outputReportedResponseCount: 1,
          }),
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
          cost: cost({
            responseCount: 3,
            inputTokens: 0,
            outputTokens: 0,
            inputReportedResponseCount: 0,
            outputReportedResponseCount: 0,
          }),
        }),
      ]);

      expect(container.querySelector('.token-flow-unmeasured')).not.toBeNull();
      expect(container.querySelectorAll('.token-flow-seg')).toHaveLength(0);
      expect(screen.getByTitle(/3 exchanges, tokens not reported/)).toBeTruthy();
    });

    /**
     * THE SAME FAILURE AT HALF SCALE. A gateway can report one side of an
     * exchange and omit the other, so the bucket is not wholly unmeasured and
     * the marker above does not apply — but `coalesce(sum(…), 0)` still hands
     * the omitted side over as a confident `0`, and a zero-height segment draws
     * that as an observed zero. The sentence already says "not reported"; if the
     * bar does not, the picture contradicts the text and the picture is what
     * gets read.
     */
    it('draws the side NOBODY reported as unreported, not as a zero-height segment', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({
            responseCount: 2,
            inputTokens: 900,
            outputTokens: 0,
            inputReportedResponseCount: 2,
            outputReportedResponseCount: 0,
          }),
        }),
      ]);

      // One side WAS counted, so this is a stack, not the whole-bucket marker.
      expect(container.querySelector('.token-flow-unmeasured')).toBeNull();
      const inSeg = container.querySelector<HTMLElement>('.token-flow-seg--in');
      const outSeg = container.querySelector<HTMLElement>('.token-flow-seg--out');
      expect(inSeg?.style.height).toBe('100%');
      expect(inSeg?.className).not.toContain('token-flow-seg--unreported');
      // The unreported side carries NO inline height: its size is a fixed CSS
      // sliver, because there is no magnitude to encode.
      expect(outSeg?.className).toContain('token-flow-seg--unreported');
      expect(outSeg?.style.height).toBe('');
    });

    /** The converse, so the marker cannot creep onto a real measurement. */
    it('leaves a MEASURED zero as a zero-height segment', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({
            responseCount: 2,
            inputTokens: 900,
            outputTokens: 0,
            inputReportedResponseCount: 2,
            outputReportedResponseCount: 2,
          }),
        }),
      ]);

      const outSeg = container.querySelector<HTMLElement>('.token-flow-seg--out');
      expect(outSeg?.className).not.toContain('token-flow-seg--unreported');
      expect(outSeg?.style.height).toBe('0%');
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
          cost: cost({ responseCount: 1, inputTokens: 10, inputReportedResponseCount: 1 }),
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
          cost: cost({
            responseCount: 2,
            inputTokens: 10,
            outputTokens: 4,
            inputReportedResponseCount: 2,
            outputReportedResponseCount: 2,
          }),
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
    /**
     * #1035 — the legend's key to the hatch.
     *
     * The mark whose meaning is least self-evident was the only one with nothing
     * explaining it: a reader saw a hatched stub and had no way to learn it meant
     * "nobody reported this side" rather than "almost zero" — the very misreading
     * the hatch was introduced to prevent.
     */
    it('explains the hatch in the legend WHEN the series draws one', async () => {
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({
            responseCount: 2,
            inputTokens: 900,
            inputReportedResponseCount: 2,
            outputReportedResponseCount: 0,
          }),
        }),
      ]);

      const legend = container.querySelector('.token-flow-legend');
      expect(legend?.textContent).toContain('Not reported');
      expect(legend?.querySelector('.token-flow-swatch--unreported')).not.toBeNull();
      // The legend's swatch must not join the chart's own marks: `.token-flow-seg`
      // is what the bar assertions count.
      expect(container.querySelectorAll('.token-flow-seg--unreported')).toHaveLength(1);
    });

    it('omits it when every side of every bucket WAS reported', async () => {
      /* A legend explaining a mark that is not on screen is noise, and the entry
         is derived from the same predicate the marks are drawn from, so the two
         cannot disagree. */
      const container = await renderBars([
        bucket({
          bucketStart: 1,
          cost: cost({
            responseCount: 1,
            inputTokens: 10,
            outputTokens: 4,
            inputReportedResponseCount: 1,
            outputReportedResponseCount: 1,
          }),
        }),
      ]);

      const legend = container.querySelector('.token-flow-legend');
      expect(legend?.textContent).toContain('Tokens in');
      expect(legend?.textContent).not.toContain('Not reported');
      expect(legend?.querySelector('.token-flow-swatch--unreported')).toBeNull();
    });

    it('explains it for the WHOLE-BUCKET marker too — one key, both hatched marks', async () => {
      const container = await renderBars([
        bucket({ bucketStart: 1, cost: cost({ responseCount: 3 }) }),
      ]);

      expect(container.querySelector('.token-flow-unmeasured')).not.toBeNull();
      expect(container.querySelector('.token-flow-legend')?.textContent).toContain('Not reported');
    });

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

  /**
   * #1025 — the honesty the chart already had, on the two surfaces beside it.
   *
   * `meteredAggregateColumns()` now counts, per side, how many billed exchanges
   * actually REPORTED a token count, so these two can tell "nobody counted" from
   * "genuinely zero". Before, both read `coalesce(sum(…), 0)` and printed a
   * confident `0` for either.
   */
  describe('the token figures beside the chart (#1025)', () => {
    /** The `<dd>` of the tile labelled `Tokens` — the `dt`, not the table header. */
    function tokensTile(container: HTMLElement): string {
      const dt = [...container.querySelectorAll('.monitor-tiles dt')].find(
        (el) => el.textContent === 'Tokens',
      );
      return dt?.nextElementSibling?.textContent ?? '';
    }

    it('the window totals say NOT REPORTED for agent-CLI-only work, not 0 in / 0 out', async () => {
      /* `cliSpendFact` carries no token fields at all, so this window is 4 real
         billed exchanges whose token use nobody measured. A `0` here reads as a
         subprocess that did nothing. */
      activityMock.mockResolvedValue(
        snapshot({
          agentCli: { invocations: 4, completed: 4, notCompleted: 0, lastAt: 1_785_996_500_000 },
          totals: cost({ responseCount: 4, unpricedResponseCount: 4 }),
        }),
      );
      const { container } = render(<AiActivityPage />);
      await waitFor(() => expect(tokensTile(container)).not.toBe(''));
      expect(tokensTile(container)).toBe('not reported');
    });

    it('an IDLE window still reads 0 in · 0 out — nothing billed is a measured zero', async () => {
      /* The tiles render above the empty-window guard, so this case is reachable
         only here. "not reported" would claim a missing measurement where the
         answer is genuinely nothing. */
      activityMock.mockResolvedValue(snapshot({ totals: cost({ responseCount: 0 }) }));
      const { container } = render(<AiActivityPage />);
      await waitFor(() => expect(tokensTile(container)).not.toBe(''));
      expect(tokensTile(container)).toBe('0 in · 0 out');
    });

    it('a model row whose provider omitted usage says so, per side', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          models: [
            {
              provider: 'openai_api',
              model: 'gpt-5',
              lastAt: 1_785_996_500_000,
              cost: cost({
                responseCount: 2,
                inputTokens: 4000,
                inputReportedResponseCount: 2,
                outputReportedResponseCount: 0,
              }),
            },
          ],
          totals: cost({ responseCount: 2, inputTokens: 4000, inputReportedResponseCount: 2 }),
        }),
      );
      render(<AiActivityPage />);
      await waitFor(() => expect(screen.getByText('gpt-5')).toBeTruthy());
      const row = screen.getByText('gpt-5').closest('tr');
      expect(row?.textContent).toContain('4,000 in · output not reported');
    });
  });

  /**
   * #988 — activity REPORTED BY agents studio did not launch. The page metered
   * only studio's own pipeline runs, so it read all zeros while the autonomy
   * build loop was mid-fire; these pin the section that closes that, and the
   * scope wording that makes the numbers above it honest.
   */
  describe('reported external activity', () => {
    it('explains the ingest seam rather than leaving the section blank', async () => {
      activityMock.mockResolvedValue(snapshot());

      render(<AiActivityPage />);

      await waitFor(() =>
        expect(screen.getByText(/No external agent has reported activity/)).toBeInTheDocument(),
      );
      // An empty monitoring section reads as "nothing is happening ANYWHERE",
      // which is the misreading this ticket is about — so it must state the
      // direction: studio is told, it does not look.
      const notice = screen.getByText(/No external agent has reported activity/);
      expect(notice.textContent).toContain('does not watch processes it did not start');
    });

    it('renders a reported group with its source, agent, model and tokens', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 1,
            completed: 1,
            reporters: [reporter()],
            tokens: {
              inputTokens: 12,
              outputTokens: 34,
              cacheReadTokens: 56,
              cacheCreationTokens: 78,
              measuredInvocations: 1,
            },
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() => expect(screen.getByText('studio-build-loop')).toBeInTheDocument());
      const row = screen.getByText('studio-build-loop').closest('tr');
      expect(row?.textContent).toContain('claude-opus-5');
      expect(row?.textContent).toContain('12 in · 34 out · 56 cached');
    });

    /**
     * THE ticket's symptom in its second form. The window notice was gated on
     * the metered rows alone, so a window whose only AI use was reported would
     * have declared itself idle directly above a table of live invocations.
     */
    it('does not call the window idle when only external activity was reported', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 2,
            inFlight: 1,
            unknown: 1,
            completed: 1,
            reporters: [reporter({ invocations: 2, inFlight: 1, unknown: 1 })],
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() => expect(screen.getByText('studio-build-loop')).toBeInTheDocument());
      expect(screen.queryByText('No AI or agent activity in this window.')).toBeNull();
    });

    /**
     * The live answer leads. "Is my agent working right now" is the question the
     * section was added for, so a summary opening with a historical count would
     * bury it.
     */
    it('leads with what is running now, and states the whole partition', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 3,
            completed: 1,
            notCompleted: 1,
            unknown: 1,
            inFlight: 1,
            reporters: [reporter({ invocations: 3, completed: 1, notCompleted: 1, unknown: 1 })],
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() =>
        expect(
          screen.getByText('1 of 3 reported invocations running now — 1 completed, 1 did not, 1 unknown.'),
        ).toBeInTheDocument(),
      );
    });

    it('reads unmeasured reported tokens as not reported, never as a zero', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 1,
            unknown: 1,
            inFlight: 1,
            reporters: [
              reporter({
                completed: 0,
                unknown: 1,
                inFlight: 1,
                tokens: {
                  inputTokens: null,
                  outputTokens: null,
                  cacheReadTokens: null,
                  cacheCreationTokens: null,
                  measuredInvocations: 0,
                },
              }),
            ],
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() => expect(screen.getByText('studio-build-loop')).toBeInTheDocument());
      const row = screen.getByText('studio-build-loop').closest('tr');
      // The exact short reading, not merely a substring: 'input not reported ·
      // output not reported' would also contain 'not reported' while proving the
      // collapse never happened.
      expect(row?.textContent).toContain('not reported');
      expect(row?.textContent).not.toContain('input not reported');
      expect(row?.textContent).not.toContain('0 in');
    });

    it('says the breakdown is a prefix when the server truncated it', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 99,
            completed: 99,
            truncated: true,
            reporters: [reporter({ invocations: 99, completed: 99 })],
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() =>
        expect(screen.getByText(/Showing the busiest reporters only/)).toBeInTheDocument(),
      );
    });

    /**
     * #28 in the prevention log: a signal must NAME the actor it measures. The
     * page said "AI activity" and meant "AI activity studio dispatched".
     */
    it('states whose activity the figures above cover', async () => {
      activityMock.mockResolvedValue(snapshot());

      render(<AiActivityPage />);

      await waitFor(() =>
        expect(screen.getByText(/in THIS workspace's runs/)).toBeInTheDocument(),
      );
    });
    /**
     * A group is MANY invocations, so "some reported" is a state a single row
     * cannot have. Two of five fires reporting tokens must not render as a
     * confident total for all five.
     */
    it('says how many of a group’s invocations were measured when only some were', async () => {
      activityMock.mockResolvedValue(
        snapshot({
          external: externalActivity({
            invocations: 5,
            completed: 5,
            reporters: [
              reporter({
                invocations: 5,
                completed: 5,
                tokens: {
                  inputTokens: 12,
                  outputTokens: 34,
                  cacheReadTokens: null,
                  cacheCreationTokens: null,
                  measuredInvocations: 2,
                },
              }),
            ],
          }),
        }),
      );

      render(<AiActivityPage />);

      await waitFor(() => expect(screen.getByText('studio-build-loop')).toBeInTheDocument());
      const row = screen.getByText('studio-build-loop').closest('tr');
      expect(row?.textContent).toContain('2 of 5 measured');
    });
  });
});
