import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewTrigger, type Node } from '@autonomy-studio/shared';
import { connections } from '../../db/schema.js';
import { createConnection, deleteConnection } from '../../repo/connections.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, getTrigger, updateTrigger } from '../../repo/triggers.js';
import type { Db } from '../../repo/types.js';
import {
  regateTriggersForConnection,
  unreadyConnectionsForVersion,
} from '../connection-readiness.js';
import { freshDb } from '../../repo/__tests__/helpers.js';

/** An `llm_call` node (its catalog `connectionKinds` includes `ollama` +
 * `anthropic_api`) carrying `connectionId`. `config: {}` passes the write gate. */
function llmNode(id: string, connectionId?: string): Node {
  return { id, type: 'llm_call', config: {}, connectionId, position: { x: 0, y: 0 } };
}

/** An `if` node — `connectionKinds: []` (never binds a connection). A stray
 * `connectionId` on it must never block enable (it is never dispatch-checked). */
function ifNode(id: string, connectionId?: string): Node {
  return {
    id,
    type: 'if',
    config: { condition: '${params.go}' },
    connectionId,
    position: { x: 0, y: 0 },
  };
}

function versionWithNodes(db: Db, ownerId: string, nodes: Node[]): string {
  const pipeline = createPipeline(db, { ownerId, name: 'P' });
  return createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [
      { name: 'go', type: 'boolean', required: false },
      { name: 'conn', type: 'string', required: false },
    ],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  }).id;
}

/** A credential-less `ollama` connection ⟹ `secretStatus: not_required`, enabled
 * ⟹ READY; `ollama` is in `llm_call`'s connectionKinds. */
function readyConnection(db: Db, ownerId = 'local'): string {
  return createConnection(db, { ownerId, name: 'C', kind: 'ollama', config: {}, secretRef: null })
    .id;
}

/** An `anthropic_api` connection with no secret ⟹ `secretStatus: needs_secret`. */
function needsSecretConnection(db: Db, ownerId = 'local'): string {
  return createConnection(db, {
    ownerId,
    name: 'C',
    kind: 'anthropic_api',
    config: {},
    secretRef: null,
  }).id;
}

describe('unreadyConnectionsForVersion (#3 G8b enable-time gate)', () => {
  it('returns [] when every referenced connection is READY', () => {
    const { db } = freshDb();
    const connId = readyConnection(db);
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', connId)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([]);
  });

  it('flags a needs_secret connection', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', connId)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([
      { connectionId: connId, reason: 'needs_secret' },
    ]);
  });

  it('flags a disabled connection', () => {
    const { db } = freshDb();
    const connId = readyConnection(db);
    // No enable-toggle write path yet (G8b-2); flip the flag directly.
    db.update(connections).set({ enabled: false }).where(eq(connections.id, connId)).run();
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', connId)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([
      { connectionId: connId, reason: 'disabled' },
    ]);
  });

  it('flags a literal reference to a connection that does not exist as missing', () => {
    const { db } = freshDb();
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', 'conn_does_not_exist')]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([
      { connectionId: 'conn_does_not_exist', reason: 'missing' },
    ]);
  });

  it('folds a CROSS-OWNER connection to missing (never confirms another owner’s connection)', () => {
    const { db } = freshDb();
    // A perfectly READY connection owned by someone else — must NOT read as ready
    // for `local`; it folds to `missing`, enumeration-resistant like dispatch.
    const foreign = readyConnection(db, 'other');
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', foreign)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([
      { connectionId: foreign, reason: 'missing' },
    ]);
  });

  it('SKIPS a ${}-dynamic connectionId (unresolvable statically — the dispatch gate’s domain)', () => {
    const { db } = freshDb();
    // Dynamic ref that would resolve to nothing — still not flagged at enable.
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', '${params.conn}')]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([]);
  });

  it('SKIPS a stray connectionId on a connection-less activity (never dispatch-checked)', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    // An `if` node (connectionKinds []) carrying a not-ready connectionId — the
    // executor never resolves it, so it must not block enable.
    const versionId = versionWithNodes(db, 'local', [ifNode('n1', connId)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([]);
  });

  it('SKIPS a required-connection node that carries NO connectionId (structural, not readiness)', () => {
    const { db } = freshDb();
    // An `llm_call` with no connectionId fails dispatch as CONNECTION_MISSING —
    // the unbound/structural domain, not the secret-readiness gate’s concern.
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', undefined)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([]);
  });

  it('DEDUPES: two nodes referencing the same unready connection report it once', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const versionId = versionWithNodes(db, 'local', [llmNode('n1', connId), llmNode('n2', connId)]);
    expect(unreadyConnectionsForVersion(db, 'local', versionId)).toEqual([
      { connectionId: connId, reason: 'needs_secret' },
    ]);
  });

  it('returns [] for an absent version id (never the guard for an unbound trigger)', () => {
    const { db } = freshDb();
    expect(unreadyConnectionsForVersion(db, 'local', 'pv_nope')).toEqual([]);
  });

  it('accepts a NULL owner (a null-owner trigger scope), mirroring resolveConnection', () => {
    const { db } = freshDb();
    // A shared (null-owner) connection resolves for a null-owner scope; an OWNED
    // connection folds to `missing` for that scope (the resolveConnection fold).
    const shared = createConnection(db, {
      ownerId: null,
      name: 'Shared',
      kind: 'anthropic_api',
      config: {},
      secretRef: null,
    }).id;
    const owned = needsSecretConnection(db, 'someone');
    const vShared = versionWithNodes(db, 'local', [llmNode('n1', shared)]);
    const vOwned = versionWithNodes(db, 'local', [llmNode('n1', owned)]);
    expect(unreadyConnectionsForVersion(db, null, vShared)).toEqual([
      { connectionId: shared, reason: 'needs_secret' },
    ]);
    expect(unreadyConnectionsForVersion(db, null, vOwned)).toEqual([
      { connectionId: owned, reason: 'missing' },
    ]);
  });
});

