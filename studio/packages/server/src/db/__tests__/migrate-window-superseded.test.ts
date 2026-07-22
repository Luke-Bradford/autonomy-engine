import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js';

/**
 * #5 S11d — the 0022 table-recreates on an UPGRADING (non-fresh) DB.
 *
 * Replays every committed migration BELOW 0022 onto a fresh in-memory DB so
 * real window rows + events exist before the recreate runs (the
 * `migrate-window-retry.test.ts` convention), then hands the SAME connection
 * to `runMigrations`. What must hold beyond 0021's own pins:
 *
 * - the projection copy carries 0021's `attempt`/`next_attempt_at_ms` — a
 *   copy list frozen at 0021's PRE-retry shape would silently reset a
 *   mid-retry window's budget count and stored due instant (the exact
 *   data-loss trap the planning review flagged);
 * - `window_events.seq` survives verbatim (fold order);
 * - the widened CHECKs accept `superseded`/`window.superseded` and still
 *   refuse unknowns.
 */
describe('0022 migration: window superseded recreates on an upgrading (non-fresh) DB', () => {
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
    const pre0022 = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name < '0022')
      .sort();
    for (const file of pre0022) {
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
    // A MID-RETRY window at its richest post-0021 shape: retry_pending with a
    // consumed attempt and a stored due instant — the columns 0022's copy
    // must carry.
    const insertEvent = sqlite.prepare(
      `INSERT INTO window_events (seq, trigger_id, config_epoch, window_start, type, payload, created_at)
       VALUES (?, 'trig_1', 'ep1', '2026-07-01T00:00:00.000Z', ?, ?, 1)`,
    );
    insertEvent.run(
      1,
      'window.created',
      '{"windowEnd":"2026-07-01T01:00:00.000Z","frequency":"hour","interval":1,"startTime":"2026-07-01T00:00:00.000Z"}',
    );
    insertEvent.run(2, 'window.runCreated', '{"runId":"run_1","via":"fire"}');
    insertEvent.run(
      3,
      'window.retryScheduled',
      '{"runId":"run_1","runStatus":"failure","attempt":2,"nextAttemptAt":"2026-07-01T02:00:00.000Z"}',
    );
    sqlite
      .prepare(
        `INSERT INTO tumbling_window_state
           (trigger_id, config_epoch, window_start, window_end, status, run_id, origin, attempt, next_attempt_at_ms, updated_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', 'retry_pending', NULL, 'backfill', 2, 1751338800000, 1)`,
      )
      .run();
    return sqlite;
  }

  it('preserves rows, seq order, origin AND the 0021 retry columns', () => {
    const sqlite = upgradingDb();

    const { applied } = runMigrations(sqlite);
    expect(applied).toContain('0022_s11d_window_superseded.sql');

    // Events survived with their EXACT seqs (fold order intact).
    const events = sqlite
      .prepare('SELECT seq, type FROM window_events ORDER BY seq')
      .all() as Array<{ seq: number; type: string }>;
    expect(events).toEqual([
      { seq: 1, type: 'window.created' },
      { seq: 2, type: 'window.runCreated' },
      { seq: 3, type: 'window.retryScheduled' },
    ]);

    // A fresh append takes a NEW seq above the copied ones.
    sqlite
      .prepare(
        `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T00:00:00.000Z', 'window.superseded', '{"currentEpoch":"ep2"}', 2)`,
      )
      .run();
    const maxSeq = sqlite.prepare('SELECT MAX(seq) AS s FROM window_events').get() as {
      s: number;
    };
    expect(maxSeq.s).toBeGreaterThan(3);

    // The projection row survived WITH its retry columns — the mid-retry
    // budget count and stored due instant are facts, not defaults.
    const row = sqlite
      .prepare(
        `SELECT status, run_id, origin, attempt, next_attempt_at_ms
         FROM tumbling_window_state WHERE trigger_id = 'trig_1'`,
      )
      .get() as {
      status: string;
      run_id: string | null;
      origin: string;
      attempt: number;
      next_attempt_at_ms: number | null;
    };
    expect(row).toEqual({
      status: 'retry_pending',
      run_id: null,
      origin: 'backfill',
      attempt: 2,
      next_attempt_at_ms: 1751338800000,
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
         VALUES ('trig_1', 'ep1', '2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z', 'superseded', NULL, 'live', 0, NULL, 1)`,
      )
      .run();
    // New event type accepted.
    sqlite
      .prepare(
        `INSERT INTO window_events (trigger_id, config_epoch, window_start, type, payload, created_at)
         VALUES ('trig_1', 'ep1', '2026-07-01T01:00:00.000Z', 'window.superseded', '{"currentEpoch":"ep2"}', 1)`,
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

    // The partial UNIQUE single-fire backstop was recreated, not dropped.
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
