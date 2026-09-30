/**
 * #1395 OR4 — how a run's version reads: `v3` for a saved version, `debug 3`
 * for a DEBUG version (the editor's unsaved draft). Debug versions number in
 * their own sequence, so a bare `v3` on a debug run would name a DIFFERENT,
 * saved version. One function, so every surface that shows a run's version
 * says it the same way.
 */
export function versionLabel(version: number, debug: boolean): string {
  return debug ? `debug ${String(version)}` : `v${String(version)}`;
}