/** Bind a trigger to a version, referencing `connId` on an `llm_call` node. */
function triggerOn(
  db: Db,
  ownerId: string | null,
  versionId: string | null,
  enabled = true,
): string {
  const input: NewTrigger = {
    ownerId,
    name: 'T',
    pipelineVersionId: versionId,
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled,
  };
  return createTrigger(db, input).id;
}

function versionRef(db: Db, ownerId: string, connId: string): string {
  return versionWithNodes(db, ownerId, [llmNode('n1', connId)]);
}

describe('regateTriggersForConnection (#3 G8b-2 reverse-gate)', () => {
  it('disables an enabled trigger bound to a version referencing a now-unready connection', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const tId = triggerOn(db, 'local', versionRef(db, 'local', connId));
    expect(regateTriggersForConnection(db, connId)).toEqual([tId]);
    expect(getTrigger(db, tId)!.enabled).toBe(false);
  });

  it('is a NO-OP when the connection is still READY (dependents stay enabled)', () => {
    const { db } = freshDb();
    const connId = readyConnection(db);
    const tId = triggerOn(db, 'local', versionRef(db, 'local', connId));
    expect(regateTriggersForConnection(db, connId)).toEqual([]);
    expect(getTrigger(db, tId)!.enabled).toBe(true);
  });

  it('leaves a trigger whose version does NOT reference the connection untouched', () => {
    const { db } = freshDb();
    const changed = needsSecretConnection(db);
    const other = readyConnection(db);
    const tId = triggerOn(db, 'local', versionRef(db, 'local', other));
    expect(regateTriggersForConnection(db, changed)).toEqual([]);
    expect(getTrigger(db, tId)!.enabled).toBe(true);
  });

  it('never re-reports or re-writes an ALREADY-disabled dependent (no updatedAt churn)', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const off = updateTrigger(db, triggerOn(db, 'local', versionRef(db, 'local', connId)), {
      enabled: false,
    })!;
    expect(regateTriggersForConnection(db, connId)).toEqual([]);
    expect(getTrigger(db, off.id)!.updatedAt).toBe(off.updatedAt);
  });

  it('skips an UNBOUND (null-version) trigger — it can never fire, never a dependent', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const tId = triggerOn(db, 'local', null);
    expect(regateTriggersForConnection(db, connId)).toEqual([]);
    expect(getTrigger(db, tId)!.enabled).toBe(true);
  });

  it('is idempotent (a second call disables nothing new)', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const tId = triggerOn(db, 'local', versionRef(db, 'local', connId));
    expect(regateTriggersForConnection(db, connId)).toEqual([tId]);
    expect(regateTriggersForConnection(db, connId)).toEqual([]);
  });

  it('SKIPS a ${}-dynamic connectionId (dispatch-gate domain — parity with the enable gate)', () => {
    const { db } = freshDb();
    const connId = needsSecretConnection(db);
    const vId = versionWithNodes(db, 'local', [llmNode('n1', '${params.conn}')]);
    const tId = triggerOn(db, 'local', vId);
    expect(regateTriggersForConnection(db, connId)).toEqual([]);
    expect(getTrigger(db, tId)!.enabled).toBe(true);
  });

  it('a SHARED (null-owner) unready connection disables dependents across MULTIPLE owners', () => {
    const { db } = freshDb();
    const shared = createConnection(db, {
      ownerId: null,
      name: 'Shared',
      kind: 'anthropic_api',
      config: {},
      secretRef: null,
    }).id;
    const tA = triggerOn(db, 'ownerA', versionRef(db, 'ownerA', shared));
    const tB = triggerOn(db, 'ownerB', versionRef(db, 'ownerB', shared));
    expect(regateTriggersForConnection(db, shared).sort()).toEqual([tA, tB].sort());
    expect(getTrigger(db, tA)!.enabled).toBe(false);
    expect(getTrigger(db, tB)!.enabled).toBe(false);
  });

  it('after a connection is DELETED, dependents fold to `missing` and are disabled', () => {
    const { db } = freshDb();
    const connId = readyConnection(db);
    const tId = triggerOn(db, 'local', versionRef(db, 'local', connId));
    deleteConnection(db, connId);
    expect(regateTriggersForConnection(db, connId)).toEqual([tId]);
    expect(getTrigger(db, tId)!.enabled).toBe(false);
  });

  it('an OWNED unready connection also disables an (import-smuggled) FOREIGN trigger — it folds to `missing`, still an unready reason, and is correct to disable', () => {
    const { db } = freshDb();
    // A connection owned by `ownerA`, needs_secret. `ownerB` has a trigger whose
    // version literally references it (a state the enable gate would refuse, but
    // an import path could smuggle in). From B's scope the connection folds to
    // `missing`, which matches — B genuinely cannot resolve A's private
    // connection, so disabling is correct.
    const owned = needsSecretConnection(db, 'ownerA');
    const foreign = triggerOn(db, 'ownerB', versionRef(db, 'ownerB', owned));
    expect(regateTriggersForConnection(db, owned)).toEqual([foreign]);
    expect(getTrigger(db, foreign)!.enabled).toBe(false);
  });
});
