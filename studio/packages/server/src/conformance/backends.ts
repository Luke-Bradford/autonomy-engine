import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer, type ColumnSource } from 'hyparquet-writer';
import pg from 'pg';
import type { DatasetColumn } from '@autonomy-studio/shared';
import { DEFAULT_POSTGRES_PORT } from '@autonomy-studio/shared';
import { liveSuiteMustRun } from '../connectors/__tests__/live-postgres.js';
import { buildXlsx, type CellSpec as Cell } from '../connectors/__tests__/xlsx-fixtures.js';
import type { Harness } from './harness.js';

/**
 * #1574 OR39 — the REAL backends the matrix runs against, and the one canonical
 * table every copy cell moves.
 *
 * Each store plants the canonical rows in its OWN native representation (a
 * typed SQL column, an Excel boolean cell, a JSON number, a Parquet INT64) and
 * reads a sink back with a reader that is NOT studio's — `better-sqlite3`, `pg`,
 * `JSON.parse`, `hyparquet` — so a cell cannot pass by a writer and a reader
 * agreeing on the same mistake.
 */

/** The canonical row: one column per type the matrix checks. */
export interface CanonicalRow {
  id: number;
  name: string;
  score: number;
  active: boolean;
  born: string;
  note: string | null;
}

/** Unicode on purpose: combining-free accents, CJK and an astral-plane emoji. */
export const CANONICAL_ROWS: readonly CanonicalRow[] = [
  { id: 1, name: 'Zoë', score: 1.5, active: true, born: '2001-02-03', note: 'first' },
  { id: 2, name: '東京', score: -2.25, active: false, born: '1999-12-31', note: null },
  { id: 3, name: 'rocket 🚀', score: 0, active: true, born: '2024-02-29', note: 'leap' },
];

export const CANONICAL_COLUMNS: DatasetColumn[] = [
  { name: 'id', type: 'integer', nullable: false },
  { name: 'name', type: 'string', nullable: false },
  { name: 'score', type: 'number', nullable: false },
  { name: 'active', type: 'boolean', nullable: false },
  { name: 'born', type: 'date', nullable: false },
  { name: 'note', type: 'string', nullable: true },
];

/** The Copy mapping that moves the canonical table, every column coerced to its type. */
export const CANONICAL_MAPPING = CANONICAL_COLUMNS.map((c) => ({
  source: c.name,
  sink: c.name,
  type: c.type,
}));

/**
 * The BAD-ROW fixture: three rows whose `id` is text, and the middle one is not
 * an integer. A copy with `onError: fail` (the default) must land rows 1 and 3
 * and count row 2 in `rowsFailed`.
 */
export const BAD_ROW_IDS = ['1', 'x', '3'] as const;

/** What one fixture asks a source to plant. */
export type SourceFixture = 'canonical' | 'badRow' | 'empty';

/** A dataset a source planted, ready for `createDataset`. */
export interface PlantedDataset {
  readonly kind: 'delimited' | 'excel' | 'json' | 'jsonl' | 'parquet' | 'table' | 'query';
  readonly config: Record<string, unknown>;
  /**
   * Columns the copy must map as another type, because the store has no type
   * for them: SQLite has no DATE, and a textual date becomes a `date` only
   * through a dataset `dateFormat`, which a table dataset has no field for.
   */
  readonly mapAs?: Readonly<Record<string, DatasetColumn['type']>>;
}

/** The Copy mapping for a planted source, honouring its `mapAs`. */
export function mappingFor(planted: PlantedDataset): typeof CANONICAL_MAPPING {
  return CANONICAL_MAPPING.map((m) => ({ ...m, type: planted.mapAs?.[m.source] ?? m.type }));
}

export interface Store {
  readonly connectionId: string;
  /** Plant a source fixture under a unique name. */
  plant(fixture: SourceFixture): Promise<PlantedDataset>;
}

export interface SinkStore extends Store {
  /** A new, empty sink address for the canonical columns (a typed table where the store has tables). */
  sinkAddress(): Promise<PlantedDataset>;
  /** Read a sink address back, in canonical form, ordered by `id`. */
  readBack(address: PlantedDataset): Promise<CanonicalRow[]>;
  /** The dataset parameter, if any, that makes one sink dataset name many files. */
  readonly perItemParam?: string;
}

let counter = 0;
const unique = (prefix: string): string => `${prefix}_${process.pid}_${++counter}`;

// ---------------------------------------------------------------------------
// Canonical form

