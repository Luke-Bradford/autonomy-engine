import { describe, expect, it } from 'vitest';
import { ConnectionKindSchema } from '../schemas/connection.js';
import {
  CONNECTION_CONFIG_SCHEMAS,
  CONNECTION_KINDS,
  CONNECTION_SECRET_USE,
  agentConnectionConfigSchema,
  connectionConfigAdvisory,
  connectionConfigSchema,
  fsConnectionConfigSchema,
  looksAbsolutePath,
  CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS,
  isNonOverridableConnectionConfigKey,
  ROOT_CONFINED_CONNECTION_KINDS,
  sqliteConnectionConfigSchema,
  postgresConnectionConfigSchema,
} from './connection-config.js';

describe('connection config catalog', () => {
  it('covers every kind, and nothing that is not a kind', () => {
    // The `Record<ConnectionKind, …>` type makes a MISSING kind a compile
    // error; this catches the other direction (a stale key left behind when a
    // kind is renamed or removed), which the type cannot.
    expect(Object.keys(CONNECTION_CONFIG_SCHEMAS).sort()).toEqual(
      [...ConnectionKindSchema.options].sort(),
    );
    expect(Object.keys(CONNECTION_SECRET_USE).sort()).toEqual(
      [...ConnectionKindSchema.options].sort(),
    );
    expect(CONNECTION_KINDS).toEqual(ConnectionKindSchema.options);
  });

  it('accepts a representative config for each kind', () => {
    const samples: Record<(typeof CONNECTION_KINDS)[number], Record<string, unknown>> = {
      anthropic_api: { model: 'claude-opus-5', anthropicVersion: '2023-06-01' },
      openai_api: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' },
      agent_cli: { command: 'claude', args: ['-p'], timeoutMs: 60_000 },
      http: { baseUrl: 'https://example.test', headers: { accept: 'application/json' } },
      fs: { roots: ['/tmp/workspace'], maxBytes: 1024 },
      sqlite: { roots: ['/tmp/workspace'], path: '/tmp/workspace/app.db' },
      postgres: {
        host: 'db.example.test',
        database: 'app',
        user: 'app_ro',
        sslmode: 'verify-full',
      },
    };
    for (const kind of CONNECTION_KINDS) {
      expect(connectionConfigSchema(kind).safeParse(samples[kind]).success).toBe(true);
    }
  });

  it('still refuses the shapes each adapter refuses', () => {
    expect(connectionConfigSchema('agent_cli').safeParse({}).success).toBe(false); // command
    expect(connectionConfigSchema('fs').safeParse({ roots: [] }).success).toBe(false); // min(1)
    expect(
      agentConnectionConfigSchema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: '([', resetWindowSeconds: 60 },
      }).success,
    ).toBe(false); // an un-compilable pattern is still refused at the boundary
  });

  describe('the postgres config (#1189 M10 slice 1)', () => {
    const valid = {
      host: 'db.example.test',
      port: 5432,
      database: 'app',
      user: 'app_ro',
      sslmode: 'require',
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
    };

    it('accepts every §2.6 key', () => {
      expect(postgresConnectionConfigSchema.safeParse(valid).success).toBe(true);
    });

    it.each(['host', 'database', 'user'])(
      'refuses an ABSENT %s, because pg would read the ambient environment for it',
      (key) => {
        const { [key]: _dropped, ...rest } = valid as Record<string, unknown>;
        void _dropped;
        expect(postgresConnectionConfigSchema.safeParse(rest).success).toBe(false);
      },
    );

    it.each(['host', 'database', 'user'])('refuses an EMPTY %s for the same reason', (key) => {
      // MEASURED on pg@8.23.0: '' is not "the empty host", it is "no host
      // supplied", and pg falls back to PGHOST/PGDATABASE/PGUSER. An empty
      // string must be as refused as an absent key or the guard has a hole in
      // exactly the shape a form submits.
      expect(postgresConnectionConfigSchema.safeParse({ ...valid, [key]: '' }).success).toBe(false);
    });

    it('refuses a missing sslmode — there is no safe default to manufacture', () => {
      const { sslmode: _dropped, ...rest } = valid;
      void _dropped;
      expect(postgresConnectionConfigSchema.safeParse(rest).success).toBe(false);
    });

    it('refuses the libpq modes this vocabulary deliberately omits', () => {
      // `prefer`/`allow` downgrade to plaintext invisibly; `verify-ca` needs a
      // CA key §2.6 does not define. Each is refused rather than quietly
      // treated as something else.
      for (const mode of ['prefer', 'allow', 'verify-ca', 'yes']) {
        expect(postgresConnectionConfigSchema.safeParse({ ...valid, sslmode: mode }).success).toBe(
          false,
        );
      }
    });

    it('refuses a port outside the TCP range, and a non-integer one', () => {
      expect(postgresConnectionConfigSchema.safeParse({ ...valid, port: 0 }).success).toBe(false);
      expect(postgresConnectionConfigSchema.safeParse({ ...valid, port: 65_536 }).success).toBe(
        false,
      );
      expect(postgresConnectionConfigSchema.safeParse({ ...valid, port: 5432.5 }).success).toBe(
        false,
      );
    });

    it('refuses a non-positive timeout on either axis', () => {
      expect(
        postgresConnectionConfigSchema.safeParse({ ...valid, connectTimeoutMs: 0 }).success,
      ).toBe(false);
      expect(
        postgresConnectionConfigSchema.safeParse({ ...valid, statementTimeoutMs: -1 }).success,
      ).toBe(false);
    });

    it('fixes the connection IDENTITY and TRANSPORT against per-dispatch override', () => {
      // The security boundary this kind is the first to need: an overridable
      // host sends a DECRYPTED password to a server the connection's owner
      // never named, and an overridable sslmode strips what protects it.
      for (const key of ['host', 'port', 'database', 'user', 'sslmode']) {
        expect(isNonOverridableConnectionConfigKey('postgres', key)).toBe(true);
      }
    });

    it('leaves the two timeouts tunable per dispatch', () => {
      expect(isNonOverridableConnectionConfigKey('postgres', 'connectTimeoutMs')).toBe(false);
      expect(isNonOverridableConnectionConfigKey('postgres', 'statementTimeoutMs')).toBe(false);
    });

    it('is not root-confined — it addresses a server, not a file', () => {
      expect(ROOT_CONFINED_CONNECTION_KINDS.has('postgres')).toBe(false);
    });
  });

  it('leaves the ABSOLUTE-root check to the server, deliberately', () => {
    // `node:path`'s platform-aware `isAbsolute` cannot live in a browser-safe
    // package, so this schema owns the SHAPE and `connectors/fs.ts` refines it.
    // Asserted rather than left implicit: if someone later adds the check here,
    // the server's refine becomes dead code and this says where to look.
    // The form is NOT left blind by this — `connectionConfigAdvisory` below
    // carries the warning that the schema cannot.
    expect(fsConnectionConfigSchema.safeParse({ roots: ['relative/path'] }).success).toBe(true);
  });

  describe('connectionConfigAdvisory', () => {
    it('says nothing about a config the kind accepts', () => {
      expect(connectionConfigAdvisory('fs', { roots: ['/tmp'] })).toBeNull();
      expect(connectionConfigAdvisory('agent_cli', { command: 'claude' })).toBeNull();
    });

    it('reports what the schema refuses', () => {
      expect(connectionConfigAdvisory('agent_cli', {})).toMatch(/command/);
    });

    it('reports a RELATIVE fs root, which the shared schema cannot', () => {
      // The whole reason this function exists rather than a bare `safeParse`:
      // the absolute-root check is the server's (`node:path`), so without this
      // clause the one path-safety-relevant key in the catalog would be the
      // only one the form said nothing about.
      expect(fsConnectionConfigSchema.safeParse({ roots: ['relative/path'] }).success).toBe(true);
      expect(connectionConfigAdvisory('fs', { roots: ['relative/path'] })).toMatch(
        /every fs root must be an absolute path \(relative\/path\)/,
      );
    });

    it('never warns about a path the server would accept', () => {
      // Permissive on purpose — a false alarm is worse than a quiet miss here,
      // because the server check runs regardless.
      expect(looksAbsolutePath('/var/tmp')).toBe(true);
      expect(looksAbsolutePath('C:\\Users\\me')).toBe(true);
      expect(looksAbsolutePath('relative/path')).toBe(false);
      expect(looksAbsolutePath('./relative')).toBe(false);
    });
  });
});

