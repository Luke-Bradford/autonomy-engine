import { describe, expect, it } from 'vitest';
import { CopyMappingSchema, copyDispatchInputSchema, copyInputSchema } from './copy-config.js';
import { formatZodIssues } from '../schemas/zod-issues.js';

/**
 * #996 M5 slice 1 (#1122) — the `copy` mapping declaration (§6.1).
 *
 * The XOR and duplicate-sink tests assert the issue PATH, not merely that
 * parsing failed: §6.1 asks for a `superRefine` with a per-element path so an
 * issue "names its row rather than the whole array", and a bare
 * `success === false` assertion passes for an array-level refine that names
 * nothing — i.e. it would certify the one property being claimed without
 * testing it. Each case puts a VALID row at index 0 so the reported index is
 * load-bearing.
 */

const validRow = { source: 'a', sink: 'a_out', type: 'string' as const };

describe('CopyMappingSchema — source XOR expression (§6.1)', () => {
  it('accepts either arm, and defaults onError to fail', () => {
    const parsed = CopyMappingSchema.parse([
      { source: 'id', sink: 'id', type: 'integer' },
      { expression: '${params.batch}', sink: 'batch', type: 'string', onError: 'null' },
    ]);
    expect(parsed[0]).toEqual({ source: 'id', sink: 'id', type: 'integer', onError: 'fail' });
    expect(parsed[1]?.onError).toBe('null');
  });

  it('refuses BOTH arms, naming the offending row', () => {
    const r = CopyMappingSchema.safeParse([
      validRow,
      { source: 'b', expression: '${x}', sink: 'b_out', type: 'string' },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'expression']);
  });

  it('refuses NEITHER arm, naming the offending row', () => {
    const r = CopyMappingSchema.safeParse([validRow, { sink: 'b_out', type: 'string' }]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'source']);
  });
});

describe('CopyMappingSchema — one sink column, one writer', () => {
  it('refuses two rows writing the same sink, naming the SECOND', () => {
    // Silent last-wins into the operator's store: perfectly valid SQL, and
    // nothing downstream reports it.
    const r = CopyMappingSchema.safeParse([
      validRow,
      { source: 'b', sink: 'a_out', type: 'string' },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, 'sink']);
    expect(r.error?.issues[0]?.message).toContain('a_out');
  });

  it('distinct sinks from the same source column are fine', () => {
    expect(
      CopyMappingSchema.safeParse([
        { source: 'a', sink: 'x', type: 'string' },
        { source: 'a', sink: 'y', type: 'string' },
      ]).success,
    ).toBe(true);
  });
});

describe('CopyMappingSchema — the declared shape', () => {
  it('the target type is drawn from the CLOSED DataType set', () => {
    const r = CopyMappingSchema.safeParse([{ source: 'a', sink: 'a', type: 'money' }]);
    expect(r.success).toBe(false);
    // A type with no §6.2 matrix row would be a silent corruption path.
    expect(r.error?.issues[0]?.path).toEqual([0, 'type']);
  });

  it('is strict — an unknown key is refused rather than dropped', () => {
    const r = CopyMappingSchema.safeParse([{ ...validRow, transfrom: 'upper' }]);
    expect(r.success).toBe(false);
  });

  it('refuses an empty sink or source name', () => {
    expect(CopyMappingSchema.safeParse([{ source: 'a', sink: '', type: 'string' }]).success).toBe(
      false,
    );
    expect(CopyMappingSchema.safeParse([{ source: '', sink: 'a', type: 'string' }]).success).toBe(
      false,
    );
  });

  // INVERTED by #1172. This test previously read "an empty mapping parses — it
  // is the pump that decides what to do with one", recording the decision this
  // one reverses: the pump's refusal fires at DISPATCH, so a zero-row mapping
  // could be saved into an immutable version and only fail hours later on a
  // schedule. The pump's guard STAYS (`datamove/pump.ts`) — `shared` is reached
  // by callers that never ran this schema — so the two are layers, not rivals.
  it('refuses an empty mapping, so a copy that moves nothing is refused where it is authored', () => {
    const refused = CopyMappingSchema.safeParse([]);
    expect(refused.success).toBe(false);
    expect(formatZodIssues(refused.error!.issues)).toContain('a copy maps no columns');
  });

  it('reports the empty-mapping refusal against `mapping`, the control an author can see', () => {
    // The issue is raised with `path: []` because an empty array has no row to
    // name. Nested under `copyInputSchema` that emerges as `['mapping']`, which
    // is what the property panel renders — the concern `dataset-config.ts`'s
    // own object-level `superRefine` documents (an unprefixed message tells an
    // operator two things clash without telling them which control to touch).
    // Only `mapping` and `mode` — `copyInputShape` declares nothing else. A
    // copy's source and sink are dataset/connection BINDINGS on the node, not
    // config fields, and seeding them here would suggest this schema checks
    // them.
    const refused = copyInputSchema.safeParse({ mapping: [] });
    expect(refused.success).toBe(false);
    expect(formatZodIssues(refused.error!.issues)).toContain('mapping: a copy maps no columns');
  });

  it('still accepts a one-row mapping — the refusal is of ZERO rows, not of small ones', () => {
    expect(
      CopyMappingSchema.safeParse([{ source: 'a', sink: 'id', type: 'integer' }]).success,
    ).toBe(true);
  });
});

