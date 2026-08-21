import { describe, expect, it } from 'vitest';
import { CONNECTION_CONFIG_SCHEMAS } from '@autonomy-studio/shared';
import type { ConnectionKind } from '@autonomy-studio/shared';
import { createConnectorRegistry } from '../registry.js';
import type { Supervisor } from '../../workers/process-supervisor.js';

/**
 * #1175 — a refused connection config reads as a SENTENCE, for every kind.
 *
 * Zod 4's `error.message` is a pretty-printed JSON array, so every
 * `` `invalid X config: ${parsed.error.message}` `` put a multi-line blob where a
 * one-line fault belongs. `copy.ts` was converted to `formatZodIssues` first
 * (#1172); this pins the same property across the whole registry.
 *
 * Table-driven over `ConnectionKind` rather than over `Object.keys(...)`, and
 * typed `Record<ConnectionKind, …>` for the reason `CONNECTION_CONFIG_SCHEMAS`
 * itself gives: a new kind then fails to COMPILE here instead of silently
 * getting no assertion. `connection-config-ssot.test.ts`'s subject is schema
 * IDENTITY between shared and the adapters and it never calls
 * `testConnection` — this is a behavioural file, so it is its own.
 *
 * Each fixture is chosen to produce a KEYED issue (a named field, not a
 * whole-object refusal), because the field name is what makes the assertions
 * below discriminating: the JSON blob contains `"timeoutMs"` too, but never
 * `timeoutMs: `, and never without newlines.
 */
const INVALID_CONFIGS: Record<ConnectionKind, unknown> = {
  // Every field on the three LLM schemas and on `http` is `.optional()`, so `{}`
  // PARSES — feeding it would fall through to the secret gate (anthropic,
  // openai), to `ok: true` (http), or to a real network probe (ollama), and the
  // test would pass while proving nothing. A wrong-typed `timeoutMs` is the one
  // fault all four share.
  anthropic_api: { timeoutMs: 'soon' },
  openai_api: { timeoutMs: 'soon' },
  ollama: { timeoutMs: 'soon' },
  http: { timeoutMs: 'soon' },
  agent_cli: { command: '' },
  fs: { roots: [] },
  sqlite: { roots: ['/db'], path: '' },
  // An EMPTY host, not an absent one, deliberately: `''` is the shape a form
  // submits, and MEASURED on pg@8.23.0 it is also the shape that falls back to
  // `PGHOST`. This fixture is therefore the refusal AND the ambient-environment
  // guard, keyed on the field that names it.
  postgres: { host: '', database: 'app', user: 'app_ro', sslmode: 'require' },
};

/** The field each fixture above is refused ON — the issue's `path`. */
const FAULTED_FIELD: Record<ConnectionKind, string> = {
  anthropic_api: 'timeoutMs',
  openai_api: 'timeoutMs',
  ollama: 'timeoutMs',
  http: 'timeoutMs',
  agent_cli: 'command',
  fs: 'roots',
  sqlite: 'path',
  postgres: 'host',
};

/**
 * The exact sentence prefix each adapter names its config with. Asserted as a
 * PREFIX (not merely "contains"), because that is the one thing no other refusal
 * on these paths can satisfy: a secret-gate refusal, a network error and an
 * `ok: true` all fail here, which is what stops a fixture that stopped being
 * invalid from passing quietly.
 */
const REFUSAL_PREFIX: Record<ConnectionKind, string> = {
  anthropic_api: 'invalid anthropic_api connection config: ',
  openai_api: 'invalid openai_api connection config: ',
  ollama: 'invalid ollama connection config: ',
  http: 'invalid http connection config: ',
  agent_cli: 'invalid agent_cli connection config: ',
  fs: 'invalid fs connection config: ',
  sqlite: 'invalid sqlite connection config: ',
  postgres: 'invalid postgres connection config: ',
};

const KINDS = Object.keys(CONNECTION_CONFIG_SCHEMAS) as ConnectionKind[];

/**
 * A supervisor that REFUSES to be used, rather than an empty `{} as Supervisor`.
 *
 * No adapter's `testConnection` touches the supervisor today — `agent_cli`'s
 * says so in its own comment (spawning a CLI to probe a connection would be an
 * unsafe, costly side effect, so it asserts a valid config only). But nothing
 * pinned that, and an empty cast would let a future `testConnection` reach for
 * it and get `undefined` mid-assertion instead of naming the problem. Throwing
 * makes the invariant this table depends on fail loudly the day it stops
 * holding. [NITPICK, review of #1184]
 */
const supervisor = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `testConnection must not touch the supervisor (reached \`${String(property)}\`)`,
      );
    },
  },
) as Supervisor;

describe('#1175 a refused connection config reads as one line', () => {
  const registry = createConnectorRegistry({ supervisor });

  it('has a fixture for every kind in the registry', () => {
    // The compiler already forbids a MISSING kind; this catches the other
    // direction — a fixture for a kind the registry no longer has.
    expect(Object.keys(INVALID_CONFIGS).sort()).toEqual([...registry.keys()].sort());
    expect(KINDS.sort()).toEqual([...registry.keys()].sort());
  });

  it.each(KINDS)('%s refuses an invalid config with a formatted sentence', async (kind) => {
    // Asserted, not `!`-away: a kind the registry has stopped carrying should
    // say so here rather than surface as a `TypeError` on `.testConnection`.
    // [NITPICK, review of #1184]
    const adapter = registry.get(kind);
    if (!adapter) throw new Error(`no adapter registered for kind '${kind}'`);

    const result = await adapter.testConnection(
      INVALID_CONFIGS[kind] as Record<string, unknown>,
      null,
    );

    expect(result.ok).toBe(false);
    const error = result.error ?? '';

    // Reached the Zod branch at all, and named the config an operator can act on.
    expect(error.startsWith(REFUSAL_PREFIX[kind])).toBe(true);

    // The defect itself: a blob spans lines, a sentence does not.
    expect(error).not.toContain('\n');

    // `formatZodIssues` renders `path: message`. The blob carries the field name
    // too (inside `"path": [ … ]`), so the colon-space is what distinguishes them.
    expect(error).toContain(`${FAULTED_FIELD[kind]}: `);

    // No JSON structure left over. These keys are Zod 4's blob shape.
    expect(error).not.toContain('"code"');
    expect(error).not.toContain('"path"');
    expect(error).not.toContain('[');
  });
});
