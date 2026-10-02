/**
 * #1413 OR22 — the one line under each form section's title, saying what the
 * section holds. Keyed by form, then section, so every section's copy sits in
 * one place and `sectionHints.test.ts` can hold all of it to the house rule
 * catalog descriptions follow: one sentence, not the title, no two the same.
 *
 * `advanced` is shared: the connection and dataset forms both end in the same
 * section (`OverridableKeysSection`), whose own note says what overriding means.
 * A hint never restates a note already in its section, which a screen reader
 * would otherwise read twice.
 */
export const FORM_SECTION_HINTS = {
  connection: {
    basics: 'What this connection is called, and the kind of system it reaches.',
    connection: 'How to reach the system; the settings follow from the kind chosen above.',
    authentication:
      'The secret this connection uses, if its kind needs one; it is stored encrypted.',
  },
  dataset: {
    basics:
      'What this dataset is called, the connection that stores it, and what kind of data it is.',
    dataset:
      'Which data in that store this dataset reads or writes; the settings follow from its kind.',
    columns: 'The columns this dataset declares, each with its name and type.',
  },
  secret: {
    basics: 'The name a node refers to this secret by.',
    value: 'The value a node is given wherever it names this secret.',
  },
  globalParam: {
    basics: 'The name every pipeline reads this value by, and its type.',
    value: 'The value every pipeline sees, and a note on what it is for.',
  },
  trigger: {
    basics: 'What this trigger is called, and whether it is switched on.',
    pipeline: 'Which pipeline this trigger runs, and which version of it.',
    firing: "What starts this trigger's runs, and the days and hours it may start them in.",
    concurrency: 'What happens when a run is due while an earlier run is still going.',
    parameters: "The values this trigger passes to the pipeline's parameters for each run.",
  },
  node: {
    container: 'Which container this activity runs inside, if any, or a new one to put it in.',
    bindings:
      'The connections and datasets this activity uses, and any settings it overrides on them.',
    activitySettings: 'What this activity does when it runs; the settings follow from its type.',
  },
  advanced: 'Rarely needed: which settings a node using this may override.',
} as const;
