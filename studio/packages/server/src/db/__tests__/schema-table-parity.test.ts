import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  ConnectionSchema,
  PipelineSchema,
  PipelineVersionSchema,
  RunDiagnosticSchema,
  RunSchema,
  TriggerSchema,
} from '@autonomy-studio/shared';
import type { z } from 'zod';
import {
  connections,
  pipelines,
  pipelineVersions,
  runDiagnostics,
  runs,
  triggers,
} from '../schema.js';

/**
 * THE #473 CLASS TEST — a persisted field must have somewhere to persist TO.
 *
 * #473 was not a logic bug: `containers` was added to `PipelineVersionSchema`
 * and to every validator, route and type, but never to the drizzle table (full
 * account in the 0006 migration). Nothing in TypeScript, Zod, lint or the
 * existing suite could see it, because both sides were internally consistent;
 * only the SEAM between them was wrong.
 *
 * So this asserts the seam directly: every key of the resource's Zod schema has
 * a column on the resource's table. It fails RED on the pre-fix schema
 * (`missing: ['containers']`), which is what makes it a regression test rather
 * than a decoration.
 *
 * Direction is deliberately ONE-WAY (schema key ⇒ column, not the converse): a
 * table may legitimately carry columns no resource schema exposes — internal
 * bookkeeping like a lease or a claim stamp. The reverse — a schema field with
 * no column — is always the #473 defect, because the field is, by definition,
 * meant to survive a round-trip.
 *
 * WHAT THIS DOES NOT COVER — it guards the schema⇔table seam, which was #473's
 * first loss point, and NOT the second: a hand-written builder that forgets to
 * copy a field (as `importPipelineEnvelope` forgot `containers`). No parity
 * check can see that; only a round-trip test on the field itself can.
 *
 * `CASES` is itself a hand-list, which is the very failure mode this file
 * argues against — a sixth resource table added later is silently unchecked
 * until someone adds it here. It stays hand-written because the alternative
 * (deriving the set) needs a schema→table mapping that exists nowhere else and
 * would be its own hand-list; the honest mitigation is this paragraph.
 *
 * Also not covered: infra tables with no resource schema (`scheduled_wakeups`,
 * `webhook_deliveries`, `run_events`), whose row shape IS driver-internal and
 * has no 1:1 Zod counterpart by design.
 */
const CASES: { name: string; table: Parameters<typeof getTableColumns>[0]; schema: z.ZodObject }[] =
  [
    { name: 'pipelines', table: pipelines, schema: PipelineSchema },
    { name: 'pipeline_versions', table: pipelineVersions, schema: PipelineVersionSchema },
    { name: 'triggers', table: triggers, schema: TriggerSchema },
    { name: 'connections', table: connections, schema: ConnectionSchema },
    { name: 'runs', table: runs, schema: RunSchema },
    // #497. Infra-ish (driver-written, never client-authored) but it CROSSES the
    // API boundary with a 1:1 Zod counterpart — `GET /api/runs/:id/diagnostics`
    // returns exactly this shape — so unlike `run_events` it earns the guard.
    { name: 'run_diagnostics', table: runDiagnostics, schema: RunDiagnosticSchema },
  ];

describe('drizzle table ⇔ Zod schema parity (#473)', () => {
  for (const { name, table, schema } of CASES) {
    it(`${name}: every schema field has a column to persist to`, () => {
      const columns = Object.keys(getTableColumns(table));
      const missing = Object.keys(schema.shape).filter((key) => !columns.includes(key));
      expect(missing).toEqual([]);
    });
  }
});
