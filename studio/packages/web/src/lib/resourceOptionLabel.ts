import {
  CONNECTION_KIND_LABELS,
  DATASET_KIND_LABELS,
  type ConnectionKind,
  type DatasetKind,
} from '@autonomy-studio/shared';

/**
 * #1396 — how a connection or dataset reads in a picker: its name, then its
 * kind's display name ("Orders (Delimited text (CSV))" rather than the stored
 * `delimited`). One format for every picker that offers one.
 */
export function connectionOptionLabel(c: { name: string; kind: ConnectionKind }): string {
  return `${c.name} (${CONNECTION_KIND_LABELS[c.kind]})`;
}

export function datasetOptionLabel(d: { name: string; kind: DatasetKind }): string {
  return `${d.name} (${DATASET_KIND_LABELS[d.kind]})`;
}

/**
 * #1436 — a kind as the forms name it, in the plural: "SQLite connections",
 * "Database table datasets". Plural so no article ever precedes a name, which
 * read "a Excel workbook dataset" for every vowel-initial kind. `kind` stays the
 * stored identifier everywhere else; an unknown one is shown as itself.
 */
export function kindPlural(kind: string, noun: 'connection' | 'dataset'): string {
  const labels: Readonly<Record<string, string>> =
    noun === 'connection' ? CONNECTION_KIND_LABELS : DATASET_KIND_LABELS;
  return `${labels[kind] ?? kind} ${noun}s`;
}

/**
 * #1477 OR29 slice 5c — where a connection points, for the second line of a
 * picker option: a Postgres host and database, a SQLite file, a file system's
 * folders, a base URL, an agent's command. `undefined` when there is nothing to
 * show, so the option is one line rather than an empty second one.
 *
 * `config` is a record of unknowns (the shared schema is adapter-specific), and
 * an imported or hand-edited row can hold anything, so every field is read
 * defensively: a value of the wrong type is skipped, never thrown on. A picker
 * that cannot render because one row is odd hides every other connection too.
 */
export function connectionLocation(c: {
  kind: ConnectionKind;
  config: Record<string, unknown>;
}): string | undefined {
  const text = (key: string): string | undefined => {
    const value = c.config[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  switch (c.kind) {
    case 'postgres': {
      const host = text('host');
      if (host === undefined) return undefined;
      const port = c.config.port;
      const at = typeof port === 'number' ? `${host}:${port}` : host;
      const database = text('database');
      return database === undefined ? at : `${at}/${database}`;
    }
    case 'sqlite':
      return text('path');
    case 'fs': {
      const roots = c.config.roots;
      if (!Array.isArray(roots)) return undefined;
      const folders = roots.filter((r): r is string => typeof r === 'string' && r !== '');
      return folders.length === 0 ? undefined : folders.join(', ');
    }
    case 'agent_cli':
      // The executable alone: its arguments are a separate field (`args`).
      return text('command');
    case 'http':
    case 'anthropic_api':
    case 'openai_api':
    case 'ollama':
      return urlLocation(text('baseUrl'));
  }
}

/**
 * A base URL as a location: scheme, host and path. User info and the query are
 * dropped, since either can carry a credential and a picker line is on screen
 * for anyone looking. A value that does not parse is not shown at all, rather
 * than shown unvetted.
 */
function urlLocation(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // `localhost:11434` parses as scheme `localhost:` with no host.
  if (url.host === '') return undefined;
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}
