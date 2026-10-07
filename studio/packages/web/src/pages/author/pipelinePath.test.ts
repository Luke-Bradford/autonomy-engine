import { describe, expect, it } from 'vitest';
import {
  pipelinePath,
  runEditorLabel,
  readOpenNode,
  readOpenVersion,
  runVersionPath,
  withOpenVersion,
} from './pipelinePath';

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

  it('#1541 — names an activity to select in that version, and only in a saved one', () => {
    expect(pipelinePath('pl_1', 3, 'n 1&x')).toBe('/author/pipelines/pl_1?version=3&node=n+1%26x');
    // No version, no node: the editor's working copy is not the version that ran.
    expect(pipelinePath('pl_1', undefined, 'n1')).toBe('/author/pipelines/pl_1');
    expect(runVersionPath('pl_1', 3, false, 'n1')).toBe('/author/pipelines/pl_1?version=3&node=n1');
    expect(runVersionPath('pl_1', 3, true, 'n1')).toBe('/author/pipelines/pl_1');
  });

  it('#1541 — reads the node back as written, and nothing for an absent or empty one', () => {
    expect(readOpenNode(new URLSearchParams(pipelinePath('pl_1', 3, 'n 1&x').split('?')[1]))).toBe(
      'n 1&x',
    );
    expect(readOpenNode(new URLSearchParams('version=3'))).toBeUndefined();
    expect(readOpenNode(new URLSearchParams('version=3&node='))).toBeUndefined();
  });
});

describe('withOpenVersion (#1521)', () => {
  const at = (search: string, version: number | null, node?: string) =>
    withOpenVersion(new URLSearchParams(search), version, node).toString();

  it('writes the previewed version, keeping every other param', () => {
    expect(at('tab=runs', 2)).toBe('tab=runs&version=2');
    expect(at('version=1&tab=runs', 3)).toBe('version=3&tab=runs');
  });

  it('removes the version for none, and the node with it', () => {
    expect(at('version=2&node=n_a&tab=runs', null)).toBe('tab=runs');
  });

  it('writes the node it is given, and removes one it is not', () => {
    expect(at('', 2, 'n_a')).toBe('version=2&node=n_a');
    expect(at('version=2&node=n_a', 1)).toBe('version=1');
  });
});

describe('runEditorLabel (#1566)', () => {
  it('names the version that ran, and the pipeline where several runs share a screen', () => {
    expect(runEditorLabel(3, false)).toBe('Open v3 in the editor');
    expect(runEditorLabel(3, false, 'Nightly')).toBe('Open Nightly v3 in the editor');
  });

  it('a debug run opens the pipeline, so its label promises no version', () => {
    expect(runEditorLabel(2, true)).toBe('Open the pipeline in the editor');
    expect(runEditorLabel(2, true, 'Nightly')).toBe('Open Nightly in the editor');
  });
});
