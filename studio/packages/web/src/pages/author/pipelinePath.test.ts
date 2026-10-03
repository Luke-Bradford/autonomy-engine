import { describe, expect, it } from 'vitest';
import { pipelinePath, readOpenVersion, runVersionPath } from './pipelinePath';

describe('pipelinePath (#1484)', () => {
  it('opens the pipeline, or one exact saved version of it', () => {
    expect(pipelinePath('pl_1')).toBe('/author/pipelines/pl_1');
    expect(pipelinePath('pl_1', 3)).toBe('/author/pipelines/pl_1?version=3');
  });

  it("a run's version link names the saved version, never a debug one", () => {
    expect(runVersionPath('pl_1', 3, false)).toBe('/author/pipelines/pl_1?version=3');
    expect(runVersionPath('pl_1', 3, true)).toBe('/author/pipelines/pl_1');
  });

  it('reads back only a whole positive version number', () => {
    expect(readOpenVersion(new URLSearchParams('version=3'))).toBe(3);
    for (const raw of [
      '',
      'version=',
      'version=0',
      'version=-1',
      'version=2.5',
      'version=1e3',
      'version=x',
    ]) {
      expect(readOpenVersion(new URLSearchParams(raw)), raw).toBeUndefined();
    }
  });
});
