import { z } from 'zod';
import type { DatasetColumn } from '../schemas/dataset.js';
import { checkSinkCoverage } from './copy-automap.js';
import { checkSourceDrift } from './schema-drift.js';

/**
 * #996 M9 (#1185) — does a pinned copy mapping still AGREE with a dataset's
 * DECLARED columns, and which columns say it does not.
 *
 * ADVISORY, and the distinction is the whole of §7. Three schemas exist and must
 * not be conflated: (1) the dataset's declared columns, (2) the node's mapping,
 * (3) the store's actual columns. The dispatch GATE is (2) against (3). This
 * module is (2) against (1), which §7 calls out as "deliberately NOT the gate,
 * because a stale declared schema must never block a copy that would in fact
 * succeed, nor bless one that would fail". Nothing here may refuse anything.
 *
 * It exists because TWO surfaces now answer that question and they must not
 * answer it differently: the M8 authoring panel, live as the author types
 * (`web/.../PipelineCanvas.tsx`), and M9's dataset detail page, after the fact
 * for every pipeline that references the dataset. The panel renders the two
 * primitives directly with its own authoring wording; what it MUST share is the
 * reading of them — which is why {@link projectMappingRows} and
 * {@link splitUnwritten} live here and are called from both, rather than being
 * written out twice and agreeing by coincidence (the drift `copy-automap.ts`
 * names three separate times).
 */

/** The subset of a mapping row this module reads. */
export interface MappingRow {
  readonly sink: string;
  readonly source: string | undefined;
  readonly onError: 'fail' | 'null';
}

