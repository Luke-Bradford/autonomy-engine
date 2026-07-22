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

describe('WindowConfigWriteSchema (write-boundary cross-field rule)', () => {
  it('accepts endTime strictly after startTime', () => {
    const w = { ...config, endTime: '2026-07-02T00:00:00.000Z' };
    expect(WindowConfigWriteSchema.parse(w)).toEqual(w);
  });

  it('rejects endTime at or before startTime', () => {
    expect(() => WindowConfigWriteSchema.parse({ ...config, endTime: config.startTime })).toThrow();
    expect(() =>
      WindowConfigWriteSchema.parse({ ...config, endTime: '2026-06-30T00:00:00.000Z' }),
    ).toThrow();
  });
});
