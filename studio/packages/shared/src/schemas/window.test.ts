import { describe, expect, it } from 'vitest';
import { WindowConfigSchema, WindowConfigWriteSchema, WindowFrequencySchema } from './window.js';

const config = {
  frequency: 'minute',
  interval: 15,
  startTime: '2026-07-01T00:00:00.000Z',
};

describe('WindowFrequencySchema', () => {
  it.each(['minute', 'hour', 'day'])('accepts %s', (f) => {
    expect(WindowFrequencySchema.parse(f)).toBe(f);
  });

  it.each(['week', 'month', 'second'])(
    'rejects %s (variable-length / sub-minute are not v1 window units)',
    (f) => {
      expect(() => WindowFrequencySchema.parse(f)).toThrow();
    },
  );
});

describe('WindowConfigSchema', () => {
  it('round-trips a minimal config', () => {
    expect(WindowConfigSchema.parse(config)).toEqual(config);
  });

  it('round-trips a config with an endTime bound', () => {
    const bounded = { ...config, endTime: '2026-08-01T00:00:00.000Z' };
    expect(WindowConfigSchema.parse(bounded)).toEqual(bounded);
  });

  it('rejects a non-positive or fractional interval', () => {
    expect(() => WindowConfigSchema.parse({ ...config, interval: 0 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, interval: -1 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, interval: 1.5 })).toThrow();
  });

  it('rejects a non-datetime startTime/endTime', () => {
    expect(() => WindowConfigSchema.parse({ ...config, startTime: 'yesterday' })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, endTime: 'someday' })).toThrow();
  });
});

describe('WindowConfigSchema — maxBackfillWindows (#5 S10)', () => {
  it('round-trips a config with maxBackfillWindows', () => {
    const w = { ...config, maxBackfillWindows: 48 };
    expect(WindowConfigSchema.parse(w)).toEqual(w);
  });

  it('is optional — absent means no backfill (exact S9 behavior)', () => {
    const parsed = WindowConfigSchema.parse(config);
    expect(parsed.maxBackfillWindows).toBeUndefined();
  });

  it('rejects a non-positive or fractional maxBackfillWindows', () => {
    expect(() => WindowConfigSchema.parse({ ...config, maxBackfillWindows: 0 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, maxBackfillWindows: -5 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, maxBackfillWindows: 1.5 })).toThrow();
  });
});

describe('WindowConfigSchema — maxConcurrentWindows (#5 S11a)', () => {
  it('round-trips a config with maxConcurrentWindows', () => {
    const w = { ...config, maxConcurrentWindows: 4 };
    expect(WindowConfigSchema.parse(w)).toEqual(w);
  });

  it('is optional — absent means the exact S9/S10 ungated behavior', () => {
    const parsed = WindowConfigSchema.parse(config);
    expect(parsed.maxConcurrentWindows).toBeUndefined();
  });

  it('rejects a non-positive or fractional maxConcurrentWindows', () => {
    expect(() => WindowConfigSchema.parse({ ...config, maxConcurrentWindows: 0 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, maxConcurrentWindows: -2 })).toThrow();
    expect(() => WindowConfigSchema.parse({ ...config, maxConcurrentWindows: 1.5 })).toThrow();
  });
});

describe('WindowConfigWriteSchema (write-boundary cross-field rule)', () => {
  it('accepts endTime strictly after startTime', () => {
    const w = { ...config, endTime: '2026-07-02T00:00:00.000Z' };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('accepts maxBackfillWindows up to the write-boundary cap (1000)', () => {
    const w = { ...config, maxBackfillWindows: 1000 };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('rejects maxBackfillWindows above the cap on WRITE (stored shape stays lenient)', () => {
    expect(() => WindowConfigWriteSchema.parse({ ...config, maxBackfillWindows: 1001 })).toThrow();
    // Stored/read shape parses the same value — the cap is a write concern, so a
    // row persisted under a future, looser cap never throws on read.
    expect(WindowConfigSchema.parse({ ...config, maxBackfillWindows: 1001 })).toEqual({
      ...config,
      maxBackfillWindows: 1001,
    });
  });

  it('accepts maxConcurrentWindows up to the write-boundary cap (50)', () => {
    const w = { ...config, maxConcurrentWindows: 50 };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('rejects maxConcurrentWindows above the cap on WRITE (stored shape stays lenient)', () => {
    expect(() => WindowConfigWriteSchema.parse({ ...config, maxConcurrentWindows: 51 })).toThrow();
    // Stored/read shape parses the same value — the cap is a write concern, so a
    // row persisted under a future, looser cap never throws on read (and the
    // capacity gate HONORS the stored value — the maxBackfillWindows precedent).
    expect(WindowConfigSchema.parse({ ...config, maxConcurrentWindows: 51 })).toEqual({
      ...config,
      maxConcurrentWindows: 51,
    });
  });

  it('rejects endTime at or before startTime', () => {
    expect(() => WindowConfigWriteSchema.parse({ ...config, endTime: config.startTime })).toThrow();
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, endTime: '2026-06-30T00:00:00.000Z' }),
    ).toThrow();
  });
});
