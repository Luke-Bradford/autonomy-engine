/**
 * #1594 OR40 S3 — `getByLabelText(label, FIELD)` finds the FIELD a label names,
 * not the section that shares the word. A `Section` is a group named by its
 * heading (`aria-labelledby`), so a "Value" section holding a "Value" field
 * gives the label query two matches, as a fieldset's legend never did.
 */
export const FIELD = { selector: 'input, select, textarea' } as const;