/** Read one stored value back as the canonical type, whatever the store held. */
function canonical(raw: Record<string, unknown>): CanonicalRow {
  const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v));
  const bool = (v: unknown): boolean =>
    v === true || v === 1 || v === 1n || v === 'true' || v === '1';
  const date = (v: unknown): string =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  const nullable = (v: unknown): string | null =>
    v === null || v === undefined || v === '' ? null : String(v);
  return {
    id: num(raw['id']),
    name: String(raw['name']),
    score: num(raw['score']),
    active: bool(raw['active']),
    born: date(raw['born']),
    note: nullable(raw['note']),
  };
}

const byId = (rows: CanonicalRow[]): CanonicalRow[] => [...rows].sort((a, b) => a.id - b.id);

/** The canonical rows a fixture holds, as values of `id` (bad-row ids stay text). */
function fixtureRows(fixture: SourceFixture): Record<string, unknown>[] {
  if (fixture === 'empty') return [];
  if (fixture === 'canonical') return CANONICAL_ROWS.map((r) => ({ ...r }));
  return BAD_ROW_IDS.map((id, i) => ({ ...CANONICAL_ROWS[i]!, id }));
}

// ---------------------------------------------------------------------------
// File stores, on one fs connection

function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A minimal RFC 4180 parser, independent of studio's. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const FILE_COLUMNS = CANONICAL_COLUMNS.map((c) => c.name);

/** How the text formats spell a date; Excel and Parquet carry typed dates instead. */
const DATE_FORMAT = 'yyyy-MM-dd';

export type FileKind = 'delimited' | 'excel' | 'json' | 'jsonl' | 'parquet';

/** The dataset config each file kind needs beyond its path. */
function fileConfig(kind: FileKind, path: string): Record<string, unknown> {
  switch (kind) {
    case 'delimited':
      return { path, header: true, dateFormat: DATE_FORMAT };
    case 'excel':
      return { path, sheet: 'Data', header: true };
    case 'json':
    case 'jsonl':
      return { path, dateFormat: DATE_FORMAT };
    case 'parquet':
      return { path };
  }
}

function writeSourceFile(kind: FileKind, path: string, rows: Record<string, unknown>[]): void {
  switch (kind) {
    case 'delimited': {
      const lines = [FILE_COLUMNS.join(',')];
      for (const r of rows) lines.push(FILE_COLUMNS.map((c) => csvField(r[c])).join(','));
      writeFileSync(path, lines.join('\n') + '\n');
      return;
    }
    case 'json':
      writeFileSync(path, JSON.stringify(rows));
      return;
    case 'jsonl':
      writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
      return;
    case 'excel': {
      const header: Cell[] = FILE_COLUMNS.map((c) => ({ kind: 'inline', text: c }));
      const cell = (c: string, v: unknown): Cell => {
        if (v === null) return { kind: 'blank' };
        if (c === 'born') return { kind: 'isoDate', iso: String(v) };
        if (typeof v === 'number') return { kind: 'number', value: v };
        if (typeof v === 'boolean') return { kind: 'boolean', value: v };
        return { kind: 'inline', text: String(v) };
      };
      const body = rows.map((r) => FILE_COLUMNS.map((c) => cell(c, r[c])));
      writeFileSync(path, buildXlsx({ sheets: [{ name: 'Data', rows: [header, ...body] }] }));
      return;
    }
    case 'parquet': {
      const textIds = rows.some((r) => typeof r['id'] === 'string');
      const col = (name: string, type: ColumnSource['type'], map = (v: unknown) => v) => ({
        name,
        type,
        data: rows.map((r) => (r[name] === null ? null : map(r[name]))),
      });
      const columnData: ColumnSource[] = [
        textIds ? col('id', 'STRING', String) : col('id', 'INT64', (v) => BigInt(v as number)),
        col('name', 'STRING'),
        col('score', 'DOUBLE'),
        col('active', 'BOOLEAN'),
        // A typed instant at UTC midnight: `date` keeps its day.
        col('born', 'TIMESTAMP', (v) => new Date(`${String(v)}T00:00:00Z`)),
        col('note', 'STRING'),
      ];
      writeFileSync(path, new Uint8Array(parquetWriteBuffer({ columnData })));
      return;
    }
  }
}

