import { describe, expect, it } from 'vitest';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import {
  docUnchanged,
  historyEntries,
  restoreBodyFrom,
  restoreConfirmMessage,
  restoreRefusal,
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
    expect(historyEntries([], null)).toEqual([]);
  });

  it('marks nothing current when the canvas is on no version (a new pipeline)', () => {
    const entries = historyEntries([version({ version: 1 })], null);
    expect(entries.map((e) => e.isCurrent)).toEqual([false]);
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

    expect(restoreBodyFrom(v)).toEqual({
      nodes: v.nodes,
      edges: v.edges,
      containers: v.containers,
      params: v.params,
      outputs: v.outputs,
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
    expect(restoreBodyFrom(v).containers).toEqual(v.containers);
  });

  /* The server re-stamps `catalogVersion` and mints the identity, so sending
     either would be a claim this client is not entitled to make — and the four
     `source*` git-provenance fields must NOT ride along, because a restore is a
     newly authored version, not one minted from a commit. */
  it('sends no identity, catalog or git-provenance fields', () => {
    const body = restoreBodyFrom(version()) as Record<string, unknown>;
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
