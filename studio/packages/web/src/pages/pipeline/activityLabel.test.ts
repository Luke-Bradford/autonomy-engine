import { describe, expect, it } from 'vitest';
import type { Node } from '@autonomy-studio/shared';
import { activityLabel, activityLabels } from './activityLabel';

const node = (id: string, type: string): Node => ({
  id,
  type,
  config: {},
  position: { x: 0, y: 0 },
});

describe('activityLabel', () => {
  it('names an activity by its catalog title', () => {
    expect(activityLabel(node('n_a', 'http_request'))).toBe('HTTP Request');
  });

  it('falls back to the raw type the catalog does not know', () => {
    expect(activityLabel(node('n_a', 'not_in_catalog'))).toBe('not_in_catalog');
  });
});

describe('activityLabels', () => {
  it('numbers a lone activity, exactly as containerLabels numbers a lone container', () => {
    // The ordinal is UNCONDITIONAL. Suppressing it for a lone activity would
    // rename an untouched box the moment a second one of its type is added, and
    // would print two numbering schemes in one sentence — the #788 advisory's
    // partitioned arm lists nodes and containers together ("stage 1" is always
    // numbered), so "HTTP Request, stage 1" would read as two different kinds of
    // thing.
    expect([...activityLabels([node('n_a', 'http_request')])]).toEqual([['n_a', 'HTTP Request 1']]);
  });

  it('numbers same-named activities in document order', () => {
    const labels = activityLabels([
      node('n_a', 'http_request'),
      node('n_b', 'llm_call'),
      node('n_c', 'http_request'),
    ]);
    expect(labels.get('n_a')).toBe('HTTP Request 1');
    expect(labels.get('n_c')).toBe('HTTP Request 2');
    // A different name counts independently — it is not a doc-wide running total.
    expect(labels.get('n_b')).toBe('LLM Call 1');
  });

  it('numbers a type the catalog does not know by the raw type it falls back to', () => {
    const labels = activityLabels([node('n_a', 'not_in_catalog'), node('n_b', 'not_in_catalog')]);
    expect(labels.get('n_a')).toBe('not_in_catalog 1');
    expect(labels.get('n_b')).toBe('not_in_catalog 2');
  });

  it('counts by the RENDERED NAME, not by the type, so two types cannot collide into one name', () => {
    // The ordinal exists to make the name unique, so it must be minted against
    // the string the operator actually reads. Keying it on `type` would let an
    // imported activity whose raw type happens to equal another activity's
    // catalog title produce two identical labels — the exact defect this
    // function exists to remove, and the uniqueness `useExpressionPicker`'s
    // deleted `(id)` suffix used to buy by counting rendered titles.
    const labels = activityLabels([node('n_a', 'http_request'), node('n_b', 'HTTP Request')]);
    expect(labels.get('n_a')).toBe('HTTP Request 1');
    expect(labels.get('n_b')).toBe('HTTP Request 2');
    expect(new Set(labels.values()).size).toBe(2);
  });

  it('has an entry for every node and no others', () => {
    const nodes = [node('n_a', 'http_request'), node('n_b', 'llm_call')];
    expect([...activityLabels(nodes).keys()]).toEqual(['n_a', 'n_b']);
    expect(activityLabels([]).size).toBe(0);
  });
});
