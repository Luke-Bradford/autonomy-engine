import { describe, expect, it } from 'vitest';
import { runDetailPath, runLinkLabel } from './runPath';

describe('runDetailPath', () => {
  it('encodes the id exactly once, for the route that decodes exactly once', () => {
    expect(runDetailPath('run_abc')).toBe('/monitor/runs/run_abc');
    expect(runDetailPath('run a+b')).toBe('/monitor/runs/run%20a%2Bb');
  });
});

/**
 * #1240 — the four run-link accessible names had three shapes and no shared
 * home, so the WCAG 2.5.3 rule they each depend on was four hand-checks.
 *
 * The cases below are the four LIVE call sites, pinned to the exact strings
 * they rendered before the helper existed. That is what makes this a
 * refactor: if the helper ever changes a name, one of these reds naming the
 * site it broke.
 */
describe('runLinkLabel', () => {
  it('names an ACT with the control’s own visible text as the lead', () => {
    // RunsPage's Watch cell — visible text `Watch`.
    expect(runLinkLabel('Watch', 'run_abc')).toBe('Watch run run_abc');
    // TriggersPage's notice — visible text `Watch live →`, arrow included.
    expect(runLinkLabel('Watch live →', 'run_9')).toBe('Watch live → run run_9');
  });

  it('names a RELATIONSHIP with the relation as the lead', () => {
    // RunDetailPage's two lineage rows — visible text is the id itself.
    expect(runLinkLabel('Source', 'run_0')).toBe('Source run run_0');
    expect(runLinkLabel('Parent', 'run_p')).toBe('Parent run run_p');
    // NodeActivityPanel's Child runs list — the fifth site #1240's table missed.
    expect(runLinkLabel('Child', 'run_c1')).toBe('Child run run_c1');
  });

  /**
   * The containment property the helper exists to hold, stated as a test
   * rather than as a runtime check, BECAUSE it holds by construction: an act
   * site passes its visible text as the lead (which the name starts with),
   * and a relation site's visible text is the id (which the name ends with).
   * There is no third shape in which the name could omit either.
   */
  it('contains its lead and its run id, which is what 2.5.3 tests', () => {
    for (const lead of ['Watch', 'Watch live →', 'Source', 'Parent', 'Child']) {
      const name = runLinkLabel(lead, 'run_x');
      expect(name.includes(lead)).toBe(true);
      expect(name.includes('run_x')).toBe(true);
    }
  });
});
