import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authoredAsExpression,
  fieldLabelOf,
  isAuthoredAsExpression,
  isSingleLine,
  presented,
  singleLine,
} from './field-presentation.js';

describe('field presentation tags (#864 item 4)', () => {
  it('keeps a fact a schema already carries when a second one is added', () => {
    const both = authoredAsExpression(singleLine(z.string()));
    expect(isSingleLine(both)).toBe(true);
    expect(isAuthoredAsExpression(both)).toBe(true);
  });

  it('merges onto an INHERITED entry without writing it back to the parent', () => {
    const parent = singleLine(z.string());
    const clone = authoredAsExpression(parent.min(1));
    expect(isSingleLine(clone)).toBe(true);
    expect(isAuthoredAsExpression(clone)).toBe(true);
    expect(isAuthoredAsExpression(parent)).toBe(false);
  });
});

describe('human field labels (#1396)', () => {
  it('reads a title, description and unit back from the tagged schema', () => {
    const field = presented(z.number().optional(), {
      title: 'Timeout',
      description: 'How long one request may take.',
      unit: 'ms',
    });
    expect(fieldLabelOf(field)).toEqual({
      title: 'Timeout',
      description: 'How long one request may take.',
      unit: 'ms',
    });
  });

  it('keeps a fact the schema already carried', () => {
    const field = presented(singleLine(z.string()), { title: 'Host' });
    expect(isSingleLine(field)).toBe(true);
    expect(fieldLabelOf(field)).toEqual({ title: 'Host' });
  });

  it('says nothing for an untitled schema', () => {
    expect(fieldLabelOf(singleLine(z.string()))).toBeUndefined();
    expect(fieldLabelOf(z.string())).toBeUndefined();
  });
});
