import { describe, expect, it } from 'vitest';
import { formatTokenCount, formatUsd } from '../display.js';

/**
 * #866 — the load-bearing property is the SMALL end: money that was spent must
 * never render as `$0.00`, because that reads as free.
 */
describe('formatUsd', () => {
  it('renders a genuine zero as $0.00 — the ONE amount allowed to say it', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('never flattens a real charge to $0.00', () => {
    // A single cheap exchange. Two decimals would print `$0.00`.
    expect(formatUsd(0.0000123)).toBe('$0.000012');
    expect(formatUsd(0.0055)).toBe('$0.0055');
    expect(formatUsd(0.009)).toBe('$0.009');
  });

  it('renders an amount below the smallest stateable figure as a bound, not as zero', () => {
    expect(formatUsd(0.0000001)).toBe('< $0.000001');
    // The boundary itself IS stateable.
    expect(formatUsd(0.000001)).toBe('$0.000001');
  });

  it('renders an ordinary amount to two decimals', () => {
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(1.239)).toBe('$1.24');
    // Grouped, matching formatTokenCount — one module, one convention.
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('is TOTAL — a non-finite or negative amount is stated as unknown, never $NaN', () => {
    expect(formatUsd(Number.NaN)).toBe('—');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatUsd(-1)).toBe('—');
  });
});

describe('formatTokenCount', () => {
  it('groups a count with the locale PINNED, so the render is machine-independent', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1234567)).toBe('1,234,567');
  });

  it('is TOTAL', () => {
    expect(formatTokenCount(Number.NaN)).toBe('—');
    expect(formatTokenCount(-3)).toBe('—');
  });
});
