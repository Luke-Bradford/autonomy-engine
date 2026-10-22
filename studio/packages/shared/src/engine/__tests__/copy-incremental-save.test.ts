/**
 * #1600 OR41 C5a — the pipeline-level save rule for a Copy's Load Incremental:
 * Watermark from Automatic cannot sit inside a ForEach or an Until, at any
 * depth. Automatic keys its stored watermark by the activity and its source, and
 * an iteration does not identify what it copied (a ForEach's items may run at
 * once and in any order).
 */
import { describe, expect, it } from 'vitest';
import type { Container, Node } from '../types.js';
import { validatePipelineDoc } from '../validate-pipeline.js';

const copy = (config: Record<string, unknown>): Node => ({
  id: 'c',
  type: 'copy',
  config: { mapping: [{ source: 'a', sink: 'a', type: 'integer' }], ...config },
  connectionIds: { source: 'src', sink: 'snk' },
  datasetIds: { source: 'ds1', sink: 'ds2' },
  position: { x: 0, y: 0 },
});
const validate = (nodes: Node[], containers: Container[] = []) =>
  validatePipelineDoc({ params: [], nodes, edges: [], containers, variables: [] });
const AUTOMATIC = { load: 'incremental', watermarkColumnName: 'm' };
const REFUSAL =
  'node.c.watermarkFrom: Watermark from Automatic cannot run inside a ForEach or Until';
const fe = (children: string[]): Container => ({
  id: 'fe',
  kind: 'foreach',
  children,
  items: '${createArray(1, 2)}',
});
const until = (children: string[]): Container => ({
  id: 'u',
  kind: 'loop',
  children,
  exitWhen: '${true}',
});

describe('Copy Load Incremental at save (C5a)', () => {
  it('saves Automatic outside an iterating container, and inside a Stage', () => {
    expect(validate([copy(AUTOMATIC)]).some((e) => e.includes('watermarkFrom'))).toBe(false);
    const staged = validate([copy(AUTOMATIC)], [{ id: 'st', kind: 'stage', children: ['c'] }]);
    expect(staged.some((e) => e.includes('watermarkFrom'))).toBe(false);
  });

  it('refuses Automatic inside a ForEach or an Until, at any depth', () => {
    const nested = validate(
      [copy(AUTOMATIC)],
      [fe(['st']), { id: 'st', kind: 'stage', children: ['c'] } as Container],
    );
    for (const errs of [
      validate([copy(AUTOMATIC)], [fe(['c'])]),
      validate([copy(AUTOMATIC)], [until(['c'])]),
      nested,
    ]) {
      expect(errs.some((e) => e.startsWith(REFUSAL))).toBe(true);
    }
  });

  it('saves Expression inside a ForEach: the pipeline supplies each old watermark', () => {
    const errs = validate(
      [copy({ ...AUTOMATIC, watermarkFrom: 'expression', watermarkOld: '${item()}' })],
      [fe(['c'])],
    );
    expect(errs.some((e) => e.includes('watermarkFrom'))).toBe(false);
  });

  it('refuses the field rules at save, as the dispatch schema would', () => {
    const errs = validate([copy({ load: 'incremental' })]);
    expect(errs.some((e) => e.includes('Load Incremental needs a watermark column'))).toBe(true);
  });
});

/**
 * #1600 OR41 C5b — a Files as-is copy's Load Incremental is always Automatic
 * (the explicit window is Load Full with Modified between), so it has the same
 * rule: never inside a ForEach or an Until. And Load stays literal at save,
 * where an expression would otherwise be left for dispatch.
 */
describe('Copy · Files as-is Load Incremental at save (C5b)', () => {
  const files = (config: Record<string, unknown>): Node => ({
    id: 'c',
    type: 'copy_files',
    config: { sourcePath: 'in', ...config },
    connectionIds: { source: 'src', sink: 'snk' },
    position: { x: 0, y: 0 },
  });
  const FILES_REFUSAL = 'node.c.load: Load Incremental cannot run inside a ForEach or Until';

  it('saves Incremental outside an iterating container, and Full inside one', () => {
    expect(validate([files({ load: 'incremental' })])).toEqual([]);
    expect(validate([files({})], [fe(['c'])])).toEqual([]);
  });

  it('refuses Incremental inside a ForEach or an Until', () => {
    for (const c of [fe(['c']), until(['c'])]) {
      const errs = validate([files({ load: 'incremental' })], [c]);
      expect(errs.some((e) => e.startsWith(FILES_REFUSAL))).toBe(true);
    }
  });

  it('refuses an expression in Load', () => {
    const errs = validate([files({ load: '${pipeline().parameters.l}' })]);
    expect(errs).toContain(
      'node.c.load: Load stays literal, because it decides which fields apply',
    );
  });
});
