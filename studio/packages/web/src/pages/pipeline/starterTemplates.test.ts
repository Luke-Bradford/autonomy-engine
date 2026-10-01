import { describe, expect, it } from 'vitest';
import {
  ContainerSchema,
  COPY_ACTIVITY_TYPE,
  EdgeSchema,
  getActivity,
  lowerPipelineNodes,
  StrictNodeSchema,
  type Node,
} from '@autonomy-studio/shared';
import { z } from 'zod';
import { validateCanvas } from './canvasDoc';
import { STARTER_TEMPLATES, type StarterTemplate } from './starterTemplates';

/**
 * What the operator does after inserting a template: bind each activity to a
 * connection of a kind it accepts, bind the Copy's datasets and map a column.
 * Fake ids are enough — the doc validator checks shape and `${}` wiring, not
 * that a connection exists (that is the run's `CONNECTION_MISSING`).
 */
function bound(template: StarterTemplate): Node[] {
  return template.nodes.map((n): Node => {
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

  it('unbound, the CSV template is held only for its dataset — the next step to take', () => {
    const csv = STARTER_TEMPLATES[0]!;
    const errors = validateCanvas(
      lowerPipelineNodes(csv.nodes),
      csv.edges,
      csv.containers,
      [],
      [],
      [],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/datasetParams need datasetIds .* bind a dataset/);
  });

  it.each(STARTER_TEMPLATES.slice(1).map((t) => [t.id, t] as const))(
    '%s: unbound, it already saves — bindings are a run-time requirement',
    (_id, t) => {
      expect(
        validateCanvas(lowerPipelineNodes(t.nodes), t.edges, t.containers, [], [], []),
      ).toEqual([]);
    },
  );
});
