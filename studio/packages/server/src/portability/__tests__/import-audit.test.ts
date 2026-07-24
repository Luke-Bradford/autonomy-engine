import { describe, expect, it } from 'vitest';
import type { WorkspaceGitApplyResult } from '@autonomy-studio/shared';
import { buildImportAppliedEvent } from '../import-audit.js';

const CTX = { branch: 'main', by: 'user_1' };

function result(over: Partial<WorkspaceGitApplyResult>): WorkspaceGitApplyResult {
  return {
    head: 'sha_head',
    refused: false,
    applied: [],
    deferred: [],
    archived: [],
    diagnostics: [],
    ...over,
  };
}

describe('buildImportAppliedEvent (#3 G6a — effectful-only audit)', () => {
  it('emits for a content update (an applied action other than unchanged)', () => {
    const event = buildImportAppliedEvent(
      result({
        applied: [
          {
            path: 'p/a.json',
            kind: 'pipeline',
            resourceId: 'res_a',
            action: 'updated',
            versionMinted: true,
          },
        ],
      }),
      CTX,
    );
    expect(event).toEqual({
      type: 'import.applied',
      head: 'sha_head',
      branch: 'main',
      applied: [
        {
          path: 'p/a.json',
          kind: 'pipeline',
          resourceId: 'res_a',
          action: 'updated',
          versionMinted: true,
        },
      ],
      archived: [],
      by: 'user_1',
    });
  });

  it('emits for an archive-only import (empty applied, non-empty archived)', () => {
    const event = buildImportAppliedEvent(
      result({
        archived: [{ resourceId: 'res_z', name: 'Z', disabledTriggerIds: ['trg_1'] }],
      }),
      CTX,
    );
    expect(event?.type).toBe('import.applied');
    expect(event?.archived).toHaveLength(1);
  });

  it('emits for a restore-that-minted (action unchanged-ish but versionMinted true)', () => {
    // A `restored` that also advanced the version doc: `action` is not the
    // effectful signal on its own (#672), `versionMinted` is.
    const event = buildImportAppliedEvent(
      result({
        applied: [
          {
            path: 'p/r.json',
            kind: 'pipeline',
            resourceId: 'res_r',
            action: 'restored',
            versionMinted: true,
          },
        ],
      }),
      CTX,
    );
    expect(event).not.toBeNull();
  });

  it('does NOT emit for an idempotent all-unchanged re-import', () => {
    const event = buildImportAppliedEvent(
      result({
        applied: [
          {
            path: 'p/a.json',
            kind: 'pipeline',
            resourceId: 'res_a',
            action: 'unchanged',
            versionMinted: false,
          },
          {
            path: 'c/b.json',
            kind: 'connection',
            resourceId: 'res_b',
            action: 'unchanged',
            versionMinted: false,
          },
        ],
      }),
      CTX,
    );
    expect(event).toBeNull();
  });

  it('does NOT emit for a refused import', () => {
    expect(buildImportAppliedEvent(result({ refused: true }), CTX)).toBeNull();
  });

  it('does NOT emit for an empty-repo no-op (head null, nothing applied)', () => {
    expect(buildImportAppliedEvent(result({ head: null }), CTX)).toBeNull();
  });
});