export interface ProjectedMapping {
  readonly rows: readonly MappingRow[];
  /**
   * Rows dropped because they claim no sink column. A blank row names nothing
   * yet, so counting it would report a column as written before the author has
   * said which — but a silent drop would let a stored mapping shrink between
   * what is on disk and what is reported. The count is the caller's only
   * evidence they were there.
   */
  readonly unnamed: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project a mapping blob's rows down to what an agreement check reads.
 *
 * Takes `unknown` rows DELIBERATELY. Both callers hold a value that has not been
 * through `CopyMappingSchema`: the panel holds a half-typed draft, and M9 holds
 * `Node.config.mapping` out of an immutable stored version. Re-parsing that with
 * `CopyMappingSchema` is a RECORDED REJECTED alternative (`copy-config.ts` ~:100)
 * — it is `.strict()` with a required `type`, so it refuses far more than the
 * three cross-row rules the #444 write gate actually admitted, and would report
 * a pinned, runnable mapping as broken.
 */
export function projectMappingRows(rows: readonly unknown[]): ProjectedMapping {
  const projected: MappingRow[] = [];
  let unnamed = 0;
  for (const row of rows) {
    // Narrowed rather than cast. `rows` is `unknown[]`, so an element can be a
    // string, a number or an array — none of which are `Record<string, unknown>`
    // — and asserting one unconditionally states something false about every
    // such element. It happens not to MISBEHAVE (property access on a primitive
    // yields `undefined`, so the row falls out as unnamed either way), but the
    // type would stop describing the value, and the next reader of `entry` would
    // be reasoning from a lie. Non-objects become `null` and take the same path.
    const entry: Record<string, unknown> | null = isPlainObject(row) ? row : null;
    const sink = entry === null ? undefined : entry.sink;
    if (typeof sink !== 'string' || sink.length === 0) {
      unnamed += 1;
      continue;
    }
    const source = entry?.source;
    projected.push({
      sink,
      source: typeof source === 'string' && source.length > 0 ? source : undefined,
      // Folded toward `fail`, never toward `null`: `null` is the LOSSY setting
      // (a bad value becomes NULL rather than failing its row), so an
      // unrecognised value must not resolve to it.
      onError: entry?.onError === 'null' ? 'null' : 'fail',
    });
  }
  return { rows: projected, unnamed };
}

export interface UnwrittenSplit {
  /** Declared NOT NULL and written by nothing — the copy cannot succeed. */
  readonly required: readonly DatasetColumn[];
  /** Declared nullable and written by nothing — deliberately left alone. */
  readonly optional: readonly DatasetColumn[];
}

/**
 * Split `SinkCoverage.notWritten` by whether the copy can still run.
 *
 * One line per side, and still a function: "a NOT NULL column nothing writes is
 * a fault, a nullable one is a choice" is the rule that must not drift between
 * the authoring panel and the detail page, and a rule stated in one place cannot.
 */
export function splitUnwritten(notWritten: readonly DatasetColumn[]): UnwrittenSplit {
  return {
    required: notWritten.filter((c) => !c.nullable),
    optional: notWritten.filter((c) => c.nullable),
  };
}

/**
 * Zod rather than a bare interface, and inferred rather than declared twice:
 * this verdict crosses the wire (M9's `GET /api/datasets/:id/references`), so
 * the shape the server computes and the shape the page parses are one
 * declaration by construction.
 */
export const MappingAgreementKindSchema = z.enum([
  'source_missing',
  'source_ambiguous',
  'source_unmapped',
  'sink_undeclared',
  'sink_required_unwritten',
  'sink_optional_unwritten',
  'sink_duplicate_write',
]);
export type MappingAgreementKind = z.infer<typeof MappingAgreementKindSchema>;

/** One finding: a kind, and the columns that raised it. */
export const MappingAgreementNoteSchema = z.object({
  kind: MappingAgreementKindSchema,
  columns: z.array(z.string()),
});
export type MappingAgreementNote = z.infer<typeof MappingAgreementNoteSchema>;

export const MappingAgreementSchema = z.object({
  /** False iff `disagreements` is non-empty. */
  agrees: z.boolean(),
  /** The mapping names, or fails to name, a column such that it no longer fits. */
  disagreements: z.array(MappingAgreementNoteSchema),
  /** Allowed drift, said out loud rather than left silent. */
  informational: z.array(MappingAgreementNoteSchema),
});
export type MappingAgreement = z.infer<typeof MappingAgreementSchema>;

function verdict(
  disagreements: MappingAgreementNote[],
  informational: MappingAgreementNote[],
): MappingAgreement {
  return { agrees: disagreements.length === 0, disagreements, informational };
}

function note(kind: MappingAgreementKind, columns: readonly string[]): MappingAgreementNote[] {
  return columns.length === 0 ? [] : [{ kind, columns: [...columns] }];
}

/**
 * The mapping read against the columns the SOURCE dataset declares.
 *
 * `unmapped` is informational and never a disagreement: §7 row 4 makes additive
 * drift a warning precisely so it cannot break a working pipeline.
 */
export function classifySourceAgreement(
  mapping: readonly Pick<MappingRow, 'source' | 'onError'>[],
  sourceColumns: readonly string[],
): MappingAgreement {
  const drift = checkSourceDrift(mapping, sourceColumns);
  return verdict(
    [...note('source_missing', drift.missing), ...note('source_ambiguous', drift.ambiguous)],
    note('source_unmapped', drift.unmapped),
  );
}

/**
 * The mapping read against the columns the SINK dataset declares.
 *
 * `undeclared` is a disagreement even though a stale declared list may still be
 * writable in the store: it is the advisory form of §7 row 2, whose dispatch
 * verdict is `permanent`. It is reported, not enforced — this surface refuses
 * nothing.
 */
export function classifySinkAgreement(
  mapping: readonly Pick<MappingRow, 'sink'>[],
  sinkColumns: readonly DatasetColumn[],
): MappingAgreement {
  const coverage = checkSinkCoverage(mapping, sinkColumns);
  const unwritten = splitUnwritten(coverage.notWritten);
  return verdict(
    [
      ...note('sink_undeclared', coverage.undeclared),
      ...note(
        'sink_required_unwritten',
        unwritten.required.map((c) => c.name),
      ),
      ...coverage.duplicateWrites.map((pair) => ({
        kind: 'sink_duplicate_write' as const,
        columns: [pair.first, pair.second],
      })),
    ],
    note(
      'sink_optional_unwritten',
      unwritten.optional.map((c) => c.name),
    ),
  );
}
