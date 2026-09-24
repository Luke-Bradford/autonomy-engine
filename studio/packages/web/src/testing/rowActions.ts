/**
 * #1253 — a list row's Edit button. Every row action names its row
 * (`Edit <name>`), so a bare `'Edit'` matches nothing; this matches any row's
 * Edit and never a form's own "Edit as JSON" / "Edit as fields" toggle —
 * excluded by their WHOLE name, so a row named "as …" still matches.
 */
export const ROW_EDIT = /^Edit (?!as (?:JSON|fields)$)/;
