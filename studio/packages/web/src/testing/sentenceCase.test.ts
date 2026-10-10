import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORY_LABELS,
  ACTIVITY_TAB_TITLES,
  catalog,
  CONCURRENCY_POLICY_LABELS,
  CONNECTION_KIND_LABELS,
  CONTAINER_KIND_LABELS,
  DATASET_KIND_LABELS,
  RUN_TRIGGERED_BY_LABELS,
  TRIGGER_MODE_LABELS,
} from '@autonomy-studio/shared';
import { HUBS } from '../shell/hubs';
import { PANE_TITLES } from '../shell/SecondaryPane';
import { APP_TITLE } from '../shell/routeHandle';
import { readCssSource } from './cssSource';
import { sentenceCaseProblem } from './sentenceCase';

/**
 * #1594 OR40 S4 — every name the app shows for a kind of thing is in sentence
 * case: the activity catalog, the nav, the pane titles and the kind labels.
 */
describe('sentenceCaseProblem', () => {
  it.each([
    'Copy data',
    'HTTP request',
    'AI activity',
    'Webhook (external wait)',
    'Delimited text (CSV)',
    'Agent CLI (subscription)',
    'ForEach',
    'Run ID',
    'Copy run IDs',
  ])('accepts %s', (text) => {
    expect(sentenceCaseProblem(text)).toBeNull();
  });

  it.each([
    ['Copy Data', '"Data" should be lower case'],
    ['copy data', '"copy" should start with a capital'],
    ['PARAMS', '"PARAMS" has a capital inside it'],
    ['Webhook (External wait)', '"External" should be lower case'],
  ])('refuses %s', (text, reason) => {
    expect(sentenceCaseProblem(text)).toBe(reason);
  });
});

describe('UI names are sentence case', () => {
  const groups: Record<string, readonly string[]> = {
    'activity titles': [...catalog.values()].map((e) => e.title),
    'activity tab titles': Object.values(ACTIVITY_TAB_TITLES),
    'activity categories': Object.values(ACTIVITY_CATEGORY_LABELS),
    'container kinds': Object.values(CONTAINER_KIND_LABELS),
    'connection kinds': Object.values(CONNECTION_KIND_LABELS),
    'dataset kinds': Object.values(DATASET_KIND_LABELS),
    'trigger modes': Object.values(TRIGGER_MODE_LABELS),
    'concurrency policies': Object.values(CONCURRENCY_POLICY_LABELS),
    'run triggered-by labels': Object.values(RUN_TRIGGERED_BY_LABELS),
    'hubs and their sections': HUBS.flatMap((h) => [h.label, ...h.sections.map((s) => s.label)]),
    'pane titles': Object.values(PANE_TITLES),
    'app title': [APP_TITLE],
  };

  it.each(Object.entries(groups))('%s', (_group, names) => {
    expect(names.length).toBeGreaterThan(0);
    const problems = names
      .map((n) => [n, sentenceCaseProblem(n)] as const)
      .filter(([, p]) => p !== null);
    expect(problems).toEqual([]);
  });
});

describe('no stylesheet capitalises text', () => {
  const src = join(import.meta.dirname, '..');
  const sheets = ['index.css', ...readdirSync(join(src, 'theme')).map((f) => `theme/${f}`)].filter(
    (f) => f.endsWith('.css'),
  );

  it.each(sheets)('%s sets no capitalising text-transform', (sheet) => {
    expect(readCssSource(join(src, sheet))).not.toMatch(
      /text-transform\s*:\s*(uppercase|capitalize)|font-variant[\w-]*\s*:[^;]*caps/i,
    );
  });
});
