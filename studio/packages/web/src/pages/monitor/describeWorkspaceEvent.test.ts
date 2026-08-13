import { describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, type WorkspaceEvent } from '@autonomy-studio/shared';
import { describeWorkspaceEvent } from './describeWorkspaceEvent';

/**
 * #1075 — the workspace-audit union rendered for a reader.
 *
 * Every fixture below is built through `WorkspaceEventSchema.parse`, not as a
 * bare object literal: these payloads cross the API boundary typed, so a test
 * fixture that has drifted from the schema would assert wording against a shape
 * the server can never send.
 */
function event(payload: unknown): WorkspaceEvent {
  return WorkspaceEventSchema.parse(payload);
}

describe('describeWorkspaceEvent (#1075)', () => {
  it('names the repository and the collaboration branch of a connect', () => {
    const { summary, detail } = describeWorkspaceEvent(
      event({
        type: 'repo.connected',
        repoUrl: 'https://github.com/acme/flows.git',
        collabBranch: 'studio/main',
        by: 'local',
      }),
    );

    expect(summary).toBe('Connected the repository https://github.com/acme/flows.git');
    expect(detail).toBe('Collaboration branch studio/main.');
  });

  it('counts the triggers an archive disabled', () => {
    const { summary, detail } = describeWorkspaceEvent(
      event({
        type: 'pipeline.archived',
        resourceId: 'res_a',
        name: 'Nightly report',
        disabledTriggerIds: ['trg_1', 'trg_2'],
        by: 'local',
      }),
    );

    expect(summary).toBe('Archived the pipeline Nightly report');
    expect(detail).toBe('The archive disabled 2 triggers.');
  });

  /* The count is the whole content of that sentence, so the singular is not
     cosmetic — "disabled 1 triggers" is the read a plural-less join gives. */
  it('says one trigger, not one triggers', () => {
    expect(
      describeWorkspaceEvent(
        event({
          type: 'pipeline.archived',
          resourceId: 'res_a',
          name: 'Nightly report',
          disabledTriggerIds: ['trg_1'],
          by: 'local',
        }),
      ).detail,
    ).toBe('The archive disabled 1 trigger.');
  });

  /* An empty `disabledTriggerIds` is a real fact about the archive (nothing was
     enabled), not an absence to render as a blank. */
  it('distinguishes an archive that disabled nothing from one that disabled something', () => {
    expect(
      describeWorkspaceEvent(
        event({
          type: 'pipeline.archived',
          resourceId: 'res_a',
          name: 'Nightly report',
          disabledTriggerIds: [],
          by: 'local',
        }),
      ).detail,
    ).toBe('No triggers were enabled, so none were disabled.');
  });

  /**
   * `PipelineRestoredEventSchema`'s docblock is explicit that a restore
   * re-enables NOTHING — an `enabledTriggerIds` field "would be a standing lie
   * about what the act does". The rendered sentence must not reintroduce that
   * lie by implication, which is exactly what "Restored, and its triggers with
   * it" would do.
   */
  it('states that a restore re-enables nothing', () => {
    const { summary, detail } = describeWorkspaceEvent(
      event({
        type: 'pipeline.restored',
        resourceId: 'res_a',
        name: 'Nightly report',
        by: 'local',
      }),
    );

    expect(summary).toBe('Restored the pipeline Nightly report from archive');
    expect(detail).toBe('Restoring re-enables nothing — its triggers stay disabled either way.');
  });

  it('totals both halves of an import and names what it touched', () => {
    const { summary, detail } = describeWorkspaceEvent(
      event({
        type: 'import.applied',
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'studio/main',
        applied: [
          {
            path: 'pipelines/nightly.json',
            kind: 'pipeline',
            resourceId: 'res_a',
            action: 'created',
            versionMinted: true,
            versionContentUnverified: false,
          },
        ],
        archived: [{ resourceId: 'res_b', name: 'Old report', disabledTriggerIds: [] }],
        by: 'local',
      }),
    );

    // 1 applied + 1 archived — an import that archives is not reported as
    // having touched only the resources it wrote.
    expect(summary).toBe('Imported 2 resources from studio/main at 0123456');
    expect(detail).toBe('Applied “pipelines/nightly.json”. Archived “Old report”.');
  });

  /* An import that archived nothing must not render a dangling "Archived ." */
  it('omits the half of an import that did nothing', () => {
    expect(
      describeWorkspaceEvent(
        event({
          type: 'import.applied',
          head: '0123456789abcdef0123456789abcdef01234567',
          branch: 'studio/main',
          applied: [
            {
              path: 'connections/openai.json',
              kind: 'connection',
              resourceId: 'res_c',
              action: 'updated',
              versionMinted: false,
              versionContentUnverified: false,
            },
          ],
          archived: [],
          by: 'local',
        }),
      ).detail,
    ).toBe('Applied “connections/openai.json”.');
  });

  /**
   * `from` is the CAS expected-previous active and is `null` on the FIRST
   * publish. A template that interpolated it regardless would put the word
   * "null" — or an empty gap — in front of an operator reading a deploy history.
   */
  it('calls the first publish the first publish, rather than replacing nothing', () => {
    const { summary, detail } = describeWorkspaceEvent(
      event({
        type: 'pipeline.published',
        pipeline: 'res_a',
        from: null,
        to: 'pv_2',
        commit: 'fedcba9876543210fedcba9876543210fedcba98',
        blob: 'blob_1',
        by: 'local',
      }),
    );

    expect(summary).toBe('Published a new active version of pipeline res_a');
    expect(detail).toBe('Version pv_2, from commit fedcba9 — the first publish.');
  });

  it('names the version a later publish replaced', () => {
    expect(
      describeWorkspaceEvent(
        event({
          type: 'pipeline.published',
          pipeline: 'res_a',
          from: 'pv_2',
          to: 'pv_3',
          commit: 'fedcba9876543210fedcba9876543210fedcba98',
          blob: 'blob_1',
          by: 'local',
        }),
      ).detail,
    ).toBe('Version pv_3, from commit fedcba9, replacing pv_2.');
  });

  /**
   * The union is closed and this renderer is exhaustive over it. The `never`
   * branch cannot be reached at RUNTIME — that is the point of it, and a
   * forgotten variant fails TYPECHECK rather than rendering a placeholder.
   *
   * What this adds on top of the typecheck is the SIXTH-VARIANT case, which the
   * typecheck alone does not cover: a variant added to `WorkspaceEventSchema`
   * and given a `case` here that returns an empty string would compile. So it
   * walks the schema's own option list, insists this file carries a fixture for
   * every variant the union admits, and describes each one — a new variant with
   * no fixture fails here, and a variant rendered as nothing fails too.
   */
  it('renders a non-empty summary for every variant of the closed union', () => {
    const fixtures: Record<WorkspaceEvent['type'], unknown> = {
      'repo.connected': {
        type: 'repo.connected',
        repoUrl: 'https://example.invalid/r.git',
        collabBranch: 'studio/main',
        by: 'local',
      },
      'pipeline.archived': {
        type: 'pipeline.archived',
        resourceId: 'res_a',
        name: 'P',
        disabledTriggerIds: [],
        by: 'local',
      },
      'pipeline.restored': {
        type: 'pipeline.restored',
        resourceId: 'res_a',
        name: 'P',
        by: 'local',
      },
      'import.applied': {
        type: 'import.applied',
        head: 'abcdef1234567890abcdef1234567890abcdef12',
        branch: 'studio/main',
        applied: [],
        archived: [{ resourceId: 'res_b', name: 'Q', disabledTriggerIds: [] }],
        by: 'local',
      },
      'pipeline.published': {
        type: 'pipeline.published',
        pipeline: 'res_a',
        from: null,
        to: 'pv_1',
        commit: 'abcdef1234567890abcdef1234567890abcdef12',
        blob: 'blob_1',
        by: 'local',
      },
    };

    const variants = WorkspaceEventSchema.options.map((option) => option.shape.type.value);
    expect(Object.keys(fixtures).sort()).toEqual([...variants].sort());

    for (const [type, payload] of Object.entries(fixtures)) {
      const { summary } = describeWorkspaceEvent(event(payload));
      expect(summary, `${type} rendered no summary`).not.toBe('');
    }
  });
});
