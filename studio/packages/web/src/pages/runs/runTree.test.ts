import { describe, expect, it } from 'vitest';
import { nestRuns, type NestableRun } from './runTree';

function r(id: string, parentRunId: string | null, startedAt: number): NestableRun {
  return { id, parentRunId, startedAt };
}

const view = (rows: ReturnType<typeof nestRuns<NestableRun>>) =>
  rows.map((row) => `${'  '.repeat(row.depth)}${row.run.id}:${row.shown}${row.expanded ? '' : '+'}`);

describe('nestRuns (#1484)', () => {
  it('puts each child under its parent in call order, and keeps the roots in list order', () => {
    // The server's order: newest first, so the children come BEFORE their parent.
    const runs = [
      r('c2', 'p', 30),
      r('c1', 'p', 20),
      r('other', null, 15),
      r('p', null, 10),
      r('g', 'c1', 25),
    ];
    expect(view(nestRuns(runs, new Set()))).toEqual([
      'other:0',
      'p:2',
      '  c1:1',
      '    g:0',
      '  c2:0',
    ]);
  });

  it('keeps a child whose parent is not loaded as a root of its own', () => {
    expect(view(nestRuns([r('c', 'gone', 2), r('x', null, 1)], new Set()))).toEqual([
      'c:0',
      'x:0',
    ]);
  });

  it('hides the whole subtree of a collapsed parent, but still counts its children', () => {
    const runs = [r('p', null, 1), r('c', 'p', 2), r('g', 'c', 3)];
    expect(view(nestRuns(runs, new Set(['p'])))).toEqual(['p:1+']);
    expect(view(nestRuns(runs, new Set(['c'])))).toEqual(['p:1', '  c:1+']);
  });

  it('breaks ties by id, and survives a cycle without looping or losing a run', () => {
    expect(view(nestRuns([r('p', null, 1), r('b', 'p', 5), r('a', 'p', 5)], new Set()))).toEqual([
      'p:2',
      '  a:0',
      '  b:0',
    ]);
    // Not creatable through the app; drawn flat rather than dropped.
    const cycle = nestRuns([r('a', 'b', 1), r('b', 'a', 2)], new Set());
    expect(cycle.map((row) => row.run.id).sort()).toEqual(['a', 'b']);
  });
});
