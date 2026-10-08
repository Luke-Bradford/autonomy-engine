import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { catalog, isStructuralCallActivity } from '../registry.js';
import { ACTIVITY_TAB_KEYS, applicableBindingSlots } from '../types.js';

/**
 * #1477 OR29 — each activity's property-dock tabs are declared in its catalog
 * entry. A hand-kept field list beside a schema drifts (the U7 objection to
 * per-type form metadata), so these pin the declaration TO the schema: every
 * config key on exactly one tab, nothing else, and every binding the entry has
 * placed exactly once.
 */

// The generic panel's activities. A structural call is authored by `CallPanel`
// from `Node.call`, so it declares no tabs.
const FORM_ACTIVITIES = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));

const shapeOf = (schema: unknown): Record<string, z.ZodType> =>
  (schema as { shape: Record<string, z.ZodType> }).shape;

describe('activity tabs (#1477)', () => {
  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    '%s declares its tabs',
    (_type, entry) => {
      expect(entry.tabs).toBeDefined();
    },
  );

  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    '%s puts every config key on exactly one tab, and nothing else',
    (_type, entry) => {
      const listed = (entry.tabs ?? []).flatMap((t) => t.fields);
      expect([...listed].sort()).toEqual(Object.keys(shapeOf(entry.configSchema)).sort());
    },
  );

  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    '%s places every binding it has exactly once, and no other',
    (_type, entry) => {
      const placed = (entry.tabs ?? []).flatMap((t) => t.bindings ?? []);
      expect([...placed].sort()).toEqual(applicableBindingSlots(entry).sort());
    },
  );

  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    '%s names each tab once, in the vocabulary order, and leaves none empty',
    (_type, entry) => {
      const tabs = entry.tabs ?? [];
      const order = tabs.map((t) => ACTIVITY_TAB_KEYS.indexOf(t.key));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size).toBe(order.length);
      for (const tab of tabs) {
        expect(tab.fields.length + (tab.bindings?.length ?? 0)).toBeGreaterThan(0);
      }
    },
  );

  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    '%s lists a tab’s required fields before its optional ones',
    (_type, entry) => {
      const shape = shapeOf(entry.configSchema);
      for (const tab of entry.tabs ?? []) {
        const optional = tab.fields.map((name) => shape[name]?.isOptional() ?? false);
        expect(optional).toEqual([...optional].sort((a, b) => Number(a) - Number(b)));
      }
    },
  );

  it('a structural call declares none', () => {
    const calls = [...catalog.values()].filter((e) => isStructuralCallActivity(e.type));
    expect(calls.length).toBeGreaterThan(0);
    for (const entry of calls) expect(entry.tabs).toBeUndefined();
  });
});

describe('applicableBindingSlots (#1477)', () => {
  it('reads a single, a paired and a dataset-bound entry', () => {
    expect(applicableBindingSlots({ connectionKinds: [] })).toEqual([]);
    expect(applicableBindingSlots({ connectionKinds: ['http'] })).toEqual(['connection']);
    expect(
      applicableBindingSlots({
        connectionKinds: ['sqlite'],
        sinkConnectionKinds: ['sqlite'],
        datasetKinds: { source: ['table'], sink: ['table'] },
      }),
    ).toEqual(['sourceConnection', 'sinkConnection', 'sourceDataset', 'sinkDataset']);
    expect(
      applicableBindingSlots({ connectionKinds: ['sqlite'], datasetKinds: { source: ['table'] } }),
    ).toEqual(['connection', 'sourceDataset']);
  });
});
