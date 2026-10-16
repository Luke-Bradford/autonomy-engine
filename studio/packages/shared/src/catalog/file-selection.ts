import { z } from 'zod';
import { presented, singleLine } from '../schemas/field-presentation.js';

/**
 * #1600 OR41 C8a — the file-selection fields Copy · Files as-is and Get
 * metadata share (a file-name wildcard and a modified-time window), and the
 * save-time checks on them. One home, so the two activities refuse the same
 * values with the same words. Not in the catalog barrel: only config modules
 * read it.
 */

/** A UTC instant (`2026-10-13T00:00:00Z`). A `${}` is checked at dispatch instead. */
export const instant = (title: string, description: string) =>
  presented(singleLine(z.iso.datetime({ offset: true })).optional(), { title, description });

/** A `${}` value is decided at dispatch, so a save-time rule skips it. */
const literal = (v: unknown): v is string => typeof v === 'string' && !v.includes('${');

/** Why a file-name wildcard is refused at save, or `undefined`. */
export function wildcardIssue(wildcard: unknown): string | undefined {
  return literal(wildcard) && /[/\\]/.test(wildcard)
    ? 'a wildcard matches file names only, so it cannot hold a folder separator'
    : undefined;
}

/** Why a modified window is refused at save (it is empty), or `undefined`. */
export function modifiedWindowIssue(start: unknown, end: unknown): string | undefined {
  return literal(start) && literal(end) && Date.parse(start) >= Date.parse(end)
    ? 'Modified before must be later than Modified from'
    : undefined;
}
