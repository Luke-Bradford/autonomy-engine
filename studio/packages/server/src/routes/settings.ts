import type { FastifyInstance } from 'fastify';
import type { AppSettings, MasterKeyStatus } from '@autonomy-studio/shared';

export interface SettingsRoutesOptions {
  /**
   * Resolved ONCE at boot by `resolveMasterKey`, so it is a registration
   * argument rather than a `fastify.decorate` — the same shape `versionRoutes`
   * uses for the build manifest. A process fact that cannot change under a
   * running server has nothing to gain from an ambient decoration, and taking
   * it as a required option makes "the status was never set" unrepresentable
   * instead of a runtime branch nobody can reach.
   */
  masterKey: MasterKeyStatus;
}

/**
 * `GET /api/settings` — the Settings page's read-only view of the process
 * (U15 slice 2, #1094).
 *
 * ## What it exists to say
 *
 * `resolveMasterKey` mints a key when it finds neither `AUTONOMY_MASTER_KEY`
 * nor a key file, and warns — loudly, and only to the log — that the file it
 * just wrote now encrypts every secret at rest and must be backed up or those
 * secrets are lost for good. An operator running this as a launchd service or
 * a container never reads that log. This route is how that sentence reaches
 * the person it is addressed to.
 *
 * ## SECURITY
 *
 * NOT owner-scoped, like its neighbour `GET /api/quota` and unlike
 * `/api/monitor/*`: the master key is a fact about the HOST PROCESS, not a row
 * belonging to a principal, so there is nothing to authorize against (and
 * `auth/principal.ts` supplies a single fixed local principal regardless).
 *
 * It carries the key's PROVENANCE and no key material: `masterKeyStatusOf` is
 * the only thing that builds the payload, and it names both fields explicitly
 * rather than spreading the resolution — so a field added to
 * `MasterKeyResolution` cannot arrive here by itself. `settings.test.ts` pins
 * the response's key set, and `MasterKeyStatusSchema` (which the browser parses
 * the response through) would strip anything else regardless.
 *
 * The absolute `keyFilePath` IS disclosed, deliberately: "back up this file" is
 * the advisory's only actionable content, and without the path the operator
 * would have to go read the server log — the exact thing this route replaces.
 *
 * Two widenings worth naming, neither new in kind. The server binds
 * `HOST=0.0.0.0` when the operator asks it to, which makes this path readable
 * off-box — the same posture as every other unauthenticated route here (and
 * the default is `127.0.0.1`). And the default path sits under `homedir()`, so
 * disclosing it also discloses the OS username. Both are accepted: the path IS
 * the actionable content, and a status that would not name the file cannot ask
 * anyone to back it up.
 *
 * No `Cache-Control: no-store`. #925 is about responses whose BODY is a bearer
 * credential; this one grants nothing, and no route in this server sets that
 * header today.
 */
export function settingsRoutes(fastify: FastifyInstance, opts: SettingsRoutesOptions): void {
  /*
   * `satisfies`, not `AppSettingsSchema.parse`. The value is constructed here
   * from a typed object, so parsing it on the way out would be a third
   * definition of a shape that can only ever fail by drifting from itself —
   * and `errors.ts` maps a `ZodError` to HTTP 400, i.e. it would report a
   * server-side shape bug as though the client had sent bad input. The same
   * argument `routes/quota.ts` makes for its own outbound payload.
   */
  const settings = { masterKey: opts.masterKey } satisfies AppSettings;
  fastify.get('/api/settings', () => settings);
}
