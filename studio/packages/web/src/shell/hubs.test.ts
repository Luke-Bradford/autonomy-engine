import { describe, expect, it } from 'vitest';
import { HUBS, hubById, sectionLabel } from './hubs';

describe('hubById', () => {
  it('finds a hub by id', () => {
    expect(hubById('manage')?.label).toBe('Manage');
  });

  it('is undefined for no id at all', () => {
    expect(hubById(undefined)).toBeUndefined();
  });
});

describe('sectionLabel', () => {
  it('resolves the label a hub declares for a path', () => {
    expect(sectionLabel('/manage/triggers')).toBe('Triggers');
  });

  /**
   * THROWS rather than degrading, and that is the whole point of the function.
   *
   * `routes.tsx` calls it while building `ROUTES`, i.e. at module evaluation —
   * so an unknown path takes the app down at boot with the path in the message.
   * A soft fallback (`?? ''`) would instead ship a route whose breadcrumb is
   * silently missing a crumb, which is precisely the "renders, but wrong" class
   * of failure the crumb labels were centralised to prevent. A section route
   * whose path no hub declares is also unreachable from the pane, so it is a
   * real defect either way.
   */
  it('throws for a path no hub declares, naming the path', () => {
    expect(() => sectionLabel('/manage/nope')).toThrow('/manage/nope');
  });

  /** Every section in the SSOT resolves — the function's own preconditions. */
  it('resolves every section the hubs declare', () => {
    for (const hub of HUBS) {
      for (const section of hub.sections) {
        expect(sectionLabel(section.path)).toBe(section.label);
      }
    }
  });

  /**
   * A hub whose pane renders CUSTOM content (`PANE_CONTENT` in
   * `SecondaryPane.tsx`) shows `sections[0]` only — U4's Factory Resources tree
   * uses it as the group header. So a second Author section would not merely
   * look wrong, it would silently disappear from the pane's navigation, which
   * is how `/manage/triggers` became unreachable between U2 and U3.
   *
   * This pins the constraint where it can FAIL rather than vanish: whoever adds
   * an Author section has to decide how the tree renders it, and this test is
   * what tells them.
   */
  it('keeps Author at exactly one section, which its custom pane renders', () => {
    expect(hubById('author')!.sections).toHaveLength(1);
  });
});
