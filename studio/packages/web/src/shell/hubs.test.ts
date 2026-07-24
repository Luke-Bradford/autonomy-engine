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
});
