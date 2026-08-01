import { describe, expect, it } from 'vitest';
import type { Node } from '@autonomy-studio/shared';
import { applyInsert, insertModeFor } from './expressionInsert';
import { validateCanvas } from './canvasDoc';

describe('applyInsert', () => {
  it('splices at the caret and leaves the caret after the inserted text', () => {
    expect(applyInsert('ab', 1, 1, 'X', 'insert')).toEqual({ value: 'aXb', caret: 2 });
  });

  it('replaces a selection, exactly as typing would', () => {
    expect(applyInsert('hello world', 6, 11, 'X', 'insert')).toEqual({
      value: 'hello X',
      caret: 7,
    });
  });

  it('fills an empty field', () => {
    expect(applyInsert('', 0, 0, '${run.runId}', 'insert')).toEqual({
      value: '${run.runId}',
      caret: 12,
    });
  });

  it('replace mode discards the whole value, however the caret sat', () => {
    expect(applyInsert('old text', 3, 3, '${x}', 'replace')).toEqual({
      value: '${x}',
      caret: 4,
    });
  });

  it('clamps a stale selection rather than producing undefined slices', () => {
    // A caret recorded before a re-seed can outrun the current value.
    expect(applyInsert('ab', 99, 99, 'X', 'insert')).toEqual({ value: 'abX', caret: 3 });
    expect(applyInsert('ab', -5, -5, 'X', 'insert')).toEqual({ value: 'Xab', caret: 1 });
    // An inverted range reads as a plain caret at `start`, never a reversed slice.
    expect(applyInsert('abcd', 3, 1, 'X', 'insert')).toEqual({ value: 'abcXd', caret: 4 });
  });
});

/**
 * The mode probe is wired to the REAL validator here, not a stub: its whole
 * claim is that it agrees with `validateDoc`'s per-activity whole-value gates
 * without restating them, and only the real function can show that.
 */
function issuesWithField(node: Node, field: string) {
  return (value: string) =>
    validateCanvas([{ ...node, config: { ...node.config, [field]: value } }], [], [], []);
}

describe('insertModeFor', () => {
  it('says REPLACE for a whole-value field (an if-condition)', () => {
    const node: Node = { id: 'gate', type: 'if', config: {}, position: { x: 0, y: 0 } };
    expect(insertModeFor(issuesWithField(node, 'condition'))).toBe('replace');
  });

  it('says INSERT for an ordinary interpolated field (an http_request url)', () => {
    const node: Node = {
      id: 'call',
      type: 'http_request',
      config: { method: 'GET', url: 'https://example.test' },
      position: { x: 0, y: 0 },
    };
    expect(insertModeFor(issuesWithField(node, 'url'))).toBe('insert');
  });

  it('says REPLACE for a filter items field, which must resolve to an array', () => {
    const node: Node = {
      id: 'pick',
      type: 'filter',
      config: { predicate: '${item}' },
      position: { x: 0, y: 0 },
    };
    expect(insertModeFor(issuesWithField(node, 'items'))).toBe('replace');
  });

  it('is not fooled by a field whose complaints are the SAME in both shapes', () => {
    // A node type with no per-activity validator raises nothing either way, so
    // the difference is empty and the field reads as interpolated. This is the
    // case a count-based comparison would get right by luck and a set-based one
    // gets right by construction.
    const node: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };
    expect(insertModeFor(issuesWithField(node, 'task'))).toBe('insert');
  });
});
