import { describe, expect, it } from 'vitest';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { ApiError } from '../../api/client';
import {
  activeVersionLabel,
  describePublishRefusal,
  describeRestoreConflict,
  describeSaveConflict,
  docUnchanged,
  historyEntries,
  isPublishRefused,
  isStaleWrite,
  publishConfirmMessage,
  publishOutcomeMessage,
  publishRefusal,
  restoreBodyFrom,
  restoreConfirmMessage,
  restoreRefusal,
  saveAnywayLabel,
  type PublishCheck,
} from './versionHistory';

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
    id: 'plv_1',
    resourceId: 'res_plv1',
    pipelineId: 'pl_1',
    version: 1,
    params: [],
    outputs: [],
    nodes: [
      { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
      { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
    ],
    edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' }],
    containers: [],
    catalogVersion: 1,
    createdAt: 1,
    ...overrides,
  });
}

describe('historyEntries', () => {
  it('is newest-first, and marks the head and the version the canvas is on', () => {
    const entries = historyEntries(
      [
        version({ id: 'plv_1', version: 1, createdAt: 100 }),
        version({ id: 'plv_3', version: 3, createdAt: 300 }),
        version({ id: 'plv_2', version: 2, createdAt: 200 }),
      ],
      2,
      null,
    );

    expect(entries.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(entries.map((e) => e.isHead)).toEqual([true, false, false]);
    expect(entries.map((e) => e.isCurrent)).toEqual([false, true, false]);
  });

  it('counts each version by its own doc, not by the head', () => {
    const [head, older] = historyEntries(
      [
        version({ version: 1, nodes: [], edges: [] }),
        version({
          version: 2,
          containers: [{ id: 'c_1', kind: 'loop', children: ['n_a'] }],
          params: [{ name: 'p', type: 'string', required: false }],
          outputs: [{ name: 'o', type: 'string' }],
        }),
      ],
      null,
      null,
    );

    expect(head).toMatchObject({
      version: 2,
      nodeCount: 2,
      edgeCount: 1,
      containerCount: 1,
      paramCount: 1,
      outputCount: 1,
    });
    expect(older).toMatchObject({ version: 1, nodeCount: 0, edgeCount: 0, containerCount: 0 });
  });

  it('has no head and no current for a pipeline with no versions', () => {
    expect(historyEntries([], null, null)).toEqual([]);
  });

  it('marks nothing current when the canvas is on no version (a new pipeline)', () => {
    const entries = historyEntries([version({ version: 1 })], null, null);
    expect(entries.map((e) => e.isCurrent)).toEqual([false]);
  });

  it('marks the ACTIVE version by id, independently of head and current (#979)', () => {
    const entries = historyEntries(
      [
        version({ id: 'plv_1', version: 1 }),
        version({ id: 'plv_2', version: 2 }),
        version({ id: 'plv_3', version: 3 }),
      ],
      3,
      'plv_1',
    );

    // All three marks part company here, which is the point of carrying them
    // separately: the head is v3, the canvas is on v3, and what is DEPLOYED is v1.
    expect(entries.map((e) => e.isActive)).toEqual([false, false, true]);
    expect(entries.map((e) => e.isHead)).toEqual([true, false, false]);
  });

  it('marks nothing active when the pointer is unread, exactly as when nothing is published', () => {
    const vs = [version({ id: 'plv_1', version: 1 })];
    expect(historyEntries(vs, 1, undefined).map((e) => e.isActive)).toEqual([false]);
    expect(historyEntries(vs, 1, null).map((e) => e.isActive)).toEqual([false]);
  });
});

describe('publishRefusal', () => {
  /** A version that WOULD publish — git-minted, not archived, not active. */
  function publishable(overrides: Partial<PublishCheck> = {}): PublishCheck {
    return {
      selected: version({
        id: 'plv_7',
        version: 7,
        sourceCommit: 'a'.repeat(40),
        sourceBlobSha: 'b'.repeat(40),
      }),
      active: { versionId: 'plv_6', commit: 'c'.repeat(40), blob: 'd'.repeat(40) },
      gitConnected: true,
      archived: false,
      ...overrides,
    };
  }

  it('allows a git-minted version that is not already active', () => {
    expect(publishRefusal(publishable())).toBeNull();
  });

  it('refuses while the publish state is unread, rather than guessing at it', () => {
    // The rung that keeps the CAS honest: `expectedActiveVersionId: null` means
    // "expected never-published", NOT "unknown", so an unread pointer must never
    // reach the request.
    expect(publishRefusal(publishable({ active: undefined }))).toMatch(/could not be read/i);
    expect(publishRefusal(publishable({ gitConnected: undefined }))).toMatch(/could not be read/i);
  });

  it('refuses without a repo, and says where to connect one', () => {
    const refusal = publishRefusal(publishable({ gitConnected: false, active: null }));
    expect(refusal).toMatch(/git repo/i);
    expect(refusal).toContain('Manage → Git');
  });

  it('refuses an archived pipeline', () => {
    expect(publishRefusal(publishable({ archived: true }))).toMatch(/archived/i);
  });

  it('refuses a version with no git provenance, and names the way out', () => {
    const authored = publishRefusal(
      publishable({ selected: version({ id: 'plv_7', version: 7 }) }),
    );
    // The message an operator sees most often — nearly every version is authored
    // on the canvas — so it has to name the ACT, not the missing column.
    expect(authored).toContain('v7');
    expect(authored).toMatch(/commit/i);
    expect(authored).toMatch(/import/i);
    expect(authored).toContain('Manage → Git');

    // Both halves of the provenance pair are required, exactly as the server
    // requires them (routes/pipelines.ts).
    expect(
      publishRefusal(
        publishable({
          selected: version({ id: 'plv_7', version: 7, sourceCommit: 'a'.repeat(40) }),
        }),
      ),
    ).not.toBeNull();
  });

  it('refuses the version that is already active', () => {
    const refusal = publishRefusal(
      publishable({ active: { versionId: 'plv_7', commit: 'c'.repeat(40), blob: 'd'.repeat(40) } }),
    );
    expect(refusal).toContain('v7');
    expect(refusal).toMatch(/already/i);
  });

  it('reports the workspace-wide blockers before the per-version ones', () => {
    // Same order the route checks them in, so client and server never disagree
    // about WHICH reason an operator is shown.
    const everything = publishable({
      gitConnected: false,
      archived: true,
      selected: version({ id: 'plv_7', version: 7 }),
      active: null,
    });
    expect(publishRefusal(everything)).toMatch(/git repo/i);
    expect(publishRefusal({ ...everything, gitConnected: true })).toMatch(/archived/i);
  });
});

describe('activeVersionLabel', () => {
  const vs = [version({ id: 'plv_1', version: 1 }), version({ id: 'plv_2', version: 2 })];
  const pointer = (versionId: string) => ({
    versionId,
    commit: 'c'.repeat(40),
    blob: 'd'.repeat(40),
  });

  it('names a version this page holds', () => {
    expect(activeVersionLabel(pointer('plv_2'), vs)).toBe(2);
  });

  it('keeps "not read" and "nothing published" apart', () => {
    expect(activeVersionLabel(undefined, vs)).toBeUndefined();
    expect(activeVersionLabel(null, vs)).toBeNull();
  });

  /* The bug this resolver exists to kill. Another session publishes a version
     minted after this page loaded: the pointer is real, the number is not
     knowable here, and the obvious `?? null` reported it as NOTHING published —
     the exact opposite of the truth. */
  it('does not report an unnameable active version as “nothing published”', () => {
    expect(activeVersionLabel(pointer('plv_minted_elsewhere'), vs)).toBe('unnamed');
  });
});

describe('publishConfirmMessage', () => {
  it('states what moves, what does NOT move, and that nothing is destroyed', () => {
    const msg = publishConfirmMessage({ selectedVersion: 7, activeVersion: 6 });
    expect(msg).toContain('v7');
    expect(msg).toContain('v6');
    // The trigger semantics are the part an operator cannot guess: a binding is
    // resolved ONCE at creation (routes/triggers.ts `resolveBindToActive`), so
    // publishing does not re-point the triggers that already exist.
    expect(msg).toMatch(/new trigger/i);
    expect(msg).toMatch(/do not move|does not move/i);
    expect(msg).toMatch(/nothing is (changed|deleted)|no version is/i);
  });

  it('says so plainly when nothing has been published before', () => {
    const msg = publishConfirmMessage({ selectedVersion: 1, activeVersion: null });
    expect(msg).toMatch(/never been published|nothing is published/i);
    expect(msg).not.toMatch(/vnull|undefined/i);
  });

  it('does not claim "nothing is published" when the active version is merely unnameable', () => {
    const msg = publishConfirmMessage({ selectedVersion: 7, activeVersion: 'unnamed' });
    expect(msg).toMatch(/replaces the version that is currently active/i);
    expect(msg).not.toMatch(/nothing is published/i);
    expect(msg).not.toMatch(/vunnamed/);
  });
});

describe('publishOutcomeMessage', () => {
  it('reports a real publish', () => {
    expect(publishOutcomeMessage({ published: true, selectedVersion: 7 })).toMatch(/published v7/i);
  });

  it('does NOT claim a publish for the server’s idempotent no-op', () => {
    // `published: false` means the audit log was not appended — reporting it as
    // a publish would assert an effect that did not happen.
    const msg = publishOutcomeMessage({ published: false, selectedVersion: 7 });
    expect(msg).toMatch(/already/i);
    expect(msg).not.toMatch(/^Published/i);
  });
});

describe('isPublishRefused', () => {
  it('is the route’s 409 conflict, and nothing else', () => {
    expect(
      isPublishRefused(new ApiError(409, 'nope', { error: 'conflict', message: 'nope' })),
    ).toBe(true);
    expect(
      isPublishRefused(new ApiError(404, 'gone', { error: 'not_found', message: 'gone' })),
    ).toBe(false);
    expect(
      isPublishRefused(new ApiError(409, 'stale', { error: 'stale_write', message: 'stale' })),
    ).toBe(false);
    expect(isPublishRefused(new Error('network'))).toBe(false);
  });
});

describe('describePublishRefusal', () => {
  it('re-states the pointer it just re-read, without echoing the server’s sentence', () => {
    // The server's own message names internal DB ids (routes/pipelines.ts), and
    // this file already refuses to print those for a refused restore.
    const msg = describePublishRefusal(6);
    expect(msg).toMatch(/not published/i);
    expect(msg).toContain('v6');
    expect(msg).toMatch(/nothing was changed/i);
  });

  it('does not invent a version when nothing is published', () => {
    const msg = describePublishRefusal(null);
    expect(msg).not.toMatch(/vnull|undefined/);
    expect(msg).toMatch(/nothing is published/i);
  });

  it('names an unnameable active version without inventing a number', () => {
    const msg = describePublishRefusal('unnamed');
    expect(msg).not.toMatch(/nothing is published/i);
    expect(msg).not.toMatch(/vunnamed/);
    expect(msg).toMatch(/currently active/i);
  });

  it('does not report a FAILED re-read as “nothing is published”', () => {
    // The two are opposite claims. `null` is a fact the re-read established;
    // `undefined` is the absence of one, and printing it as the fact would be
    // the manufactured-default shape this module exists to refuse.
    const msg = describePublishRefusal(undefined);
    expect(msg).toMatch(/unknown/i);
    expect(msg).not.toMatch(/nothing is published/i);
    expect(msg).not.toMatch(/vundefined/);
  });
});

describe('restoreBodyFrom', () => {
  it('carries the five doc arrays of the version it is given', () => {
    const v = version({
      version: 3,
      nodes: [{ id: 'n_z', type: 'http_request', config: {}, position: { x: 1, y: 2 } }],
      edges: [],
      params: [{ name: 'p', type: 'string', required: false }],
      outputs: [{ name: 'o', type: 'string' }],
    });

    expect(restoreBodyFrom(v, 'pv_head')).toEqual({
      nodes: v.nodes,
      edges: v.edges,
      containers: v.containers,
      params: v.params,
      outputs: v.outputs,
      // #904 — a restore declares its CAS basis like any other save.
      basedOnVersionId: 'pv_head',
    });
  });

  /* #473's lesson, on the path that would silently re-lose it: `containers` was
     accepted, validated and returned while never being persisted, and a
     `.default([])` then manufactured an empty doc on read. A restore that drops
     them would look exactly like restoring a version that never had any. */
  it('carries containers', () => {
    const v = version({
      containers: [{ id: 'c_1', kind: 'loop', children: ['n_a'] }],
    });
    expect(restoreBodyFrom(v, null).containers).toEqual(v.containers);
  });

  /* The server re-stamps `catalogVersion` and mints the identity, so sending
     either would be a claim this client is not entitled to make — and the four
     `source*` git-provenance fields must NOT ride along, because a restore is a
     newly authored version, not one minted from a commit. */
  it('sends no identity, catalog or git-provenance fields', () => {
    const body = restoreBodyFrom(version(), 'pv_head') as Record<string, unknown>;
    for (const forbidden of [
      'id',
      'resourceId',
      'pipelineId',
      'version',
      'createdAt',
      'catalogVersion',
      'sourceCommit',
      'sourceBranch',
      'sourceFilePath',
      'sourceBlobSha',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe('restoreRefusal', () => {
  /* The refusal is the whole reason restoring cannot destroy anything: the
     canvas reloads onto the version the restore mints, so unsaved working edits
     would go with it. */
  it('refuses while the canvas has unsaved edits, and says so', () => {
    const refusal = restoreRefusal({ dirty: true, selectedVersion: 1, headVersion: 3 });
    expect(refusal).toMatch(/unsaved/i);
  });

  it('refuses to restore the version that is already the head', () => {
    const refusal = restoreRefusal({ dirty: false, selectedVersion: 3, headVersion: 3 });
    expect(refusal).toMatch(/already/i);
  });

  it('allows an older version on a clean canvas', () => {
    expect(restoreRefusal({ dirty: false, selectedVersion: 1, headVersion: 3 })).toBeNull();
  });

  /* Unsaved work outranks "there is nothing to restore" — a message about the
     head being current would send the operator to click Restore again rather
     than to save. */
  it('reports the unsaved edits first when both would refuse', () => {
    expect(restoreRefusal({ dirty: true, selectedVersion: 3, headVersion: 3 })).toMatch(/unsaved/i);
  });
});

describe('restoreConfirmMessage', () => {
  /* The convention the container-delete confirmation set: state what is CREATED
     and what is KEPT. Restoring destroys nothing — versions are immutable — and
     an operator who does not know that will not click the button. */
  it('names the new version and states that nothing is overwritten', () => {
    const msg = restoreConfirmMessage({ selectedVersion: 2, headVersion: 5 });
    expect(msg).toContain('v2');
    expect(msg).toContain('v6');
    expect(msg).toMatch(/kept|nothing is (deleted|overwritten)/i);
  });
});

describe('docUnchanged', () => {
  /* The five arrays are compared by REFERENCE, never by value: every store
     action mints a fresh array, so identity is what distinguishes "the operator
     edited during the POST" from "nothing happened". */
  function doc() {
    return { nodes: [], edges: [], containers: [], params: [], outputs: [] };
  }

  it('holds when the write sees back the arrays it snapshotted', () => {
    const before = doc();
    expect(docUnchanged(before, { ...before })).toBe(true);
  });

  /* Each field gets its own case because each has a store action that writes it
     ALONE — `createContainer` touches only `containers`, the param and output
     actions only `params`/`outputs`. A check that skipped any one of them would
     let that action's edits be silently overwritten by the rebase, which is the
     exact data loss this guard exists to stop. */
  for (const field of ['nodes', 'edges', 'containers', 'params', 'outputs'] as const) {
    it(`fails when only \`${field}\` was replaced`, () => {
      const before = doc();
      expect(docUnchanged(before, { ...before, [field]: [] })).toBe(false);
    });
  }

  /* Equal CONTENTS are not the question — a store action that rebuilt an array
     to the same values still means the operator was editing. */
  it('fails on a fresh array with identical contents', () => {
    const before = { ...doc(), nodes: [{ id: 'n1' }] };
    expect(docUnchanged(before, { ...before, nodes: [{ id: 'n1' }] })).toBe(false);
  });
});

/**
 * #904 — the two decisions the refused-save banner rides on. Both are here
 * rather than in the component for the reason this module exists: React Flow
 * does not render in jsdom, so `PipelineCanvas` has no unit test and anything
 * decidable has to be decidable out here.
 */
describe('isStaleWrite', () => {
  const staleBody = { error: 'stale_write' as const, message: 'it is now at v4' };

  it('is true for the server‘s stale-basis refusal', () => {
    expect(isStaleWrite(new ApiError(409, 'stale', staleBody))).toBe(true);
  });

  /* The load-bearing case. The SAME route answers 409 `conflict` for any
     SQLITE_CONSTRAINT — including the unique index on (pipelineId, version)
     that guards this very write — and the banner's whole purpose is to offer a
     re-based retry. Offering that on a constraint violation would re-POST
     straight into the same failure, so a bare `status === 409` test here would
     be worse than none. */
  it('is false for the generic 409 conflict on the same route', () => {
    expect(
      isStaleWrite(new ApiError(409, 'conflict', { error: 'conflict', message: 'nope' })),
    ).toBe(false);
  });

  it('is false for a stale_write code carried on a non-409 status', () => {
    expect(isStaleWrite(new ApiError(400, 'stale', staleBody))).toBe(false);
  });

  it('is false for a 409 with no body at all', () => {
    expect(isStaleWrite(new ApiError(409, 'conflict'))).toBe(false);
  });

  /* A network failure is not a refusal — narrowing has to survive a plain
     Error, which is what `catch` actually binds. */
  it('is false for a non-ApiError', () => {
    expect(isStaleWrite(new Error('offline'))).toBe(false);
    expect(isStaleWrite(null)).toBe(false);
  });
});

describe('describeSaveConflict', () => {
  const msg = describeSaveConflict(5);

  it('names the version that landed, and the one a retry would mint', () => {
    expect(msg).toContain('v5');
    expect(msg).toContain('v6');
  });

  /* Each of the three facts gets its own assertion, because dropping any one of
     them makes the next click a guess — and the third is the one it is tempting
     to leave out. */
  it('says the operator‘s own work survived', () => {
    expect(msg).toContain('still here');
  });

  it('says the other save survived and is reachable', () => {
    expect(msg).toContain('Version history');
  });

  it('says plainly that saving again does NOT merge the other version in', () => {
    expect(msg).toContain('NOT include');
  });
});

describe('saveAnywayLabel', () => {
  /* The button names the version it MINTS, not the one it skips: an operator
     reads the label as a description of the act they are about to perform. */
  it('names the version the override would create', () => {
    expect(saveAnywayLabel(5)).toBe('Save as v6 anyway');
  });
});

describe('describeRestoreConflict', () => {
  /* One assertion per fact, like its save-side sibling: each is a separate
     thing an operator needs, and a single `toBe` on the whole string would go
     red for a comma. */
  it('names the version that landed', () => {
    expect(describeRestoreConflict(7)).toContain('v7');
  });

  it('says nothing was changed', () => {
    expect(describeRestoreConflict(7)).toContain('nothing was changed');
  });

  it('says the list is now current, so the act can simply be retried', () => {
    expect(describeRestoreConflict(7)).toContain('restore again');
  });

  /* The refreshed list came back EMPTY. The write was still refused, and being
     vague beats naming a version that is not there — the #473 rule applied to
     prose: an absent fact must not be manufactured. */
  it('does not invent a version number when there is no head to name', () => {
    const msg = describeRestoreConflict(null);
    expect(msg).toContain('Not restored');
    expect(msg).not.toMatch(/v\d/);
  });
});
