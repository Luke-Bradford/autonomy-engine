import { describe, expect, it } from 'vitest';
import { pipelineVersionContentForm } from '@autonomy-studio/shared';
import type { PipelineVersionExport } from '@autonomy-studio/shared';
import type {
  ConnectionExportData,
  NodeExport,
  PipelineExportData,
  TriggerExportData,
} from '@autonomy-studio/shared';
import { classifyWorkspace } from '../workspace-reconcile.js';
import type { OwnedVersionForm } from '../workspace-serialize.js';
import type {
  ParsedConnection,
  ParsedPipeline,
  ParsedTrigger,
  ParsedWorkspace,
} from '../workspace-parse.js';

function node(overrides: Partial<NodeExport> = {}): NodeExport {
  return {
    id: 'n1',
    type: 'llm_call',
    config: { prompt: 'hi' },
    connectionId: null,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function pipelineData(name: string, node0: NodeExport = node()): PipelineExportData {
  return {
    pipeline: {
      id: 'pl',
      resourceId: 'IGNORED',
      ownerId: 'local',
      name,
      concurrency: null,
      createdAt: 1,
      updatedAt: 1,
    },
    versions: [
      {
        id: 'pv',
        resourceId: 'IGNORED',
        pipelineId: 'pl',
        version: 1,
        params: [],
        outputs: [],
        nodes: [node0],
        edges: [],
        containers: [],
        catalogVersion: 5,
        createdAt: 1,
      },
    ],
    strippedConnectionRefs: [],
  };
}

function parsedPipeline(
  resourceId: string | null,
  name: string,
  node0?: NodeExport,
): ParsedPipeline {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    path: `pipelines/${slug}.json`,
    // Classifier tests don't exercise git provenance (that is workspace-apply's
    // mint path); a `null` blob sha is the honest non-git value here.
    blobSha: null,
    resourceId,
    versionResourceIds: [],
    data: pipelineData(name, node0),
  };
}

function connectionData(name: string, baseUrl = 'https://x'): ConnectionExportData {
  return {
    id: 'cn',
    resourceId: 'IGNORED',
    ownerId: 'local',
    name,
    kind: 'http',
    config: { baseUrl },
    parameters: [],
    requiresSecret: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function parsedConnection(
  resourceId: string | null,
  name: string,
  baseUrl?: string,
): ParsedConnection {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { path: `connections/${slug}.json`, resourceId, data: connectionData(name, baseUrl) };
}

function triggerData(name: string, enabled = true): TriggerExportData {
  return {
    id: 'tr',
    resourceId: 'IGNORED',
    ownerId: 'local',
    name,
    pipelineVersionId: null,
    params: {},
    mode: 'manual',
    schedule: null,
    recurrence: null,
    webhook: null,
    event: null,
    window: null,
    concurrency: { policy: 'queue' },
    runWindows: null,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  };
}

function parsedTrigger(resourceId: string | null, name: string, enabled?: boolean): ParsedTrigger {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { path: `triggers/${slug}.json`, resourceId, data: triggerData(name, enabled) };
}

function ws(overrides: Partial<ParsedWorkspace> = {}): ParsedWorkspace {
  return { pipelines: [], connections: [], triggers: [], diagnostics: [], ...overrides };
}

const dispositionOf = (plan: ReturnType<typeof classifyWorkspace>, resourceId: string) =>
  plan.resources.find((r) => r.resourceId === resourceId);

/** #3 G7 — `classifyWorkspace` now takes the owned-version resolution domain (a
 * required param in production, no fail-open default). Most tests use null-bound
 * or DB-only triggers where the set is irrelevant, so this wrapper defaults it to
 * empty; the resolved-space trigger normalization has its own dedicated case. */
const classify = (
  db: ParsedWorkspace,
  incoming: ParsedWorkspace,
  ownedVersionRids: ReadonlySet<string> = new Set(),
) => classifyWorkspace(db, incoming, ownedVersionRids);

describe('classifyWorkspace', () => {
  it('classifies an incoming resourceId absent from the DB as create', () => {
    const plan = classify(ws(), ws({ pipelines: [parsedPipeline('res_new', 'Fresh')] }));
    expect(dispositionOf(plan, 'res_new')).toMatchObject({
      disposition: 'create',
      nameChanged: false,
      contentChanged: false,
    });
    expect(plan.archive).toEqual([]);
  });

  it('classifies a pre-G1 file (null resourceId) as create', () => {
    const plan = classify(ws(), ws({ pipelines: [parsedPipeline(null, 'Legacy')] }));
    expect(plan.resources[0]).toMatchObject({ resourceId: null, disposition: 'create' });
  });

  it('classifies an identical resource (same content + name) as unchanged', () => {
    const db = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    expect(dispositionOf(classify(db, incoming), 'res_1')).toMatchObject({
      disposition: 'unchanged',
      nameChanged: false,
      contentChanged: false,
    });
  });

  it('ignores cross-machine identity/timestamps when deciding unchanged', () => {
    // The DB side would carry different DB ids / createdAt; content form excludes
    // them, so an otherwise-identical resource is unchanged.
    const db: ParsedWorkspace = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    db.pipelines[0]!.data.pipeline.id = 'pl_DB';
    db.pipelines[0]!.data.pipeline.createdAt = 9999;
    db.pipelines[0]!.data.versions[0]!.id = 'pv_DB';
    db.pipelines[0]!.data.versions[0]!.version = 42;
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    expect(dispositionOf(classify(db, incoming), 'res_1')?.disposition).toBe('unchanged');
  });

  it('classifies a content edit as update (contentChanged true)', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_1', 'P', node({ config: { prompt: 'old' } }))],
    });
    const incoming = ws({
      pipelines: [parsedPipeline('res_1', 'P', node({ config: { prompt: 'NEW' } }))],
    });
    expect(dispositionOf(classify(db, incoming), 'res_1')).toMatchObject({
      disposition: 'update',
      contentChanged: true,
      nameChanged: false,
    });
  });

  it('classifies a pure rename (name differs, content same) as rename', () => {
    const db = ws({ pipelines: [parsedPipeline('res_1', 'Old Name')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'New Name')] });
    expect(dispositionOf(classify(db, incoming), 'res_1')).toMatchObject({
      disposition: 'rename',
      nameChanged: true,
      contentChanged: false,
    });
  });

  it('labels a rename-AND-edit as update but keeps nameChanged true (no lost signal)', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_1', 'Old', node({ config: { prompt: 'old' } }))],
    });
    const incoming = ws({
      pipelines: [parsedPipeline('res_1', 'New', node({ config: { prompt: 'new' } }))],
    });
    expect(dispositionOf(classify(db, incoming), 'res_1')).toMatchObject({
      disposition: 'update',
      nameChanged: true,
      contentChanged: true,
    });
  });

  it('proposes archiving a DB pipeline whose resourceId is absent from the branch', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_keep', 'Keep'), parsedPipeline('res_gone', 'Gone')],
    });
    const incoming = ws({ pipelines: [parsedPipeline('res_keep', 'Keep')] });
    const plan = classify(db, incoming);
    expect(plan.archive).toEqual([
      { path: 'pipelines/gone.json', kind: 'pipeline', resourceId: 'res_gone', name: 'Gone' },
    ]);
    expect(dispositionOf(plan, 'res_keep')?.disposition).toBe('unchanged');
  });

  it('#664 — proposes NO archives when the branch snapshot has ANY diagnostic (incomplete → unsound)', () => {
    // `res_gone`'s file failed to read/parse, so it is absent from `incoming` but
    // present in the DB. Without the guard it would be a spurious "will archive
    // res_gone" alongside the diagnostic for its own file. An incomplete snapshot
    // cannot soundly infer deletions, so archive is empty while the diagnostic
    // stands — matching the apply's refuse-on-diagnostic posture.
    const db = ws({
      pipelines: [parsedPipeline('res_keep', 'Keep'), parsedPipeline('res_gone', 'Gone')],
    });
    const incoming = ws({
      pipelines: [parsedPipeline('res_keep', 'Keep')],
      diagnostics: [{ path: 'pipelines/gone.json', code: 'unreadable', message: 'x' }],
    });
    const plan = classify(db, incoming);
    expect(plan.archive).toEqual([]);
    // The still-readable resources are classified as normal.
    expect(dispositionOf(plan, 'res_keep')?.disposition).toBe('unchanged');
  });

  it('does NOT propose archiving a connection or trigger absent from the branch (deferred to G5c)', () => {
    const db = ws({
      connections: [parsedConnection('res_c', 'C')],
      triggers: [parsedTrigger('res_t', 'T')],
    });
    const plan = classify(db, ws());
    expect(plan.archive).toEqual([]);
    expect(plan.resources).toEqual([]);
  });

  it('classifies connections and triggers by resourceId too', () => {
    const db = ws({
      connections: [parsedConnection('res_c', 'C', 'https://old')],
      triggers: [parsedTrigger('res_t', 'T', true)],
    });
    const incoming = ws({
      connections: [parsedConnection('res_c', 'C', 'https://new')],
      triggers: [parsedTrigger('res_t', 'T', false)],
    });
    const plan = classify(db, incoming);
    expect(dispositionOf(plan, 'res_c')).toMatchObject({
      kind: 'connection',
      disposition: 'update',
    });
    expect(dispositionOf(plan, 'res_t')).toMatchObject({ kind: 'trigger', disposition: 'update' });
  });

  it('#3 G7: an unresolvable-bound incoming trigger previews unchanged against the force-disabled DB row (no phantom update)', () => {
    // The steady state after a prior import: the DB trigger was reconciled to
    // (null, disabled); the branch still carries the dangling binding + authored
    // enabled. The resolved-space normalization collapses the incoming binding to
    // (null, disabled) too → unchanged, not a phantom `update` on every preview.
    const dbTrig = parsedTrigger('res_t', 'T');
    dbTrig.data.pipelineVersionId = null;
    dbTrig.data.enabled = false; // force-disabled by the prior apply
    const incTrig = parsedTrigger('res_t', 'T');
    incTrig.data.pipelineVersionId = 'res_absent';
    incTrig.data.enabled = true;
    const plan = classify(ws({ triggers: [dbTrig] }), ws({ triggers: [incTrig] }), new Set());
    expect(dispositionOf(plan, 'res_t')).toMatchObject({
      kind: 'trigger',
      disposition: 'unchanged',
    });
  });

  it('#3 G7: a trigger bound to a RESOLVABLE owned version is not over-disabled — a matching bind previews unchanged', () => {
    const dbTrig = parsedTrigger('res_t', 'T');
    dbTrig.data.pipelineVersionId = 'res_pv_owned';
    const incTrig = parsedTrigger('res_t', 'T');
    incTrig.data.pipelineVersionId = 'res_pv_owned';
    const plan = classify(
      ws({ triggers: [dbTrig] }),
      ws({ triggers: [incTrig] }),
      new Set(['res_pv_owned']),
    );
    expect(dispositionOf(plan, 'res_t')).toMatchObject({
      kind: 'trigger',
      disposition: 'unchanged',
    });
  });

  it('#3 G8b-3: folds a bound-but-unready trigger enabled→false so the preview matches the force-disabled DB row', () => {
    const V = 'res_pv_owned';
    // The DB side is the row the apply's forward gate force-disabled: bound to V,
    // enabled:false. The branch still authors enabled:true, bound to V.
    const dbTrig = parsedTrigger('res_t', 'T', false);
    dbTrig.data.pipelineVersionId = V;
    const incTrig = parsedTrigger('res_t', 'T', true);
    incTrig.data.pipelineVersionId = V;
    const db = ws({ triggers: [dbTrig] });
    const incoming = ws({ triggers: [incTrig] });
    const owned = new Set([V]);

    // No readiness domain (undefined): bound is treated ready → incoming keeps
    // enabled:true → differs from the disabled DB row → phantom `update` (the gap
    // G8b-3 closes when readiness is supplied).
    expect(dispositionOf(classifyWorkspace(db, incoming, owned), 'res_t')!.disposition).toBe(
      'update',
    );
    // V UNREADY (not in readyVersionRids): incoming folds enabled→false → matches
    // the force-disabled DB row → `unchanged` (preview↔apply parity).
    expect(
      dispositionOf(classifyWorkspace(db, incoming, owned, new Set()), 'res_t')!.disposition,
    ).toBe('unchanged');
    // V READY: incoming keeps the authored enabled:true → differs → `update` (the
    // legitimate re-enable once the secret is supplied), not phantom churn.
    expect(
      dispositionOf(classifyWorkspace(db, incoming, owned, new Set([V])), 'res_t')!.disposition,
    ).toBe('update');
  });

  it('ignores a null-resourceId row on the DB side (defensive — serialize never emits one)', () => {
    // A DB-side pipeline with a null resourceId is a can't-happen shape
    // (serializeWorkspace always mints real ids); the classifier must not let it
    // become a spurious match/archive. An incoming pipeline reusing that name is
    // a plain create, and the null-id DB row is not proposed for archive.
    const db = ws({ pipelines: [parsedPipeline(null, 'Ghost')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_new', 'Ghost')] });
    const plan = classify(db, incoming);
    expect(dispositionOf(plan, 'res_new')?.disposition).toBe('create');
    expect(plan.archive).toEqual([]);
  });

  /**
   * #983 — the "commit, keep authoring, then pull" loop. The branch is pinned to
   * a version this workspace already holds; the DB has moved on. The forms differ
   * (the DB side is the LATEST version only), so before #983 every one of these
   * read `update` — a promised write that the apply then correctly declined to
   * make.
   */
  describe('superseded (a branch version this workspace already holds)', () => {
    const V1 = 'ver_1';
    /** The branch: pipeline `res_p`, pinned to version `V1`, whose node says v1. */
    const branch = (name = 'P', concurrency: number | null = null) => {
      const p = parsedPipeline('res_p', name, node({ config: { prompt: 'v1' } }));
      p.data.versions[0]!.resourceId = V1;
      p.data.pipeline.concurrency = concurrency;
      return p;
    };
    /** The DB: the same pipeline, authored on to a v2 the branch has never seen. */
    const authoredPast = (name = 'P', concurrency: number | null = null) => {
      const p = parsedPipeline('res_p', name, node({ config: { prompt: 'v2' } }));
      p.data.versions[0]!.resourceId = 'ver_2';
      p.data.pipeline.concurrency = concurrency;
      return p;
    };
    /** The stored form of `V1` as the route reads it, owned by `owner`. */
    const held = (
      owner = 'res_p',
      of = branch(),
      undecidableRefs = 0,
    ): Map<string, OwnedVersionForm> =>
      new Map([
        [
          V1,
          {
            pipelineResourceId: owner,
            // #1018 — the route hands the classifier a COMPARISON, not a form, so
            // the masked stored-vs-branch rule lives in one place. Here that is a
            // plain content-form equality plus whatever the caller declares
            // undecidable.
            compare: (incoming: PipelineVersionExport) => ({
              identical:
                pipelineVersionContentForm(of.data.versions[0]!) ===
                pipelineVersionContentForm(incoming),
              undecidableRefs,
            }),
          },
        ],
      ]);

    const classifyHeld = (
      db: ParsedWorkspace,
      incoming: ParsedWorkspace,
      ownedVersions?: ReadonlyMap<string, OwnedVersionForm>,
    ) => classifyWorkspace(db, incoming, new Set(), undefined, ownedVersions);

    it('labels a version the workspace already holds superseded, keeping contentChanged true', () => {
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        held(),
      );
      // `contentChanged` stays TRUE — the branch really does differ from the head.
      // Only the label says a pull would write nothing for it.
      expect(dispositionOf(plan, 'res_p')).toMatchObject({
        disposition: 'superseded',
        contentChanged: true,
        nameChanged: false,
      });
    });

    // #1018 — the preview and the apply judge the branch version with the SAME
    // masked comparison, so a stored row that references a DELETED connection is
    // superseded in both readings. Were the preview to compare raw forms it would
    // say `update` — a promised write — ahead of an apply that writes nothing,
    // which is exactly the divergence #983 lifted this lookup to prevent.
    it('#1018 — an UNDECIDABLE ref is still superseded, and the preview says it was not judged', () => {
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        held('res_p', branch(), 1),
      );
      expect(dispositionOf(plan, 'res_p')).toMatchObject({
        disposition: 'superseded',
        contentChanged: true,
        contentUnverified: true,
      });
    });

    // ...and an ordinary supersession claims nothing of the sort.
    it('#1018 — a fully decidable comparison reports contentUnverified false', () => {
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        held(),
      );
      expect(dispositionOf(plan, 'res_p')).toMatchObject({ contentUnverified: false });
    });

    it('does not claim superseded when the version id belongs to ANOTHER pipeline', () => {
      // The apply REFUSES this outright (a version id is unique per resource).
      // The preview must not describe it as a no-op.
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        held('res_other'),
      );
      expect(dispositionOf(plan, 'res_p')?.disposition).toBe('update');
    });

    it('does not claim superseded when the held id carries DIFFERENT content', () => {
      // A hand-edited file that kept the version id — the apply's other refusal.
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        held('res_p', authoredPast()),
      );
      expect(dispositionOf(plan, 'res_p')?.disposition).toBe('update');
    });

    it('stays update when a ROW field also differs — the apply patches it, so a write happens', () => {
      // The version is a no-op but `concurrency` is not: the apply reports
      // `updated`. Calling the whole resource superseded would under-report a real
      // write, which is the mirror of the bug #983 fixes.
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast('P', 1)] }),
        ws({ pipelines: [branch('P', 4)] }),
        held(),
      );
      expect(dispositionOf(plan, 'res_p')?.disposition).toBe('update');
    });

    it('reports rename when the name also differs — matching the apply action ladder', () => {
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast('Old')] }),
        ws({ pipelines: [branch('New')] }),
        held('res_p', branch('New')),
      );
      expect(dispositionOf(plan, 'res_p')).toMatchObject({
        disposition: 'rename',
        nameChanged: true,
        contentChanged: true,
      });
    });

    it('is unreachable for a version the workspace does not hold — an ordinary edit', () => {
      const plan = classifyHeld(
        ws({ pipelines: [authoredPast()] }),
        ws({ pipelines: [branch()] }),
        new Map(),
      );
      expect(dispositionOf(plan, 'res_p')?.disposition).toBe('update');
    });

    it('preserves the pre-#983 label when no owned-version domain is passed at all', () => {
      // The apply calls `classifyWorkspace` without it (it reads only
      // `plan.archive`), so omitting it must change nothing.
      const plan = classifyHeld(ws({ pipelines: [authoredPast()] }), ws({ pipelines: [branch()] }));
      expect(dispositionOf(plan, 'res_p')?.disposition).toBe('update');
    });
  });

  it('orders resources pipelines → connections → triggers, following the incoming snapshot', () => {
    const incoming = ws({
      pipelines: [parsedPipeline('res_p', 'P')],
      connections: [parsedConnection('res_c', 'C')],
      triggers: [parsedTrigger('res_t', 'T')],
    });
    expect(classify(ws(), incoming).resources.map((r) => r.kind)).toEqual([
      'pipeline',
      'connection',
      'trigger',
    ]);
  });
});
