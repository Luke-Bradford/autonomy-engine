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

describe('WindowConfigSchema — retry (#5 S11c)', () => {
  it('round-trips a config with a retry policy', () => {
    const w = { ...config, retry: { count: 3, intervalInSeconds: 60 } };
    expect(WindowConfigSchema.parse(w)).toEqual(w);
  });

  it('is optional — absent means no retry (window.failed stays terminal, exact S9-S11b behavior)', () => {
    const parsed = WindowConfigSchema.parse(config);
    expect(parsed.retry).toBeUndefined();
  });

  it('rejects a non-positive or fractional count/intervalInSeconds', () => {
    expect(() =>
      WindowConfigSchema.parse({ ...config, retry: { count: 0, intervalInSeconds: 60 } }),
    ).toThrow();
    expect(() =>
      WindowConfigSchema.parse({ ...config, retry: { count: 1.5, intervalInSeconds: 60 } }),
    ).toThrow();
    expect(() =>
      WindowConfigSchema.parse({ ...config, retry: { count: 3, intervalInSeconds: 0 } }),
    ).toThrow();
    expect(() =>
      WindowConfigSchema.parse({ ...config, retry: { count: 3, intervalInSeconds: -30 } }),
    ).toThrow();
  });

  it('requires both fields when present (a half-specified policy is refused)', () => {
    expect(() => WindowConfigSchema.parse({ ...config, retry: { count: 3 } })).toThrow();
    expect(() =>
      WindowConfigSchema.parse({ ...config, retry: { intervalInSeconds: 60 } }),
    ).toThrow();
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

  // #5 S11c — the retry write-boundary caps (ADF's activity-retry range).
  it('accepts retry at the write-boundary bounds (count 100, interval 30..86400)', () => {
    const min = { ...config, retry: { count: 1, intervalInSeconds: 30 } };
    expect(WindowConfigWriteSchema.parse(min)).toEqual(min);
    const max = { ...config, retry: { count: 100, intervalInSeconds: 86_400 } };
    expect(WindowConfigWriteSchema.parse(max)).toEqual(max);
  });

  it('rejects retry outside the write bounds (stored shape stays lenient)', () => {
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, retry: { count: 101, intervalInSeconds: 60 } }),
    ).toThrow();
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, retry: { count: 3, intervalInSeconds: 29 } }),
    ).toThrow();
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, retry: { count: 3, intervalInSeconds: 86_401 } }),
    ).toThrow();
    // Stored/read shape parses the same values — the caps are a write concern,
    // so a row persisted under a future, looser cap never throws on read (and
    // the settle path HONORS the stored value — the maxBackfillWindows
    // precedent).
    const stored = { ...config, retry: { count: 101, intervalInSeconds: 1 } };
    expect(WindowConfigSchema.parse(stored)).toEqual(stored);
  });
});

// #5 S11d — the self-dependency write-boundary rules. `config` is 15-minute
// windows (size 900s), so the span cap is 100 * 900 = 90000s.
describe('WindowConfigWriteSchema (selfDependency cross-field rules)', () => {
  it('accepts a previous-window dependency (offset = -size, size defaulted)', () => {
    const w = { ...config, selfDependency: { offsetInSeconds: -900 } };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('accepts an explicit interval lying wholly in the past', () => {
    const w = { ...config, selfDependency: { offsetInSeconds: -3600, sizeInSeconds: 1800 } };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('rejects zero/positive offset at the object shape', () => {
    expect(() =>
      WindowConfigSchema.parse({ ...config, selfDependency: { offsetInSeconds: 0 } }),
    ).toThrow();
    expect(() =>
      WindowConfigSchema.parse({ ...config, selfDependency: { offsetInSeconds: 900 } }),
    ).toThrow();
  });

  it('rejects an interval overlapping the window itself (offset + size > 0 — structural deadlock)', () => {
    // size defaults to one window (900): offset -900 + 1800 explicit = +900 → overlap.
    expect(() =>
      WindowConfigWriteSchema.parse({
        ...config,
        selfDependency: { offsetInSeconds: -900, sizeInSeconds: 1800 },
      }),
    ).toThrow();
    // Defaulted size: offset -1 + 900 = +899 → overlap.
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, selfDependency: { offsetInSeconds: -1 } }),
    ).toThrow();
  });

  it('rejects spans past the 100-window cap on WRITE (stored shape stays lenient)', () => {
    // Reach: 101 windows back.
    expect(() =>
      WindowConfigWriteSchema.parse({
        ...config,
        selfDependency: { offsetInSeconds: -900 * 101 },
      }),
    ).toThrow();
    // Length: 100-window size but offset only 100 back → also overlaps; use a
    // far offset with an over-cap size to isolate the size rule.
    expect(() =>
      WindowConfigWriteSchema.parse({
        ...config,
        selfDependency: { offsetInSeconds: -900 * 100, sizeInSeconds: 900 * 101 },
      }),
    ).toThrow();
    // Stored/read shape parses the same value — the gate HONORS what it finds
    // (which can at worst permanently block the trigger's OWN windows).
    const stored = { ...config, selfDependency: { offsetInSeconds: -900 * 101 } };
    expect(WindowConfigSchema.parse(stored)).toEqual(stored);
  });

  it('accepts the exact cap boundary (100 windows reach and length)', () => {
    const w = {
      ...config,
      selfDependency: { offsetInSeconds: -900 * 100, sizeInSeconds: 900 * 100 },
    };
    // offset + size = 0 → wholly in the past (right-open interval) → legal.
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });
});