describe('#1119 M4 — the sqlite store connection', () => {
  it('is APPENDED to the kind enum, never inserted', () => {
    // `ConnectionsPage` seeds a new connection with `CONNECTION_KINDS[0]`, and
    // an e2e pins that first kind by asserting its fields render. A kind added
    // at the front would silently change the default kind of every new
    // connection; this is the cheap assertion that says so.
    expect(CONNECTION_KINDS[0]).toBe('anthropic_api');
    expect(CONNECTION_KINDS[CONNECTION_KINDS.length - 1]).toBe('sqlite');
  });

  it('needs both an allowlist and a path', () => {
    expect(sqliteConnectionConfigSchema.safeParse({ path: '/db/app.db' }).success).toBe(false);
    expect(sqliteConnectionConfigSchema.safeParse({ roots: ['/db'] }).success).toBe(false);
    expect(sqliteConnectionConfigSchema.safeParse({ roots: [], path: '/db/app.db' }).success).toBe(
      false,
    );
  });

  it('spells the write posture as `writable`, so absent means read-only', () => {
    // The inversion is the point (see the schema docblock): the authoring form
    // omits an unchecked optional boolean, so a `readonly` key defaulting true
    // would render an UNCHECKED "readonly" box on a read-only connection. With
    // `writable`, absent renders as unchecked AND means not-writable.
    const parsed = sqliteConnectionConfigSchema.parse({ roots: ['/db'], path: '/db/app.db' });
    expect(parsed.writable).toBeUndefined();
    expect(
      sqliteConnectionConfigSchema.safeParse({ roots: ['/db'], path: '/db/app.db', readonly: true })
        .success,
    ).toBe(true);
    // ...and `readonly` is not a key this schema knows: it parses (unknown keys
    // are stripped, as everywhere in this catalog) but carries no posture.
    expect(
      'readonly' in
        sqliteConnectionConfigSchema.parse({ roots: ['/db'], path: '/db/app.db', readonly: true }),
    ).toBe(false);
  });

  it('warns about a relative root and a relative path, naming which', () => {
    expect(connectionConfigAdvisory('sqlite', { roots: ['rel'], path: '/db/app.db' })).toContain(
      'every sqlite root must be an absolute path (rel)',
    );
    expect(connectionConfigAdvisory('sqlite', { roots: ['/db'], path: 'app.db' })).toContain(
      "path: 'app.db' is relative",
    );
    expect(connectionConfigAdvisory('sqlite', { roots: ['/db'], path: '/db/app.db' })).toBeNull();
  });
});

