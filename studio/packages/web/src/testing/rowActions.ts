/**
 * #1253 — a list row's Edit button. Every row action names its row
 * (`Edit <name>`), so a bare `'Edit'` matches nothing; this matches any row's
 * Edit and never a form's own "Edit as JSON" / "Edit as fields" toggle.
 */
export const ROW_EDIT = /^Edit (?!as )/;
