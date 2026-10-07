import type { RunState, VariableDef } from '@autonomy-studio/shared';

/*
 * When `RunVariables` and `RunGlobals` have something to show. Shared with the
 * run page, which says why in their place on its Variables tab, so the two
 * cannot disagree about when a section is absent.
 */

/** A pipeline's declared variables are shown: the version doc is loaded and
 * declares at least one. */
export function showsVariables(
  declared: readonly VariableDef[] | undefined,
): declared is readonly VariableDef[] {
  return declared !== undefined && declared.length > 0;
}

export type GlobalsOverlay =
  { ready: true; state: Pick<RunState, 'globals'> } | { ready: false; reason: string };

/** The globals the run read, sorted; none while the projection is unavailable. */
export function globalNames(overlay: GlobalsOverlay): string[] {
  if (!overlay.ready) return [];
  return Object.keys(overlay.state.globals).sort((a, b) => a.localeCompare(b, 'en'));
}
