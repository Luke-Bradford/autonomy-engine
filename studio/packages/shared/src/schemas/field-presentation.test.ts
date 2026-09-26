import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  authoredAsExpression,
  isAuthoredAsExpression,
  isSingleLine,
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
