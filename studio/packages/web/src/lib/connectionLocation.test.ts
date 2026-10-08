import { describe, expect, it } from 'vitest';
import { connectionLocation } from './resourceOptionLabel';

describe('connectionLocation', () => {
  it('reads each kind where it points', () => {
    expect(
      connectionLocation({ kind: 'postgres', config: { host: 'db.internal', database: 'sales' } }),
    ).toBe('db.internal/sales');
    expect(
      connectionLocation({
        kind: 'postgres',
        config: { host: 'db.internal', port: 6432, database: 'sales' },
      }),
    ).toBe('db.internal:6432/sales');
    expect(
      connectionLocation({ kind: 'sqlite', config: { roots: ['/srv'], path: '/srv/w.sqlite' } }),
    ).toBe('/srv/w.sqlite');
    expect(connectionLocation({ kind: 'fs', config: { roots: ['/in', '/out'] } })).toBe(
      '/in, /out',
    );
    expect(connectionLocation({ kind: 'http', config: { baseUrl: 'https://api.test' } })).toBe(
      'https://api.test',
    );
    expect(
      connectionLocation({ kind: 'ollama', config: { baseUrl: 'http://localhost:11434' } }),
    ).toBe('http://localhost:11434');
    expect(connectionLocation({ kind: 'agent_cli', config: { command: 'claude' } })).toBe('claude');
  });

  it('drops user info and the query from a base URL: either can hold a credential', () => {
    expect(
      connectionLocation({
        kind: 'http',
        config: { baseUrl: 'https://user:pw@api.test/v1?key=abc#x' },
      }),
    ).toBe('https://api.test/v1');
    expect(connectionLocation({ kind: 'http', config: { baseUrl: 'not a url' } })).toBeUndefined();
    expect(
      connectionLocation({ kind: 'ollama', config: { baseUrl: 'localhost:11434' } }),
    ).toBeUndefined();
  });

  it('has no line for a connection with nothing to point at', () => {
    expect(connectionLocation({ kind: 'http', config: {} })).toBeUndefined();
    expect(connectionLocation({ kind: 'anthropic_api', config: {} })).toBeUndefined();
    expect(connectionLocation({ kind: 'fs', config: { roots: [] } })).toBeUndefined();
  });

  it('does not throw on a config that does not match its kind', () => {
    // `config` is a record of unknowns: an imported or hand-edited row can
    // hold anything, and a picker must still render.
    expect(connectionLocation({ kind: 'postgres', config: { host: 5 } })).toBeUndefined();
    expect(connectionLocation({ kind: 'fs', config: { roots: 'nope' } })).toBeUndefined();
    expect(connectionLocation({ kind: 'fs', config: { roots: ['/a', 7] } })).toBe('/a');
    expect(connectionLocation({ kind: 'sqlite', config: { path: '' } })).toBeUndefined();
  });
});
