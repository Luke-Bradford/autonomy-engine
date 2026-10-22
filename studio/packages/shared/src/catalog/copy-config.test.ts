import { describe, expect, it } from 'vitest';
import {
  COPY_DEFAULT_BATCH_ROWS,
  COPY_MAX_BATCH_ROWS,
  COPY_TABLE_OPTIONS,
  CopyMappingSchema,
  autoCreateCollisionIssue,
  copyDispatchInputSchema,
  copyIncrementalIssues,
  copyInputSchema,
  copySkipIncompatibleIssue,
  copyVerifyConsistencyIssue,
} from './copy-config.js';
import { formatZodIssues } from '../schemas/zod-issues.js';
import { getActivity } from './registry.js';
import { COPY_ACTIVITY_TYPE } from './types.js';

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
    // `mappingArray` builds both shapes precisely so they cannot disagree
    // about a rule that never mentions `expression`. Were this on the authored
    // schema alone, a version minted before #1172 would still reach the pump,
    // and `connectors/copy.ts` would report the fault a rung later.
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

  it('takes each of the four write behaviours, and refuses any other mode', () => {
    for (const mode of ['append', 'overwrite', 'truncate', 'upsert'] as const) {
      expect(copyDispatchInputSchema.parse({ mapping: [row], mode }).mode).toBe(mode);
    }
    expect(copyDispatchInputSchema.safeParse({ mapping: [row], mode: 'merge' }).success).toBe(
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
    expect(copyInputSchema.safeParse({ mapping: [authored], mode: 'merge' }).success).toBe(false);
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

/**
 * #1600 OR41 C3a — Write behaviour Upsert and its Key columns (catalogue §4.1).
 *
 * The key rules are one declaration (`copyKeyColumnIssues`) read by both
 * variants' `superRefine` and by the #444 write gate, so each is asserted with
 * its PATH: a bare `success === false` would pass for a rule that named the
 * wrong field.
 */
describe('copy Key columns (C3a)', () => {
  const id = { source: 'id', sink: 'id', type: 'integer' as const };
  const name = { source: 'name', sink: 'name', type: 'string' as const };
  const issuesOf = (cfg: Record<string, unknown>) => {
    const r = copyInputSchema.safeParse(cfg);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('takes Upsert with no Key columns (the table primary key) or with mapped ones', () => {
    expect(issuesOf({ mapping: [id, name], mode: 'upsert' })).toEqual([]);
    expect(issuesOf({ mapping: [id, name], mode: 'upsert', keyColumns: ['id'] })).toEqual([]);
    expect(issuesOf({ mapping: [id, name], mode: 'upsert', keyColumns: ['id', 'name'] })).toEqual(
      [],
    );
  });

  it('refuses Key columns on any other write behaviour, which would silently ignore them', () => {
    expect(issuesOf({ mapping: [id], mode: 'append', keyColumns: ['id'] })).toEqual([
      'keyColumns: only read when Write behaviour is Upsert',
    ]);
    expect(issuesOf({ mapping: [id], keyColumns: ['id'] })).toEqual([
      'keyColumns: only read when Write behaviour is Upsert',
    ]);
    // An empty list is unset, as the dock writes when the last key is removed.
    expect(issuesOf({ mapping: [id], mode: 'append', keyColumns: [] })).toEqual([]);
  });

  it('refuses a key that no mapping row writes, compared as a string (#1151)', () => {
    expect(issuesOf({ mapping: [id, name], mode: 'upsert', keyColumns: ['ID'] })).toEqual([
      "keyColumns.0: 'ID' is not a mapped sink column, so no row carries its value",
    ]);
  });

  it('refuses a key named twice', () => {
    expect(issuesOf({ mapping: [id, name], mode: 'upsert', keyColumns: ['id', 'id'] })).toEqual([
      "keyColumns.1: duplicate key column 'id'",
    ]);
  });

  it('refuses a key whose mapping row writes NULL on a conversion error — a null key matches nothing', () => {
    expect(
      issuesOf({
        mapping: [{ ...id, onError: 'null' }, name],
        mode: 'upsert',
        keyColumns: ['id'],
      }),
    ).toEqual([
      "keyColumns.0: the mapping row for 'id' writes NULL on a conversion error, and a NULL key matches no row — set its On error to Fail",
    ]);
  });

  it('applies the same rules to the dispatch variant', () => {
    expect(
      copyDispatchInputSchema.safeParse({ mapping: [id], mode: 'append', keyColumns: ['id'] })
        .success,
    ).toBe(false);
  });
});

// #1600 OR41 C3b — Pre-copy script and Batch size (catalogue §4.1, database sink).
describe('Pre-copy script and Batch size (C3b)', () => {
  const row = { source: 'a', sink: 'id', type: 'integer' as const };

  it('takes a script with bind values, and leaves both absent by default', () => {
    const cfg = copyInputSchema.parse({
      mapping: [row],
      preCopyScript: 'delete from t where d = :d',
      preCopyScriptParameters: { d: '${params.day}' },
    });
    expect(cfg.preCopyScript).toBe('delete from t where d = :d');
    expect(cfg.preCopyScriptParameters).toEqual({ d: '${params.day}' });
    const bare = copyInputSchema.parse({ mapping: [row] });
    expect(bare.preCopyScript).toBeUndefined();
    expect(bare.writeBatchSize).toBeUndefined();
  });

  it('types an authored bind value as text, a dispatched one as what it resolved to', () => {
    // A whole-value `${}` may resolve to a number or null by dispatch time.
    expect(
      copyInputSchema.safeParse({
        mapping: [row],
        preCopyScript: 'delete from t where n = :n',
        preCopyScriptParameters: { n: 5 },
      }).success,
    ).toBe(false);
    expect(
      copyDispatchInputSchema.parse({
        mapping: [row],
        preCopyScript: 'delete from t where n = :n',
        preCopyScriptParameters: { n: 5, m: null, s: 'x' },
      }).preCopyScriptParameters,
    ).toEqual({ n: 5, m: null, s: 'x' });
    // A boolean is not a value either store binds.
    expect(
      copyDispatchInputSchema.safeParse({
        mapping: [row],
        preCopyScript: 'delete from t where n = :n',
        preCopyScriptParameters: { n: true },
      }).success,
    ).toBe(false);
  });

  it('refuses bind values with no script to bind them into', () => {
    const result = copyInputSchema.safeParse({
      mapping: [row],
      preCopyScriptParameters: { d: 'x' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['preCopyScriptParameters']);
  });

  it(`bounds Batch size to 1..${COPY_MAX_BATCH_ROWS} whole rows`, () => {
    for (const ok of [1, COPY_DEFAULT_BATCH_ROWS, COPY_MAX_BATCH_ROWS]) {
      expect(copyInputSchema.parse({ mapping: [row], writeBatchSize: ok }).writeBatchSize).toBe(ok);
    }
    for (const bad of [0, -1, 1.5, COPY_MAX_BATCH_ROWS + 1, '1000']) {
      expect(
        copyDispatchInputSchema.safeParse({ mapping: [row], writeBatchSize: bad }).success,
      ).toBe(false);
    }
  });
});

describe('Table option: Auto-create from mapping (C3c)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };
  const name = { source: 'b', sink: 'name', type: 'string' as const };

  it('defaults to none (use the existing table) and takes the two ADF values', () => {
    expect(COPY_TABLE_OPTIONS).toEqual(['none', 'autoCreate']);
    expect(copyInputSchema.parse({ mapping: [id] }).tableOption).toBe('none');
    expect(copyDispatchInputSchema.parse({ mapping: [id] }).tableOption).toBe('none');
    expect(copyInputSchema.parse({ mapping: [id], tableOption: 'autoCreate' }).tableOption).toBe(
      'autoCreate',
    );
    expect(copyInputSchema.safeParse({ mapping: [id], tableOption: 'create' }).success).toBe(false);
  });

  it('refuses, under Auto-create, two sink names that differ only by case', () => {
    const clash = [id, { ...name, sink: 'ID' }];
    // Without Auto-create the names are compared as strings (#1151), so this stands.
    expect(copyInputSchema.safeParse({ mapping: clash }).success).toBe(true);
    const result = copyInputSchema.safeParse({ mapping: clash, tableOption: 'autoCreate' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['tableOption']);
    expect(result.error?.issues[0]?.message).toBe(
      "Auto-create cannot create both 'id' and 'ID': the copy matches sink columns without case",
    );
    expect(
      copyDispatchInputSchema.safeParse({ mapping: clash, tableOption: 'autoCreate' }).success,
    ).toBe(false);
    expect(
      copyInputSchema.safeParse({ mapping: [id, name], tableOption: 'autoCreate' }).success,
    ).toBe(true);
  });

  it('names the collision from the sink names alone', () => {
    expect(autoCreateCollisionIssue(['a', 'b', 'c'])).toBeNull();
    expect(autoCreateCollisionIssue(['Name', 'x', 'NAME'])).toBe(
      "Auto-create cannot create both 'Name' and 'NAME': the copy matches sink columns without case",
    );
  });
});

describe('Skip incompatible rows (C6d-1)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };

  it('defaults to off and takes a boolean', () => {
    expect(copyInputSchema.parse({ mapping: [id] }).skipIncompatibleRows).toBe(false);
    expect(copyDispatchInputSchema.parse({ mapping: [id] }).skipIncompatibleRows).toBe(false);
    expect(
      copyInputSchema.parse({ mapping: [id], skipIncompatibleRows: true }).skipIncompatibleRows,
    ).toBe(true);
    expect(copyInputSchema.safeParse({ mapping: [id], skipIncompatibleRows: 'yes' }).success).toBe(
      false,
    );
  });

  it('is refused with Upsert, as ADF does, on the field', () => {
    const result = copyInputSchema.safeParse({
      mapping: [id],
      mode: 'upsert',
      skipIncompatibleRows: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toEqual([['skipIncompatibleRows']]);
    expect(
      copyInputSchema.safeParse({ mapping: [id], mode: 'upsert', skipIncompatibleRows: false })
        .success,
    ).toBe(true);
    for (const mode of ['append', 'overwrite', 'truncate']) {
      expect(
        copyInputSchema.safeParse({ mapping: [id], mode, skipIncompatibleRows: true }).success,
      ).toBe(true);
    }
  });

  it('leaves a ${} Write behaviour to dispatch, which sees the resolved mode', () => {
    expect(
      copySkipIncompatibleIssue({ mode: '${pipeline().parameters.m}', skipIncompatibleRows: true }),
    ).toBeNull();
    expect(
      copyDispatchInputSchema.safeParse({
        mapping: [id],
        mode: 'upsert',
        skipIncompatibleRows: true,
      }).success,
    ).toBe(false);
  });
});

describe('Verify after copy (C6e-1)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };

  it('defaults to off and takes a boolean', () => {
    expect(copyInputSchema.parse({ mapping: [id] }).validateDataConsistency).toBe(false);
    expect(copyDispatchInputSchema.parse({ mapping: [id] }).validateDataConsistency).toBe(false);
    expect(
      copyInputSchema.parse({ mapping: [id], validateDataConsistency: true })
        .validateDataConsistency,
    ).toBe(true);
    expect(
      copyInputSchema.safeParse({ mapping: [id], validateDataConsistency: 'yes' }).success,
    ).toBe(false);
  });

  it('is refused with Upsert, whose store count is not the rows sent, on the field', () => {
    const result = copyInputSchema.safeParse({
      mapping: [id],
      mode: 'upsert',
      validateDataConsistency: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toEqual([['validateDataConsistency']]);
    expect(
      copyInputSchema.safeParse({ mapping: [id], mode: 'upsert', validateDataConsistency: false })
        .success,
    ).toBe(true);
    for (const mode of ['append', 'overwrite', 'truncate']) {
      expect(
        copyInputSchema.safeParse({ mapping: [id], mode, validateDataConsistency: true }).success,
      ).toBe(true);
    }
  });

  it('leaves a ${} Write behaviour to dispatch, which sees the resolved mode', () => {
    expect(
      copyVerifyConsistencyIssue({
        mode: '${pipeline().parameters.m}',
        validateDataConsistency: true,
      }),
    ).toBeNull();
    expect(
      copyDispatchInputSchema.safeParse({
        mapping: [id],
        mode: 'upsert',
        validateDataConsistency: true,
      }).success,
    ).toBe(false);
  });
});

describe('session log to a folder (C6c-1b)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };
  const issues = (extra: Record<string, unknown>) => {
    const r = copyInputSchema.safeParse({ mapping: [id], ...extra });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('writes to the run log by default, and to a folder on the log connection', () => {
    const cfg = copyInputSchema.parse({ mapping: [id] });
    expect(cfg.logTo).toBe('run');
    expect(cfg.logFolder).toBeUndefined();
    expect(issues({ logTo: 'folder', logFolder: 'logs' })).toEqual([]);
    // Dispatch checks the same rules, for a `${}` resolved there.
    expect(copyDispatchInputSchema.safeParse({ mapping: [id], logTo: 'folder' }).success).toBe(
      false,
    );
  });

  it.each([
    [{ logTo: 'folder' }, 'logFolder: needed to write the session log to a folder'],
    [{ logFolder: 'logs' }, 'logFolder: only read when the session log is written to a folder'],
    [
      { logLevel: 'off', logTo: 'folder', logFolder: 'logs' },
      'logLevel: the session log is off, but it is set to write to a folder',
    ],
  ])('refuses %j', (extra, message) => {
    expect(issues(extra)).toEqual([message]);
  });

  it('is allowed with Upsert, unlike the Settings fields before it', () => {
    expect(issues({ mode: 'upsert', logTo: 'folder', logFolder: 'logs' })).toEqual([]);
  });

  it('draws Write to and the folder (and its connection) on Settings, as Files as-is does', () => {
    const entry = getActivity(COPY_ACTIVITY_TYPE)!;
    expect(entry.appliesWhen?.logTo).toEqual([{ field: 'logLevel', in: ['warning', 'info'] }]);
    expect(entry.appliesWhen?.logFolder).toEqual([{ field: 'logTo', in: ['folder'] }]);
    expect(entry.logConnectionKinds).toEqual(['fs']);
    const settings = entry.tabs!.find((t) => t.key === 'settings')!;
    expect(settings.fields.slice(-4)).toEqual(['logLevel', 'logTo', 'logFolder', 'logMode']);
    expect(settings.bindings).toEqual(['logConnection']);
  });

  it('declares logPath after the C6f outputs, and keeps the outputs a node saved before C6c-1b declares', () => {
    const entry = getActivity(COPY_ACTIVITY_TYPE)!;
    // C5a's watermark follows it; `formerOutputs[0]` is the C5a snapshot.
    const beforeC5a = entry.formerOutputs![0]!;
    expect(beforeC5a.at(-1)?.name).toBe('logPath');
    expect(beforeC5a.at(-1)?.optional).toBe(true);
    expect(entry.formerOutputs![1]!).toEqual(beforeC5a.slice(0, -1));
  });
});

describe('session log mode (#1600 OR41 C6c-2)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };
  const issues = (extra: Record<string, unknown>) => {
    const r = copyInputSchema.safeParse({ mapping: [id], ...extra });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('is Reliable by default, and Best effort for a folder log', () => {
    expect(copyInputSchema.parse({ mapping: [id] }).logMode).toBe('reliable');
    expect(issues({ logTo: 'folder', logFolder: 'logs', logMode: 'bestEffort' })).toEqual([]);
    expect(issues({ logMode: 'eventually' })).toHaveLength(1);
  });

  it.each([{}, { logLevel: 'off' }])('refuses Best effort without a folder log (%j)', (extra) => {
    expect(issues({ ...extra, logMode: 'bestEffort' })).toEqual([
      'logMode: only read when the session log is written to a folder',
    ]);
    // Dispatch checks the same rule, for a `${}` Write to resolved there.
    expect(
      copyDispatchInputSchema.safeParse({ mapping: [id], ...extra, logMode: 'bestEffort' }).success,
    ).toBe(false);
  });

  it('is drawn for a folder log, after the folder', () => {
    const entry = getActivity(COPY_ACTIVITY_TYPE)!;
    expect(entry.appliesWhen?.logMode).toEqual([{ field: 'logTo', in: ['folder'] }]);
  });
});

describe('partitioned reads (C6f-3)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };
  const issues = (extra: Record<string, unknown>) => {
    const r = copyInputSchema.safeParse({ mapping: [id], ...extra });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('defaults to no partitioning and one copy, so a stored copy reads as it did', () => {
    const cfg = copyInputSchema.parse({ mapping: [id] });
    expect(cfg.partitionOption).toBe('none');
    expect(cfg.parallelCopies).toBe(1);
    expect(cfg.partitionColumnName).toBeUndefined();
    expect(copyDispatchInputSchema.parse({ mapping: [id] }).partitionOption).toBe('none');
  });

  it('takes Dynamic range with a column, optional bounds and a degree', () => {
    expect(
      issues({
        partitionOption: 'dynamicRange',
        partitionColumnName: 'id',
        partitionLowerBound: 1,
        partitionUpperBound: 80,
        parallelCopies: 4,
      }),
    ).toEqual([]);
    expect(issues({ partitionOption: 'dynamicRange', partitionColumnName: 'id' })).toEqual([]);
  });

  it('needs a partition column under Dynamic range', () => {
    expect(issues({ partitionOption: 'dynamicRange' })).toEqual([
      'partitionColumnName: Dynamic range needs a partition column',
    ]);
  });

  it('refuses the range settings and a degree without a partition option', () => {
    expect(issues({ partitionColumnName: 'id' })).toEqual([
      'partitionColumnName: a partition column needs Partition option Dynamic range',
    ]);
    expect(issues({ partitionLowerBound: 1 })).toEqual([
      'partitionLowerBound: a partition bound needs Partition option Dynamic range',
    ]);
    expect(issues({ parallelCopies: 2 })).toEqual([
      'parallelCopies: a rows Copy reads with one reader unless Partition option is Dynamic range',
    ]);
    expect(issues({ parallelCopies: 1 })).toEqual([]);
  });

  it('refuses a lower bound above the upper bound, and a non-integer bound', () => {
    expect(
      issues({
        partitionOption: 'dynamicRange',
        partitionColumnName: 'id',
        partitionLowerBound: 9,
        partitionUpperBound: 3,
      }),
    ).toEqual(['partitionLowerBound: the lower bound is above the upper bound']);
    expect(
      issues({
        partitionOption: 'dynamicRange',
        partitionColumnName: 'id',
        partitionLowerBound: 1.5,
      }).length,
    ).toBe(1);
  });

  it('keeps the partition column literal: a name never comes from an expression', () => {
    expect(
      issues({
        partitionOption: 'dynamicRange',
        partitionColumnName: '${pipeline().parameters.c}',
      }),
    ).toEqual([
      'partitionColumnName: the partition column stays literal, so a column name never comes from an expression',
    ]);
  });

  it('places the range on the Source tab, drawn only under Dynamic range, and the degree first on Settings', () => {
    const entry = getActivity(COPY_ACTIVITY_TYPE)!;
    const tab = (key: string) => entry.tabs?.find((t) => t.key === key)?.fields;
    expect(tab('source')?.slice(4)).toEqual([
      'partitionOption',
      'partitionColumnName',
      'partitionLowerBound',
      'partitionUpperBound',
    ]);
    expect(tab('settings')?.[0]).toBe('parallelCopies');
    for (const field of [
      'partitionColumnName',
      'partitionLowerBound',
      'partitionUpperBound',
      'parallelCopies',
    ]) {
      expect(entry.appliesWhen?.[field]).toEqual([
        { field: 'partitionOption', in: ['dynamicRange'] },
      ]);
    }
  });
});

describe('incremental load (#1600 OR41 C5a)', () => {
  const id = { source: 'a', sink: 'id', type: 'integer' as const };
  const issues = (extra: Record<string, unknown>) => {
    const r = copyInputSchema.safeParse({ mapping: [id], ...extra });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };
  const incremental = { load: 'incremental', watermarkColumnName: 'modified_at' };

  it('defaults to a Full load with Automatic watermark, so a stored copy reads as it did', () => {
    const cfg = copyInputSchema.parse({ mapping: [id] });
    expect(cfg.load).toBe('full');
    expect(cfg.watermarkFrom).toBe('automatic');
    expect(cfg.watermarkColumnName).toBeUndefined();
    expect(cfg.watermarkOld).toBeUndefined();
  });

  it('takes Incremental with a column, Automatic or Expression', () => {
    expect(issues(incremental)).toEqual([]);
    expect(
      issues({
        ...incremental,
        watermarkFrom: 'expression',
        watermarkOld: '${nodes.l.output.firstRow.wm}',
      }),
    ).toEqual([]);
  });

  it('needs a watermark column under Incremental, and an old watermark under Expression', () => {
    expect(issues({ load: 'incremental' })).toEqual([
      'watermarkColumnName: Load Incremental needs a watermark column',
    ]);
    expect(issues({ ...incremental, watermarkFrom: 'expression' })).toEqual([
      'watermarkOld: Watermark from Expression needs an old watermark',
    ]);
    expect(issues({ ...incremental, watermarkFrom: 'expression', watermarkOld: ' ' })).toEqual([
      'watermarkOld: Watermark from Expression needs an old watermark',
    ]);
  });

  it('refuses the watermark settings under a Full load, and an old watermark under Automatic', () => {
    expect(issues({ watermarkColumnName: 'm' })).toEqual([
      'watermarkColumnName: a watermark column needs Load Incremental',
    ]);
    expect(issues({ watermarkFrom: 'expression' })).toEqual([
      'watermarkFrom: Watermark from Expression needs Load Incremental',
    ]);
    expect(issues({ ...incremental, watermarkOld: '5' })).toEqual([
      'watermarkOld: an old watermark is read only with Watermark from Expression; Automatic stores its own',
    ]);
  });

  it('keeps Load, Watermark from and the column literal', () => {
    expect(copyIncrementalIssues({ load: '${params.l}' })).toEqual([
      { field: 'load', message: 'Load stays literal, because it decides which fields apply' },
    ]);
    expect(copyIncrementalIssues({ ...incremental, watermarkFrom: '${params.f}' })).toEqual([
      {
        field: 'watermarkFrom',
        message: 'Watermark from stays literal, because it decides which fields apply',
      },
    ]);
    expect(issues({ ...incremental, watermarkColumnName: '${params.c}' })).toEqual([
      'watermarkColumnName: the watermark column stays literal, so a column name never comes from an expression',
    ]);
  });

  it('refuses Incremental with a partitioned read', () => {
    expect(
      issues({ ...incremental, partitionOption: 'dynamicRange', partitionColumnName: 'id' }),
    ).toEqual(['load: Load Incremental reads with one reader, so set Partition option to None']);
  });

  it('dispatches a resolved old watermark of any scalar type', () => {
    const base = { mapping: [id], ...incremental, watermarkFrom: 'expression' };
    expect(copyDispatchInputSchema.parse({ ...base, watermarkOld: 7 }).watermarkOld).toBe(7);
    expect(copyDispatchInputSchema.parse({ ...base, watermarkOld: null }).watermarkOld).toBeNull();
    expect(copyDispatchInputSchema.safeParse({ ...base, watermarkOld: true }).success).toBe(false);
  });

  it('places Load and the watermark first on the Source tab, drawn only where they apply', () => {
    const entry = getActivity(COPY_ACTIVITY_TYPE)!;
    expect(entry.tabs?.find((t) => t.key === 'source')?.fields.slice(0, 4)).toEqual([
      'load',
      'watermarkColumnName',
      'watermarkFrom',
      'watermarkOld',
    ]);
    expect(entry.appliesWhen?.['watermarkColumnName']).toEqual([
      { field: 'load', in: ['incremental'] },
    ]);
    expect(entry.appliesWhen?.['watermarkFrom']).toEqual([{ field: 'load', in: ['incremental'] }]);
    expect(entry.appliesWhen?.['watermarkOld']).toEqual([
      { field: 'watermarkFrom', in: ['expression'] },
    ]);
    expect(entry.outputs.at(-1)).toMatchObject({ name: 'watermark', type: 'json', optional: true });
    expect(entry.formerOutputs![0]!).toEqual(entry.outputs.slice(0, -1));
  });
});
