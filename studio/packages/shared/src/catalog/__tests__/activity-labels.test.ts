import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CONTAINER_CONFIG_FIELD_NAMES, validateDoc, validateRefs } from '../../engine/params.js';
import { fieldLabelThrough, unnamedEnumValues } from '../../schemas/field-presentation.js';
import { ContainerSchema } from '../../schemas/pipeline.js';
import { catalog, isStructuralCallActivity } from '../registry.js';

/**
 * #1396 — the node panel labels a config field by its human title, the way the
 * connection and dataset forms do. These pin that no field reaches the panel
 * showing only its camelCase key.
 */

// Every activity the generic config form renders. A structural call is authored
// by its own panel from `Node.call`, never from `configSchema`.
const FORM_ACTIVITIES = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));

const shapeOf = (schema: unknown): Record<string, z.ZodType> =>
  (schema as { shape: Record<string, z.ZodType> }).shape;

describe('activity config labels (#1396)', () => {
  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    'every %s config field has a title',
    (_type, entry) => {
      const untitled = Object.entries(shapeOf(entry.configSchema))
        .filter(([, field]) => fieldLabelThrough(field) === undefined)
        .map(([name]) => name);
      expect(untitled).toEqual([]);
    },
  );

  // A label lookup is a case-insensitive substring match, in Playwright and in
  // assistive tech's "find", so one title inside another makes two controls
  // answer to it. The rendered panel's other labels are pinned in the web suite.
  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    'no %s title contains another',
    (_type, entry) => {
      const titles = Object.values(shapeOf(entry.configSchema)).map(
        (field) => fieldLabelThrough(field)?.title.toLowerCase() ?? '',
      );
      const clashes = titles.flatMap((a, i) =>
        titles.filter((b, j) => i !== j && b.includes(a)).map((b) => `${a} ⊂ ${b}`),
      );
      expect(clashes).toEqual([]);
    },
  );

  // The select shows the name; the stored value stays the enum value.
  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    'every %s enum value has a display name',
    (_type, entry) => {
      expect(unnamedEnumValues(shapeOf(entry.configSchema))).toEqual([]);
    },
  );

  it('every container setting has a title', () => {
    const shape = shapeOf(ContainerSchema);
    expect(CONTAINER_CONFIG_FIELD_NAMES.filter((n) => !fieldLabelThrough(shape[n]))).toEqual([]);
  });

  // The hint's example is what an operator copies, and a bare `30` is refused,
  // so the example must be a duration the save gate accepts.
  it.each([
    ['wait', 'seconds'],
    ['webhook', 'timeoutSeconds'],
  ] as const)('the %s duration example passes the save gate', (type, key) => {
    const field = shapeOf(catalog.get(type)?.configSchema)[key];
    const example = /e\.g\. (\S+?)\.$/.exec(fieldLabelThrough(field)?.description ?? '')?.[1];
    expect(example).toBeDefined();
    const doc = {
      params: [],
      edges: [],
      containers: [],
      variables: [],
      nodes: [{ id: 'n', type, config: { [key]: example }, position: { x: 0, y: 0 } }],
    };
    expect([...validateDoc(doc), ...validateRefs(doc)]).toEqual([]);
  });
});
