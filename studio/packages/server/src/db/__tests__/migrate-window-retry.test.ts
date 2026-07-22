import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #5 S11c — the 0021 table-recreates on an UPGRADING (non-fresh) DB.
 *
 * Replays every committed migration BELOW 0021 directly onto a fresh
 * in-memory DB so real window rows + events exist before the recreate runs
 * (the `migrate-containers-column.test.ts` convention), then hands the SAME
 * connection to `runMigrations`. What must hold:
 *
 * - every `window_events` row survives WITH ITS `seq` — `seq` is the FOLD
 *   ORDER (`rebuildWindowStatus` scans by it), so a renumbering copy would
 *   permute rebuilds;
 * - post-migration appends get FRESH seqs above the copied ones
 *   (`sqlite_sequence` advanced past the explicit rowids);
 * - the projection row survives with `origin` intact and the new columns
 *   defaulted honestly (`attempt` 0 — no pre-S11c window ever retried;
 *   `next_attempt_at_ms` NULL);
 * - the widened CHECKs accept the new status/event types and still REFUSE
 *   unknown ones.
 */
describe('0021 migration: window retry recreates on an upgrading (non-fresh) DB', () => {
  function upgradingDb() {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = OFF'); // as runMigrations holds it for recreates
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const pre0021 = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0021')
      .sort();
    for (const file of pre0021) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      sqlite
        .prepare('INSERT INTO __migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    }
    sqlite
      .prepare(
        `INSERT INTO triggers
           (id, owner_id, name, pipeline_version_id, params, mode, schedule, webhook, concurrency, run_windows, enabled, created_at, updated_at)
         VALUES ('trig_1', NULL, 'T', NULL, '{}', 'manual', NULL, NULL, '{"policy":"queue"}', NULL, 1, 1, 1)`,
      )
      .run();
    // A settled window: created + runCreated + failed, seqs 1..3, and a
    // backfill-origin projection row — the pre-S11c shape at its richest.
    const insertEvent = sqlite.prepare(
      `INSERT INTO window_events (seq, trigger_id, config_epoch, window_start, type, payload, created_at)
       VALUES (?, 'trig_1', 'ep1', '2026-07-01T00:00:00.000Z', ?, ?, 1)`,
    );
    insertEvent.run(
      1,
      'window.created',
      '{"windowEnd":"2026-07-01T01:00:00.000Z","frequency":"hour","interval":1,"startTime":"2026-07-01T00:00:00.000Z","origin":"backfill"}',
    );
    insertEvent.run(2, 'window.runCreated', '{"runId":"run_1","via":"fire"}');
    insertEvent.run(3, 'window.failed', '{"runId":"run_1","runStatus":"failure"}');
    sqlite
      .prepare(
        `INSERT INTO tumbling_window_state
           (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, updated_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'failed', 'run_1', 'backfill', 1)`,
      )
      .run();
    return sqlite;
  }

  it('preserves rows, seq order, and origin; defaults the new columns honestly', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0021_s11c_window_retry.sql');

    // Events survived with their EXACT seqs (fold order intact).
    const events = sqlite
      .prepare('SELECT seq, type FROM window_events ORDER BY seq')
      .all() as Array<{ seq: number; type: string }>;
    expect(events).toEqual([
      { seq: 1, type: 'window.created' },
      { seq: 2, type: 'window.runCreated' },
      { seq: 3, type: 'window.failed' },
    ]);

    // A fresh append takes a NEW seq above the copied ones — the
    // AUTOINCREMENT sequence advanced past the explicit rowids.
    sqlite
      .prepare(
        `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T01:00:00.000Z', 'window.retryDue', '{"attempt":1}', 2)`,
      )
      .run();
    const maxSeq = sqlite.prepare('SELECT MAX(seq) AS s FROM window_events').get() as {
      s: number;
    };
    expect(maxSeq.s).toBeGreaterThan(3);

    // The projection row survived, origin intact, new columns defaulted.
    const row = sqlite
      .prepare(
        `SELECT status, run_id, origin, attempt, next_attempt_at_ms
         FROM tumbling_window_state WHERE trigger_id = 'trig_1'`,
      )
      .get() as {
      status: string;
      run_id: string;
      origin: string;
      attempt: number;
      next_attempt_at_ms: number | null;
    };
    expect(row).toEqual({
      status: 'failed',
      run_id: 'run_1',
      origin: 'backfill',
      attempt: 0,
      next_attempt_at_ms: null,
    });
  });

  it('the widened CHECKs accept the new vocabulary and still refuse unknowns', () => {
    const sqlite = upgradingDb();
    runMigrations(sqlite);

    // New status accepted.
    sqlite
      .prepare(
        `INSERT INTO tumbling_window_state
           (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, attempt, next_attempt_at_ms, updated_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z', 'retry_pending', NULL, 'live', 1, 999, 1)`,
      )
      .run();
    // New event types accepted.
    sqlite
      .prepare(
        `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T01:00:00.000Z', 'window.retryScheduled', '{}', 1)`,
      )
      .run();
    // Unknowns still refused (the CHECKs are closed lists, not dropped).
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO tumbling_window_state
             (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, updated_at)
           VALUES ('trig_1', 'ep1', '2026-07-01T02:00:00.000Z', '2026-07-01T03:00:00.000Z', 'exploded', NULL, 'live', 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
           VALUES ('trig_1', 'ep1', '2026-07-01T02:00:00.000Z', 'window.exploded', '{}', 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);

    // The partial UNIQUE single-fire backstop was recreated, not dropped: a
    // second window.created for the SAME key must refuse.
    sqlite
      .prepare(
        `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T02:00:00.000Z', 'window.created', '{}', 1)`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
           VALUES ('trig_1', 'ep1', '2026-07-01T02:00:00.000Z', 'window.created', '{}', 1)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