async function readSinkFile(kind: FileKind, path: string): Promise<CanonicalRow[]> {
  switch (kind) {
    case 'delimited': {
      const [header, ...body] = parseCsv(readFileSync(path, 'utf8'));
      return byId(
        body.map((cells) =>
          canonical(Object.fromEntries((header ?? []).map((h, i) => [h, cells[i]]))),
        ),
      );
    }
    case 'json':
      return byId((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]).map(canonical));
    case 'jsonl':
      return byId(
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => canonical(JSON.parse(l) as Record<string, unknown>)),
      );
    case 'parquet': {
      const bytes = readFileSync(path);
      const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
      return byId(rows.map(canonical));
    }
    case 'excel':
      throw new Error('excel is read-only in studio: there is no excel sink');
  }
}

/** One `fs` connection, writable, rooted at a fresh folder. */
export async function fsStore(h: Harness, kind: FileKind): Promise<SinkStore> {
  const root = join(h.tmpDir, unique(`fs-${kind}`));
  mkdirSync(root, { recursive: true });
  const connectionId = await h.createConnection({
    kind: 'fs',
    config: { roots: [root], writable: true },
  });
  const ext = { delimited: 'csv', excel: 'xlsx', json: 'json', jsonl: 'jsonl', parquet: 'parquet' }[
    kind
  ];
  return {
    connectionId,
    perItemParam: 'path',
    async plant(fixture) {
      const path = join(root, `${unique('src')}.${ext}`);
      writeSourceFile(kind, path, fixtureRows(fixture));
      return { kind, config: fileConfig(kind, path) };
    },
    async sinkAddress() {
      return { kind, config: fileConfig(kind, join(root, `${unique('sink')}.${ext}`)) };
    },
    readBack(address) {
      return readSinkFile(kind, String(address.config['path']));
    },
  };
}

// ---------------------------------------------------------------------------
// sqlite

