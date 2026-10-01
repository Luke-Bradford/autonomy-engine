import { describe, expect, it } from 'vitest';
import { expectOneSentence } from '../__tests__/helpers/description.js';
import { CONNECTION_KIND_DESCRIPTIONS, CONNECTION_KIND_LABELS } from '../schemas/connection.js';
import { DATASET_KIND_DESCRIPTIONS, DATASET_KIND_LABELS } from '../schemas/dataset.js';
import { TRIGGER_MODE_DESCRIPTIONS, TRIGGER_MODE_LABELS } from '../schemas/trigger.js';

// #1413 OR22 — a connection kind, dataset kind and trigger mode each say what
// they are, under the form's Kind/Mode picker. The `Record` makes a MISSING
// description a compile error; this pins the house rule activities follow
// (registry.test.ts): one sentence, not a restated name, no copy-pasted twin.
const maps: [string, Record<string, string>, Record<string, string>][] = [
  ['connection kinds', CONNECTION_KIND_DESCRIPTIONS, CONNECTION_KIND_LABELS],
  ['dataset kinds', DATASET_KIND_DESCRIPTIONS, DATASET_KIND_LABELS],
  ['trigger modes', TRIGGER_MODE_DESCRIPTIONS, TRIGGER_MODE_LABELS],
];

describe.each(maps)('%s descriptions (#1413)', (_name, descriptions, labels) => {
  const entries = Object.entries(descriptions);

  it.each(entries)('%s has a one-sentence description', (kind, description) => {
    expect(description.toLowerCase()).not.toBe(labels[kind]?.toLowerCase());
    expectOneSentence(description);
  });

  it('no two share a description', () => {
    expect(new Set(entries.map(([, d]) => d)).size).toBe(entries.length);
  });
});
