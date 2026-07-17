import { describe, expect, it } from 'vitest';
import {
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
} from '../types.js';
import {
  fileCopyConfigSchema,
  fileDeleteConfigSchema,
  fileListConfigSchema,
  fileMoveConfigSchema,
  fileReadConfigSchema,
  fileWriteConfigSchema,
} from '../fs-activity-config.js';
import { getActivity } from '../registry.js';

/**
 * #578 — the DRIFT GUARD. Each `fs` activity's input shape lives once, in
 * `fs-activity-config.ts`, read by BOTH the catalog `configSchema` (palette
 * metadata) and the server `fs` adapter's live-request validation. Assert the
 * catalog entry holds the SAME schema OBJECT (identity `===`) so a change to one
 * shape can never leave the other stale — the same SSOT check `llm-config.test.ts`
 * makes for `llm_call`.
 */
describe('fs activity config — SSOT with the catalog', () => {
  const cases: Array<[string, unknown]> = [
    [FILE_READ_ACTIVITY_TYPE, fileReadConfigSchema],
    [FILE_WRITE_ACTIVITY_TYPE, fileWriteConfigSchema],
    [FILE_COPY_ACTIVITY_TYPE, fileCopyConfigSchema],
    [FILE_MOVE_ACTIVITY_TYPE, fileMoveConfigSchema],
    [FILE_DELETE_ACTIVITY_TYPE, fileDeleteConfigSchema],
    [FILE_LIST_ACTIVITY_TYPE, fileListConfigSchema],
  ];

  it.each(cases)('%s catalog configSchema IS the shared schema object', (type, schema) => {
    expect(getActivity(type)!.configSchema).toBe(schema);
  });
});

describe('fs activity config — shapes', () => {
  it('file_read/delete/list require a non-empty path', () => {
    for (const schema of [fileReadConfigSchema, fileDeleteConfigSchema, fileListConfigSchema]) {
      expect(schema.safeParse({ path: '/a' }).success).toBe(true);
      expect(schema.safeParse({ path: '' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('file_write requires a non-empty path and string content', () => {
    expect(fileWriteConfigSchema.safeParse({ path: '/a', content: '' }).success).toBe(true);
    expect(fileWriteConfigSchema.safeParse({ path: '/a' }).success).toBe(false);
    expect(fileWriteConfigSchema.safeParse({ path: '', content: 'x' }).success).toBe(false);
  });

  it('file_copy/move require non-empty source and dest', () => {
    for (const schema of [fileCopyConfigSchema, fileMoveConfigSchema]) {
      expect(schema.safeParse({ source: '/a', dest: '/b' }).success).toBe(true);
      expect(schema.safeParse({ source: '/a' }).success).toBe(false);
      expect(schema.safeParse({ source: '', dest: '/b' }).success).toBe(false);
    }
  });
});
