import { describe, expect, it } from 'vitest';

import { freshDb } from './helpers.js';
import { createConnection } from '../connections.js';
import {
  getConnectionQuotaResetEpoch,
  recordConnectionQuotaExhaustion,
} from '../connection-quota.js';
import type { Db } from '../types.js';

/**
 * #2 L14c — the per-connection quota RESET-WINDOW repo. The proactive half of the
 * CLI/subscription quota primitive: the driver RECORDS an exhausted window, the
 * executor READS it to admission-gate dispatch. The load-bearing properties are
 * (1) an absent row is the fail-safe permissive `null`, and (2) the upsert takes
 * `MAX` so a longer window is never shortened and a replayed write is a no-op.
 */
function seedAgentCliConnection(db: Db): string {
  return createConnection(db, {
    ownerId: 'local',
    name: 'sub-cli',
    kind: 'agent_cli',
    config: {},
    secretRef: null,
  }).id;
}

describe('connection-quota repo (#2 L14c)', () => {
  it('returns null for a connection with no recorded window (fail-safe permissive)', () => {
    const { db } = freshDb();
    const connectionId = seedAgentCliConnection(db);
    expect(getConnectionQuotaResetEpoch(db, connectionId)).toBeNull();
  });

  it('records a window and reads it back', () => {
    const { db } = freshDb();
    const connectionId = seedAgentCliConnection(db);
    recordConnectionQuotaExhaustion(db, connectionId, 5_000, 1_000);
    expect(getConnectionQuotaResetEpoch(db, connectionId)).toBe(5_000);
  });

  it('upsert keeps the LATER reset epoch — a longer window is never shortened', () => {
    const { db } = freshDb();
    const connectionId = seedAgentCliConnection(db);
    recordConnectionQuotaExhaustion(db, connectionId, 9_000, 1_000);
    // A second exhaustion reports an EARLIER reset — must not move the window in.
    recordConnectionQuotaExhaustion(db, connectionId, 4_000, 2_000);
    expect(getConnectionQuotaResetEpoch(db, connectionId)).toBe(9_000);
  });

  it('upsert advances the window when a LATER reset arrives', () => {
    const { db } = freshDb();
    const connectionId = seedAgentCliConnection(db);
    recordConnectionQuotaExhaustion(db, connectionId, 4_000, 1_000);
    recordConnectionQuotaExhaustion(db, connectionId, 9_000, 2_000);
    expect(getConnectionQuotaResetEpoch(db, connectionId)).toBe(9_000);
  });

  it('re-recording the SAME window (a replayed/re-dispatched failure) is idempotent', () => {
    const { db } = freshDb();
    const connectionId = seedAgentCliConnection(db);
    recordConnectionQuotaExhaustion(db, connectionId, 7_000, 1_000);
    recordConnectionQuotaExhaustion(db, connectionId, 7_000, 1_000);
    expect(getConnectionQuotaResetEpoch(db, connectionId)).toBe(7_000);
  });

  it('windows are per-connection — one connection does not gate another', () => {
    const { db } = freshDb();
    const a = seedAgentCliConnection(db);
    const b = createConnection(db, {
      ownerId: 'local',
      name: 'sub-cli-2',
      kind: 'agent_cli',
      config: {},
      secretRef: null,
    }).id;
    recordConnectionQuotaExhaustion(db, a, 5_000, 1_000);
    expect(getConnectionQuotaResetEpoch(db, a)).toBe(5_000);
    expect(getConnectionQuotaResetEpoch(db, b)).toBeNull();
  });
});
