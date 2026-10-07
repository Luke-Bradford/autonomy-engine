import type { Pipeline } from '@autonomy-studio/shared';

/** Every folder in use, once each, in name order. */
export function folderNamesOf(pipelines: readonly Pipeline[]): string[] {
  return [...new Set(pipelines.flatMap((p) => (p.folder === null ? [] : [p.folder])))].sort(
    (a, b) => a.localeCompare(b, 'en'),
  );
}

/**
 * The folder a typed name files into: an EXISTING folder's own spelling when it
 * matches ignoring case, else the name as typed. Folders group by exact name,
 * so `ops` typed beside `Ops` would otherwise split one folder in two — the
 * same reason annotations refuse case-only duplicates.
 */
export function existingFolderSpelling(folderNames: readonly string[], typed: string): string {
  return folderNames.find((f) => f.toLowerCase() === typed.toLowerCase()) ?? typed;
}