export async function sqliteStore(h: Harness): Promise<SinkStore> {
  const root = join(h.tmpDir, unique('sqlite'));
  mkdirSync(root, { recursive: true });
  const path = join(root, 'store.db');
  new Database(path).close();
  const connectionId = await h.createConnection({
    kind: 'sqlite',
    config: { roots: [root], path, writable: true },
  });
  const exec = (fn: (db: Database.Database) => void): void => {
    const db = new Database(path);
    try {
      fn(db);
    } finally {
      db.close();
    }
  };
  const createTyped = (db: Database.Database, table: string, idType: string): void => {
    db.exec(
      `CREATE TABLE "${table}" (id ${idType}, name TEXT, score REAL, active, born TEXT, note TEXT)`,
    );
  };
  return {
    connectionId,
    async plant(fixture) {
      const table = unique('src');
      exec((db) => {
        createTyped(db, table, fixture === 'badRow' ? 'TEXT' : 'INTEGER');
        const insert = db.prepare(
          `INSERT INTO "${table}" (id, name, score, active, born, note) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const r of fixtureRows(fixture)) {
          // SQLite has no BOOLEAN: the source spells it as text, the one form
          // `boolean` coerces from (a bare 0/1 is refused, never guessed).
          insert.run(r['id'], r['name'], r['score'], String(r['active']), r['born'], r['note']);
        }
      });
      return { kind: 'table', config: { table }, mapAs: { born: 'string' } };
    },
    async sinkAddress() {
      const table = unique('sink');
      exec((db) => createTyped(db, table, 'INTEGER'));
      return { kind: 'table', config: { table } };
    },
    async readBack(address) {
      let rows: Record<string, unknown>[] = [];
      exec((db) => {
        rows = db.prepare(`SELECT * FROM "${String(address.config['table'])}"`).all() as Record<
          string,
          unknown
        >[];
      });
      return byId(rows.map(canonical));
    },
  };
}

// ---------------------------------------------------------------------------
// postgres — the CI service container, or a developer's own via the same env

const LIVE_HOST = process.env['STUDIO_TEST_POSTGRES_HOST'];

/** Whether the postgres cells can run here. Under CI a missing host is a FAILURE, not a skip. */
export function postgresAvailable(): boolean {
  if (LIVE_HOST !== undefined) return true;
  if (liveSuiteMustRun(process.env)) {
    throw new Error(
      'the conformance matrix needs postgres under CI: set STUDIO_TEST_POSTGRES_HOST (see .github/workflows/studio-ci.yml)',
    );
  }
  return false;
}

export function postgresConfig(): { config: Record<string, unknown>; password: string } {
  return {
    config: {
      host: LIVE_HOST ?? '127.0.0.1',
      port: Number(process.env['STUDIO_TEST_POSTGRES_PORT'] ?? DEFAULT_POSTGRES_PORT),
      database: process.env['STUDIO_TEST_POSTGRES_DATABASE'] ?? 'postgres',
      user: process.env['STUDIO_TEST_POSTGRES_USER'] ?? 'postgres',
      sslmode: 'disable',
      writable: true,
    },
    password: process.env['STUDIO_TEST_POSTGRES_PASSWORD'] ?? '',
  };
}

async function withPg<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const { config, password } = postgresConfig();
  const client = new pg.Client({
    host: String(config['host']),
    port: Number(config['port']),
    database: String(config['database']),
    user: String(config['user']),
    password,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const schemas: string[] = [];

/** Drop every schema `postgresStore` made; a suite's `afterAll`. */
export async function dropPostgresSchemas(): Promise<void> {
  if (schemas.length === 0) return;
  const all = schemas.splice(0);
  await withPg(async (c) => {
    for (const s of all) await c.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  });
}

/** A postgres store in a schema of its own, dropped by `dropPostgresSchemas`. */
export async function postgresStore(h: Harness): Promise<SinkStore> {
  const schema = unique('or39');
  await withPg((c) => c.query(`CREATE SCHEMA "${schema}"`));
  schemas.push(schema);
  const { config, password } = postgresConfig();
  const connectionId = await h.createConnection({ kind: 'postgres', config, secret: password });
  const createTyped = (table: string, idType: string): string =>
    `CREATE TABLE "${schema}"."${table}" (id ${idType}, name text, score double precision, active boolean, born date, note text)`;
  return {
    connectionId,
    async plant(fixture) {
      const table = unique('src');
      await withPg(async (c) => {
        await c.query(createTyped(table, fixture === 'badRow' ? 'text' : 'integer'));
        for (const r of fixtureRows(fixture)) {
          await c.query(
            `INSERT INTO "${schema}"."${table}" (id, name, score, active, born, note) VALUES ($1, $2, $3, $4, $5, $6)`,
            [r['id'], r['name'], r['score'], r['active'], r['born'], r['note']],
          );
        }
      });
      return { kind: 'table', config: { schema, table } };
    },
    async sinkAddress() {
      const table = unique('sink');
      await withPg((c) => c.query(createTyped(table, 'integer')));
      return { kind: 'table', config: { schema, table } };
    },
    async readBack(address) {
      const rows = await withPg(
        async (c) =>
          (
            await c.query(
              `SELECT id, name, score, active, born::text AS born, note FROM "${schema}"."${String(address.config['table'])}"`,
            )
          ).rows as Record<string, unknown>[],
      );
      return byId(rows.map(canonical));
    },
  };
}

// ---------------------------------------------------------------------------
// Copy endpoints

/** A query endpoint: a table planted as usual, read through `SELECT *`. */
function asQuery(store: SinkStore, qualify: (config: Record<string, unknown>) => string): Store {
  return {
    connectionId: store.connectionId,
    async plant(fixture) {
      const table = await store.plant(fixture);
      return {
        ...table,
        kind: 'query',
        config: { sql: `SELECT * FROM ${qualify(table.config)}` },
      };
    },
  };
}

export type EndpointStore = Store & Partial<Pick<SinkStore, 'sinkAddress' | 'readBack' | 'perItemParam'>>;

/**
 * How the matrix opens each copy endpoint (`copy-endpoints.ts`). The copy
 * matrix's guard compares these KEYS with the derived endpoints, so an endpoint
 * the catalog gains without an entry here turns the suite red.
 */
export const ENDPOINT_STORES: Record<string, (h: Harness) => Promise<EndpointStore>> = {
  'fs:delimited': (h) => fsStore(h, 'delimited'),
  'fs:excel': (h) => fsStore(h, 'excel'),
  'fs:json': (h) => fsStore(h, 'json'),
  'fs:jsonl': (h) => fsStore(h, 'jsonl'),
  'fs:parquet': (h) => fsStore(h, 'parquet'),
  'sqlite:table': (h) => sqliteStore(h),
  'sqlite:query': async (h) => asQuery(await sqliteStore(h), (c) => `"${String(c['table'])}"`),
  'postgres:table': (h) => postgresStore(h),
  'postgres:query': async (h) =>
    asQuery(await postgresStore(h), (c) => `"${String(c['schema'])}"."${String(c['table'])}"`),
};

/** Whether an endpoint needs the live postgres. */
export const needsPostgres = (endpoint: string): boolean => endpoint.startsWith('postgres:');
