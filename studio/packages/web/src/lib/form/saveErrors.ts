import type { z } from 'zod';
import { formatZodIssues } from '@autonomy-studio/shared';
import { apiIssuesOf, formatApiIssues, messageOf } from '../../api/client';
import { splitIssues, type FieldValidation } from './fieldValidation';

/**
 * #1396 — a write schema's refusal before sending: issues that name one of the
 * form's fields are shown beside it; the rest come back as the one line for the
 * form's message, or `null` when every issue found its field.
 */
export function schemaRefusal(
  issues: readonly z.core.$ZodIssue[],
  validation: FieldValidation,
): string | null {
  const { fields, rest } = splitIssues(issues, validation.isKey);
  validation.showRefusedFields(fields);
  return rest.length === 0 ? null : formatZodIssues(rest);
}

/**
 * #1396 — a failed save, the same way: a 400's per-field issues go beside their
 * fields, and the message is what is left (the issues no field owns, the
 * "…and N more" a capped list carries) or the error's own message.
 */
export function saveRefusal(err: unknown, validation: FieldValidation): string | null {
  const refused = apiIssuesOf(err);
  if (refused === null) return messageOf(err);
  const { fields, rest } = splitIssues(refused.issues, validation.isKey);
  validation.showRefusedFields(fields);
  const line = formatApiIssues(rest, refused.body);
  return line === '' ? null : line;
}

/**
 * #1438 — a failed save, said in full for a page whose form has gone: the
 * record's name and every reason, since there are no fields left to put the
 * per-field issues beside. `detail` is the form's own sentence where it has
 * one (a name conflict), else the error.
 */
export function couldNotSave(name: string, detail: unknown): string {
  const reason = typeof detail === 'string' ? detail : messageOf(detail);
  return name.trim() === '' ? `Could not save: ${reason}` : `Could not save “${name}”: ${reason}`;
}