describe('copyDispatchInputSchema — the DISPATCH variant (#1134 M5 slice 4b)', () => {
  const row = { source: 'a', sink: 'id', type: 'integer' as const };

  it('refuses an empty mapping too — the rule is about the ARRAY, not about `expression`', () => {
    // `refineMapping` is shared by both shapes precisely so they cannot
    // disagree about a rule that never mentions `expression`. Were this on the
    // authored schema alone, a version minted before #1172 would still reach
    // the pump, and `connectors/copy.ts` would report the fault a rung later.
    const refused = copyDispatchInputSchema.safeParse({ mapping: [] });
    expect(refused.success).toBe(false);
    expect(formatZodIssues(refused.error!.issues)).toContain('mapping: a copy maps no columns');
  });

  it('accepts a NON-STRING expression, which is what reaches an adapter', () => {
    // The regression `CopyMappingSchema`'s own docblock predicts: substitution
    // happens in the REDUCER, and a whole-value `${}` reference preserves its
    // native type — so `expression: '${params.limit}'` arrives here as a NUMBER.
    // Re-parsing `preparedInput` through the AUTHORED schema would refuse a
    // working pipeline at dispatch.
    const parsed = copyDispatchInputSchema.parse({
      mapping: [{ expression: 42, sink: 'id', type: 'integer' }],
    });
    expect(parsed.mapping[0]?.expression).toBe(42);
  });

  it('the AUTHORED schema refuses that same value — the two variants differ ONLY there', () => {
    expect(
      CopyMappingSchema.safeParse([{ expression: 42, sink: 'id', type: 'integer' }]).success,
    ).toBe(false);
  });

  it('keeps the XOR, so a dispatch payload cannot carry both arms', () => {
    const result = copyDispatchInputSchema.safeParse({
      mapping: [{ source: 'a', expression: 1, sink: 'id', type: 'integer' }],
    });
    expect(result.success).toBe(false);
  });

  it('keeps one-sink-one-writer, so a dispatch payload cannot silently last-wins', () => {
    const result = copyDispatchInputSchema.safeParse({
      mapping: [
        { source: 'a', sink: 'id', type: 'integer' },
        { source: 'b', sink: 'id', type: 'integer' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('defaults the write mode to append — the non-destructive arm', () => {
    expect(copyDispatchInputSchema.parse({ mapping: [row] }).mode).toBe('append');
  });

  it('takes overwrite, and refuses any other mode', () => {
    expect(copyDispatchInputSchema.parse({ mapping: [row], mode: 'overwrite' }).mode).toBe(
      'overwrite',
    );
    expect(copyDispatchInputSchema.safeParse({ mapping: [row], mode: 'truncate' }).success).toBe(
      false,
    );
  });

  it('still defaults onError to fail — the shared element shape is ONE declaration', () => {
    expect(copyDispatchInputSchema.parse({ mapping: [row] }).mapping[0]?.onError).toBe('fail');
  });
});

/**
 * M5 slice 4c (#1139) — the AUTHORED variant, which the catalog entry declares
 * as `copy`'s `configSchema`.
 *
 * The point of these is the SHARING: both variants come from one
 * `copyInputShape`, so a rule added to `mode` cannot land on only one of them.
 * The one field they are allowed to disagree about is `mapping`, and the last
 * two tests pin that disagreement in both directions — an authored `expression`
 * is a TEMPLATE STRING, a dispatch one is the substituted value of any type.
 */
describe('the AUTHORED copy config (#1139, catalog configSchema)', () => {
  const authored = { source: 'a', sink: 'id', type: 'integer' as const };

  it('defaults the write mode to append, exactly as the dispatch variant does', () => {
    expect(copyInputSchema.parse({ mapping: [authored] }).mode).toBe('append');
  });

  it('takes overwrite and refuses any other mode — one declaration, both variants', () => {
    expect(copyInputSchema.parse({ mapping: [authored], mode: 'overwrite' }).mode).toBe(
      'overwrite',
    );
    expect(copyInputSchema.safeParse({ mapping: [authored], mode: 'truncate' }).success).toBe(
      false,
    );
  });

  it('REQUIRES a mapping — an empty default would author a copy that moves nothing', () => {
    expect(copyInputSchema.safeParse({}).success).toBe(false);
  });

  it('inherits the XOR and duplicate-sink refinements from the shared element shape', () => {
    expect(copyInputSchema.safeParse({ mapping: [{ sink: 'id', type: 'integer' }] }).success).toBe(
      false,
    );
    expect(
      copyInputSchema.safeParse({
        mapping: [authored, { source: 'b', sink: 'id', type: 'integer' }],
      }).success,
    ).toBe(false);
  });

  it('is NOT strict — the canvas hands it a whole config blob, `config.outputs` included', () => {
    // #1 F13: `Node.config` carries `outputs` beside the activity's own settings,
    // and `PipelineCanvas`'s JSON editor validates the WHOLE blob against this
    // schema. A strict variant would refuse every edit of a saved copy node.
    const parsed = copyInputSchema.safeParse({
      mapping: [authored],
      outputs: [{ name: 'rowsRead', type: 'number' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('takes a ${} TEMPLATE in expression — the authored variant types it as a string', () => {
    const parsed = copyInputSchema.parse({
      mapping: [{ sink: 'at', type: 'string', expression: '${run.startedAt}' }],
    });
    expect(parsed.mapping[0]?.expression).toBe('${run.startedAt}');
  });

  it('REFUSES a non-string expression, where the DISPATCH variant accepts one', () => {
    // The one field the two variants disagree about, pinned from both sides: a
    // substituted whole-value ref preserves its native type, so `42` is valid at
    // dispatch and is not something an author can have typed.
    const numeric = { mapping: [{ sink: 'n', type: 'integer', expression: 42 }] };
    expect(copyInputSchema.safeParse(numeric).success).toBe(false);
    expect(copyDispatchInputSchema.safeParse(numeric).success).toBe(true);
  });
});
