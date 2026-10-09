/**
 * #1413 OR22 — the one line behind each section's `?` (#1594 OR40 `Section`),
 * saying what the section holds. Keyed by form or surface, then section, so
 * every section's copy sits in one place and `sectionHints.test.ts` can hold all
 * of it to the house rule catalog descriptions follow: one sentence, not the
 * title, no two the same.
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
    annotations: 'Tags that describe this connection, such as an environment, a team or a system.',
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
    // The field's own note too (#1594 OR40 S3c-2): the section holds the one
    // field, so a second `?` would repeat the section's name, "About Value".
    value:
      'The value a node is given wherever it names this secret; once saved it can be replaced but never read back.',
  },
  globalParam: {
    basics: 'The name every pipeline reads this value by, and its type.',
    // The Value field's note too, for the reason the secret's gives.
    value:
      'The value every pipeline sees, which is cleartext and so never a credential, and a description of what it is for.',
  },
  trigger: {
    basics: 'What this trigger is called, and whether it is switched on.',
    pipeline: 'Which pipeline this trigger runs, and which version of it.',
    firing: "What starts this trigger's runs, and the days and hours it may start them in.",
    concurrency: 'What happens when a run is due while an earlier run is still going.',
    parameters: "The values this trigger passes to the pipeline's parameters for each run.",
  },
  node: {
    runPolicy:
      'How this activity retries a transient failure, and what of it is kept out of the run log.',
  },
  pipeline: {
    basics: 'What the pipeline is called, the folder it is filed under, and what it is for.',
    importFile:
      'A pipeline, connection, trigger, dataset or global parameter export; what it needs rebound is listed after.',
    demo: 'Five sample pipelines in folder “Demo” with their own connections and datasets, ready to run.',
    general: 'A short account of what this pipeline does and why it exists.',
    duplicate:
      'Which saved version the copy starts from; any but Latest is recorded on the copy as an annotation.',
    annotations:
      'Tags that describe this pipeline, such as an environment, a team or a data domain.',
  },
  call: {
    target:
      'Which pipeline version this activity runs as a child run, and whether it waits for it to finish.',
    parameters: "The values this activity passes to the child pipeline's parameters.",
  },
  monitor: {
    quota: "Each connected AI provider's subscription windows, read only when you ask.",
    reported:
      "Runs that agents studio did not launch reported to it, kept apart from studio's own figures.",
  },
  run: {
    diagnostics: 'What the pipeline asked for that did not take effect on this run, and why.',
    streamedOutput: 'How many output events this activity streamed, and the last one it sent.',
    failure: 'The error this activity run ended with, and what kind of failure it was.',
    childRuns: 'The child runs this activity started, each linked to its own run.',
    dataMovement:
      "Where this activity's data went, as resolved when it ran; a dataset edited since may point elsewhere.",
    cost: 'The tokens this activity used and what they cost.',
    input:
      'The configuration and parameters this activity ran with, after expressions were resolved.',
    variableWrite: 'The pipeline variable this activity set, and the value it wrote.',
    outputs: 'The values this activity returned, which later activities read as its outputs.',
    toolCalls:
      'The tools the model called during this activity, with what each was given and returned.',
  },
  advanced: 'Rarely needed: which settings a node using this may override.',
} as const;
