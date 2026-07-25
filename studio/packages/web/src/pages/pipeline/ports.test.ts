import { describe, expect, it } from 'vitest';
import { EdgeOnSchema } from '@autonomy-studio/shared';
import { DRAWN_EDGE_CONDITION, SOURCE_PORT_ID, TARGET_PORT_ID } from './ports';
import { OPERATIONAL_CONDITIONS } from './edgeCondition';

/**
 * U6b — the port contract, pinned where it is cheap.
 *
 * These look small because the failures they prevent are silent: an edge
 * declaring a `sourceHandle` no handle has is simply not rendered by React Flow
 * (no error, no warning, no line on the canvas), and an unauthorable
 * `DRAWN_EDGE_CONDITION` would make every DRAWN edge fail the save gate — after
 * the operator drew it.
 */

describe('canvas ports', () => {
  it('gives the two ports DISTINCT non-empty ids', () => {
    // React Flow resolves `sourceHandle`/`targetHandle` by id within a node; two
    // ports sharing one would make the pair ambiguous the moment U19 adds more.
    expect(TARGET_PORT_ID).not.toBe(SOURCE_PORT_ID);
    expect(TARGET_PORT_ID.length).toBeGreaterThan(0);
    expect(SOURCE_PORT_ID.length).toBeGreaterThan(0);
  });

  it('draws edges on a condition the engine actually accepts', () => {
    // Not just "some string": the drawn condition has to survive `EdgeOnSchema`,
    // or every connection authors a doc the #444 write gate refuses.
    expect(DRAWN_EDGE_CONDITION.on).not.toBe('branch');
    expect(EdgeOnSchema.safeParse(DRAWN_EDGE_CONDITION.on).success).toBe(true);
    expect(OPERATIONAL_CONDITIONS).toContain(DRAWN_EDGE_CONDITION.on);
  });
});
