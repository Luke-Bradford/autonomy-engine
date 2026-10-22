import { describe, expect, it } from 'vitest';
import {
  SCRIPT_ACTIVITY_TYPE,
  SCRIPT_MAX_BLOCK_TIMEOUT_SECONDS,
  getActivity,
  scriptConfigSchema,
  scriptDispatchConfigSchema,
} from '../../index.js';

const blocks = [{ type: 'query', sql: 'select 1' }];

describe('#1600 OR41 C10b-2b — Script Block timeout and Capture messages', () => {
  it('leaves both unset by default: no Block timeout, messages not captured', () => {
    const cfg = scriptConfigSchema.parse({ blocks });
    expect(cfg.blockTimeoutSeconds).toBeUndefined();
    expect(cfg.captureMessages).toBe(false);
  });

  it('takes a Block timeout in whole seconds, up to a day', () => {
    for (const schema of [scriptConfigSchema, scriptDispatchConfigSchema]) {
      expect(schema.parse({ blocks, blockTimeoutSeconds: 60 }).blockTimeoutSeconds).toBe(60);
      expect(
        schema.safeParse({ blocks, blockTimeoutSeconds: SCRIPT_MAX_BLOCK_TIMEOUT_SECONDS }).success,
      ).toBe(true);
      for (const bad of [0, -1, 1.5, SCRIPT_MAX_BLOCK_TIMEOUT_SECONDS + 1, '60']) {
        expect(schema.safeParse({ blocks, blockTimeoutSeconds: bad }).success).toBe(false);
      }
    }
  });

  it('keeps pg’s client timer under setTimeout’s ceiling', () => {
    expect(SCRIPT_MAX_BLOCK_TIMEOUT_SECONDS * 1000).toBeLessThan(2 ** 31 - 1);
  });

  it('draws both on the Settings tab, for a postgres connection only', () => {
    const entry = getActivity(SCRIPT_ACTIVITY_TYPE);
    const settings = entry?.tabs?.find((t) => t.key === 'settings');
    expect(settings?.fields).toEqual(
      expect.arrayContaining(['captureMessages', 'blockTimeoutSeconds']),
    );
    expect(entry?.appliesWhen?.['blockTimeoutSeconds']).toEqual([{ connectionKind: ['postgres'] }]);
    expect(entry?.appliesWhen?.['captureMessages']).toEqual([{ connectionKind: ['postgres'] }]);
  });

  it('declares outputLogs, and keeps the outputs a Script saved before it declares', () => {
    const entry = getActivity(SCRIPT_ACTIVITY_TYPE);
    expect(entry?.outputs.map((o) => o.name)).toContain('outputLogs');
    expect(entry?.formerOutputs?.map((set) => set.map((o) => o.name))).toEqual([
      ['resultSetCount', 'resultSets', 'recordsAffected', 'outputParameters', 'truncated'],
    ]);
  });
});
