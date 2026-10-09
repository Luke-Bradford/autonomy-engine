import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SECURE_REDACTED } from '@autonomy-studio/shared';
import { CaptureSection, MAX_CAPTURE_EXCHANGES } from './CaptureSection';
import type { NodeCapture } from './runSummary';

const whole = (text: string) => ({ text, chars: text.length, truncated: false });

function exchange(over: Partial<NodeCapture> = {}): NodeCapture {
  return {
    model: 'llama3',
    system: whole('be brief'),
    messages: [{ role: 'user', toolTurn: undefined, ...whole('what is 2+2?') }],
    completion: whole('4'),
    reasoning: undefined,
    attempt: 1,
    instanceId: undefined,
    ...over,
  };
}

describe('CaptureSection (#605)', () => {
  it('shows the system, each turn and the completion, labelled', () => {
    render(<CaptureSection captures={[exchange()]} />);
    const section = screen.getByRole('group', { name: 'Prompt & completion' });
    // #1413 — the line under the heading is the section's description.
    expect(section).toHaveAccessibleDescription(
      'Stored because this node’s capture setting is full.',
    );
    expect(within(section).getByText('be brief')).toBeTruthy();
    expect(within(section).getByText('what is 2+2?')).toBeTruthy();
    expect(within(section).getByText('4')).toBeTruthy();
    for (const label of ['System', 'User', 'Completion']) {
      expect(within(section).getByRole('heading', { name: label })).toBeTruthy();
    }
    expect(within(section).queryByText(/withheld/)).toBeNull();
  });

  it('says how much of a cut field it kept', () => {
    render(
      <CaptureSection
        captures={[exchange({ completion: { text: 'abc', chars: 20_000, truncated: true } })]}
      />,
    );
    expect(screen.getByText('… stored the first 3 of 20000 characters.')).toBeTruthy();
  });

  it('says a field the budget left EMPTY was not stored, rather than empty', () => {
    render(
      <CaptureSection
        captures={[
          exchange({
            messages: [
              { role: 'user', toolTurn: undefined, text: '', chars: 900, truncated: true },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Not stored: the capture budget was spent/)).toBeTruthy();
    expect(screen.queryByText('Empty.')).toBeNull();
  });

  it('labels the turns that record an earlier tool round-trip (#605)', () => {
    render(
      <CaptureSection
        captures={[
          exchange({
            messages: [
              { role: 'user', toolTurn: undefined, ...whole('add 1 and 2') },
              { role: 'assistant', toolTurn: 'calls', ...whole('[{"name":"adder"}]') },
              { role: 'user', toolTurn: 'result', ...whole('3') },
              { role: 'user', toolTurn: 'error', ...whole("unknown tool 'x'") },
            ],
          }),
        ]}
      />,
    );
    const section = screen.getByRole('group', { name: 'Prompt & completion' });
    const headings = within(section)
      .getAllByRole('heading')
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Prompt & completion',
      'System',
      'User',
      'Tool calls',
      'Tool result',
      'Tool result (error)',
      'Completion',
    ]);
  });

  // #605 — the reasoning trace: a labelled block of its own, and withheld on a
  // secure node like any other captured text.
  it("shows the model's reasoning summary as its own labelled block", () => {
    render(<CaptureSection captures={[exchange({ reasoning: whole('add the two') })]} />);
    const section = screen.getByRole('group', { name: 'Prompt & completion' });
    const heading = within(section).getByRole('heading', {
      name: "Reasoning (the model's summary)",
    });
    expect(heading.parentElement?.textContent).toContain('add the two');
  });

  it('shows no reasoning block when none was recorded', () => {
    render(<CaptureSection captures={[exchange()]} />);
    expect(screen.queryByRole('heading', { name: /Reasoning/ })).toBeNull();
  });

  it('explains a withheld reasoning summary', () => {
    render(<CaptureSection captures={[exchange({ reasoning: whole(SECURE_REDACTED) })]} />);
    expect(screen.getByText(/captured text was redacted/)).toBeTruthy();
  });

  it('tells an empty completion apart from a missing one', () => {
    const { unmount } = render(<CaptureSection captures={[exchange({ completion: whole('') })]} />);
    expect(screen.getByText('Empty.')).toBeTruthy();
    unmount();
    render(<CaptureSection captures={[exchange({ completion: undefined })]} />);
    expect(screen.getByText(/No completion was recorded/)).toBeTruthy();
  });

  it('explains a secure node’s withheld text under EITHER flag', () => {
    const marker = { text: SECURE_REDACTED, chars: 40, truncated: false };
    render(
      <CaptureSection
        captures={[
          exchange({
            system: undefined,
            messages: [{ role: 'user', toolTurn: undefined, ...marker }],
            completion: marker,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Secure input or Secure output set/)).toBeTruthy();
    expect(screen.getAllByText(SECURE_REDACTED).length).toBeGreaterThanOrEqual(2);
  });

  it('renders only the most recent exchanges, and says so', () => {
    const many = Array.from({ length: MAX_CAPTURE_EXCHANGES + 2 }, (_, i) =>
      exchange({ completion: whole(`answer-${i}`) }),
    );
    render(<CaptureSection captures={many} />);
    expect(screen.queryByText('answer-0')).toBeNull();
    expect(screen.getByText(`answer-${MAX_CAPTURE_EXCHANGES + 1}`)).toBeTruthy();
    expect(
      screen.getByText(
        `… showing the most recent ${MAX_CAPTURE_EXCHANGES} of ${MAX_CAPTURE_EXCHANGES + 2} exchanges.`,
      ),
    ).toBeTruthy();
  });
});