describe('#1119 M4 — config keys no per-dispatch override may set', () => {
  it('covers every kind, and nothing that is not a kind', () => {
    expect(Object.keys(CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS).sort()).toEqual(
      [...ConnectionKindSchema.options].sort(),
    );
  });

  it('protects the path-confinement allowlist on every root-confined kind', () => {
    // The invariant this table exists for: an allowlist the confined party can
    // rewrite is not an allowlist. Derived from ROOT_CONFINED_CONNECTION_KINDS
    // rather than spelled per kind, so a future root-confined kind cannot be
    // added with `roots` left overridable.
    for (const kind of ROOT_CONFINED_CONNECTION_KINDS) {
      expect(isNonOverridableConnectionConfigKey(kind, 'roots')).toBe(true);
    }
    expect(isNonOverridableConnectionConfigKey('sqlite', 'path')).toBe(true);
  });

  it('protects the store write PERMISSION before anything consumes it', () => {
    // `writable` has no consumer until M5's copy sink. Pinned now precisely
    // because it has none: an overridable permission is only observably wrong
    // once something reads it, by which point a node could already have granted
    // itself write access to a store its owner marked read-only.
    expect(isNonOverridableConnectionConfigKey('sqlite', 'writable')).toBe(true);
  });

  it('leaves ordinary settings overridable', () => {
    expect(isNonOverridableConnectionConfigKey('anthropic_api', 'model')).toBe(false);
    expect(isNonOverridableConnectionConfigKey('http', 'baseUrl')).toBe(false);
    expect(isNonOverridableConnectionConfigKey('fs', 'maxBytes')).toBe(false);
  });
});
