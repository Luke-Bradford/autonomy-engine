import { PostgresSslModeSchema, type ConnectionKind } from '@autonomy-studio/shared';

/**
 * #1477 — paste-to-detect, the shortcut above the connection kind gallery:
 * the author pastes what they HAVE (a connection string, a URL, a path) and
 * the kind is inferred, with the fields it implies filled in. The kind stays
 * visible and editable on the form that opens; this only saves knowing the
 * vocabulary up front.
 */
export interface DetectedConnection {
  kind: ConnectionKind;
  config: Record<string, unknown>;
  /**
   * The postgres URL's password, for the form's write-only Secret field. It
   * never goes into `config`, which is stored and shown in the clear.
   */
  secret: string;
}

/** Files a SQLite connection opens directly. */
const SQLITE_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 'db3']);

/**
 * Data files: a path ending in one is a file, so the fs root is its folder.
 * Any other last segment is taken as the folder itself, so a folder with a
 * dot in its name is never widened to its parent. A guess either way: the
 * roots are on the form, and Test connection shows a wrong one.
 */
const DATA_FILE_EXTENSIONS = new Set([
  'csv',
  'tsv',
  'txt',
  'json',
  'jsonl',
  'ndjson',
  'parquet',
  'xlsx',
  'xls',
  'xml',
  'gz',
  'zip',
]);

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * What a pasted text describes, or `null` when it is none of the above.
 * Deliberately not inferred: the LLM kinds (an Ollama or OpenAI endpoint is
 * read as HTTP; the kind stays editable). A Windows path is read on any
 * platform; the server decides whether it is absolute where it runs.
 */
export function detectConnection(text: string): DetectedConnection | null {
  let value = text.trim();
  // Windows "Copy as path" wraps the path in double quotes.
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1).trim();
  }
  if (value === '' || /[\r\n]/.test(value)) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return fromPostgresUrl(value);
  if (scheme === 'http' || scheme === 'https') return fromHttpUrl(value);
  if (scheme === 'file') {
    const url = parseUrl(value);
    const path = url === null || url.host !== '' ? null : decode(url.pathname);
    // `file:///C:/data` has the pathname `/C:/data`.
    return path === null ? null : fromPath(path.replace(/^\/(?=[A-Za-z]:\/)/, ''));
  }
  return fromPath(value);
}

function fromPostgresUrl(value: string): DetectedConnection | null {
  const url = parseUrl(value);
  if (url === null) return null;
  const database = decode(url.pathname.replace(/^\//, ''));
  const user = decode(url.username);
  const secret = decode(url.password);
  // A stray `%` is not a value to guess at, least of all in a password.
  if (database === null || user === null || secret === null) return null;
  const config: Record<string, unknown> = {};
  // One host only: a multi-host list (`h1,h2`) or a socket URL (`postgres:///db`)
  // leaves Host for the author, and the form says it is required.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host !== '' && !host.includes(',')) config.host = host;
  if (url.port !== '') config.port = Number(url.port);
  if (database !== '') config.database = database;
  if (user !== '') config.user = user;
  const sslmode = PostgresSslModeSchema.safeParse(url.searchParams.get('sslmode'));
  if (sslmode.success) config.sslmode = sslmode.data;
  if (Object.keys(config).length === 0) return null;
  return { kind: 'postgres', config, secret };
}

function fromHttpUrl(value: string): DetectedConnection | null {
  const url = parseUrl(value);
  if (url === null || url.hostname === '') return null;
  // An http connection's secret is a Bearer token, so user info is dropped,
  // and so are the query and fragment (`?api_key=…`): the base URL is stored
  // and shown in the clear.
  return { kind: 'http', config: { baseUrl: `${url.origin}${url.pathname}` }, secret: '' };
}

function fromPath(value: string): DetectedConnection | null {
  const windows = WINDOWS_ABSOLUTE.test(value);
  if (!windows && !value.startsWith('/')) return null;
  const separators = windows ? /[\\/]+$/ : /\/+$/;
  const rootLength = windows ? 3 : 1;
  const path = value.length > rootLength ? value.replace(separators, '') : value;

  const cut = Math.max(path.lastIndexOf('/'), windows ? path.lastIndexOf('\\') : -1);
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const parent = cut < rootLength ? path.slice(0, rootLength) : path.slice(0, cut);

  if (SQLITE_EXTENSIONS.has(extension)) {
    return { kind: 'sqlite', config: { roots: [parent], path }, secret: '' };
  }
  const root = DATA_FILE_EXTENSIONS.has(extension) ? parent : path;
  return { kind: 'fs', config: { roots: [root] }, secret: '' };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
