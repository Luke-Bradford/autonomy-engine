import { describe, expect, it } from 'vitest';
import {
  ContainerSchema,
  COPY_ACTIVITY_TYPE,
  EdgeSchema,
  FILE_LIST_ACTIVITY_TYPE,
  HTTP_REQUEST_ACTIVITY_TYPE,
  getActivity,
  lowerPipelineNodes,
  StrictNodeSchema,
  type Node,
} from '@autonomy-studio/shared';
import { z } from 'zod';
import { validateCanvas } from './canvasDoc';
import { STARTER_TEMPLATES, type StarterTemplate } from './starterTemplates';

/**
 * #1480 — the literals a template leaves to the operator's own workspace (a
 * folder, a URL). The save gate checks a literal config against the schema the
 * adapter parses, so a template node is held until its required field is filled.
 */
const OPERATOR_FIELDS: Readonly<Record<string, Record<string, unknown>>> = {
  [FILE_LIST_ACTIVITY_TYPE]: { path: 'inbox' },
  [HTTP_REQUEST_ACTIVITY_TYPE]: { url: 'https://example.test/status' },
};

/**
 * What the operator does after inserting a template: fill the folder or URL,
 * bind each activity to a connection of a kind it accepts, bind the Copy's
 * datasets and map a column.
 * Fake ids are enough — the doc validator checks shape and `${}` wiring, not
 * that a connection exists (that is the run's `CONNECTION_MISSING`).
 */
function bound(template: StarterTemplate): Node[] {
  return template.nodes.map((filled): Node => {
    const n = { ...filled, config: { ...filled.config, ...OPERATOR_FIELDS[filled.type] } };
    if (n.type === COPY_ACTIVITY_TYPE) {
      return {
        ...n,
        connectionIds: { source: 'conn_fs', sink: 'conn_db' },
        datasetIds: { source: 'ds_csv', sink: 'ds_table' },
        config: { ...n.config, mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
      };
    }
    const kinds = getActivity(n.type)?.connectionKinds ?? [];
    return kinds.length === 0 ? n : { ...n, connectionId: `conn_${kinds[0]}` };
  });
}

describe('STARTER_TEMPLATES (#1413 OR22, #1420 part 4)', () => {
  it('offers the three starters, the CSV-folder recipe first', () => {
    expect(STARTER_TEMPLATES.map((t) => t.id)).toEqual([
      'csv-folder-to-table',
      'summarise-folder',
      'call-api-check',
    ]);
  });

  it('titles and descriptions are unique, and each description is one sentence', () => {
    const titles = STARTER_TEMPLATES.map((t) => t.title);
    const descriptions = STARTER_TEMPLATES.map((t) => t.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const t of STARTER_TEMPLATES) {
      expect(t.title.trim()).not.toBe('');
      expect(t.description, t.id).toMatch(/^[^.!?]+\.$/);
    }
  });

  it.each(STARTER_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s: every activity is catalogued and the doc parses through the write schemas',
    (_id, t) => {
      for (const n of t.nodes) expect(getActivity(n.type), n.type).toBeDefined();
      expect(() => z.array(StrictNodeSchema).parse(lowerPipelineNodes(bound(t)))).not.toThrow();
      expect(() => z.array(EdgeSchema).parse(t.edges)).not.toThrow();
      expect(() => z.array(ContainerSchema).parse(t.containers)).not.toThrow();
    },
  );

  it.each(STARTER_TEMPLATES.map((t) => [t.id, t] as const))(
    '%s: once bound, the save gate accepts it — every ${} reference resolves',
    (_id, t) => {
      expect(
        validateCanvas(lowerPipelineNodes(bound(t)), t.edges, t.containers, [], [], []),
      ).toEqual([]);
    },
  );

  it('unbound, the CSV template is held for exactly what the operator binds: folder, mapping, dataset', () => {
    // #1480 — the save gate checks each literal config against the schema the
    // adapter parses, so a required field the template leaves out is the next
    // step in Problems, beside the dataset the per-item path needs.
    const csv = STARTER_TEMPLATES[0]!;
    const errors = validateCanvas(
      lowerPipelineNodes(csv.nodes),
      csv.edges,
      csv.containers,
      [],
      [],
      [],
    );
    expect(errors).toEqual([
      expect.stringMatching(/^node 'list': config\.path: /),
      expect.stringMatching(/^node 'load': config\.mapping: /),
      expect.stringMatching(/datasetParams need datasetIds .* bind a dataset/),
    ]);
  });

  it.each([
    ['summarise-folder', /^node 'list': config\.path: /],
    ['call-api-check', /^node 'call': config\.url: /],
  ] as const)(
    '%s: unbound, it is held only for the folder or URL it leaves to the operator',
    (id, field) => {
      // #1480 — before the gate checked config a template saved without these
      // and failed at its first run; now Problems names the field to fill.
      const t = STARTER_TEMPLATES.find((x) => x.id === id)!;
      expect(
        validateCanvas(lowerPipelineNodes(t.nodes), t.edges, t.containers, [], [], []),
      ).toEqual([expect.stringMatching(field)]);
    },
  );
});
