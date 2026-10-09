import { describe, expect, it } from 'vitest';
import { CONTAINER_CONFIG_FIELDS, ContainerKindSchema } from '@autonomy-studio/shared';
import { containerTabs } from './containerTabs';

describe('containerTabs (#1477 OR29)', () => {
  it('puts every field a kind may carry on exactly one tab', () => {
    for (const kind of ContainerKindSchema.options) {
      const placed = containerTabs(kind, CONTAINER_CONFIG_FIELDS[kind]).flatMap((t) => t.fields);
      expect([...placed].sort(), kind).toEqual([...CONTAINER_CONFIG_FIELDS[kind]].sort());
    }
  });

  it('gives a ForEach Items · Concurrency · Settings, as ADF splits it', () => {
    expect(
      containerTabs('foreach', CONTAINER_CONFIG_FIELDS.foreach).map((t) => [t.label, t.fields]),
    ).toEqual([
      ['Items', ['items']],
      ['Concurrency', ['batchCount', 'allowNondeterministicVars']],
      ['Settings', ['join']],
    ]);
  });

  it('gives an Until Condition · Settings, and a Stage only Settings', () => {
    expect(
      containerTabs('loop', CONTAINER_CONFIG_FIELDS.loop).map((t) => [t.label, t.fields]),
    ).toEqual([
      ['Condition', ['exitWhen', 'maxRounds', 'timeout']],
      ['Settings', ['join']],
    ]);
    expect(containerTabs('stage', CONTAINER_CONFIG_FIELDS.stage).map((t) => t.label)).toEqual([
      'Settings',
    ]);
  });

  it('never loses a field the table does not place: it lands on the last tab', () => {
    const tabs = containerTabs('loop', ['exitWhen', 'join', 'someNewField']);
    expect(tabs.at(-1)?.fields).toEqual(['join', 'someNewField']);
  });

  it('drops a tab none of whose fields are shown', () => {
    expect(containerTabs('loop', ['join']).map((t) => t.label)).toEqual(['Settings']);
  });
});
