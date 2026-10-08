import { describe, expect, it } from 'vitest';
import { detectConnection } from './detectConnection';

describe('detectConnection (#1477 paste-to-detect)', () => {
  it('reads a postgres URL into its fields, the password into the secret only', () => {
    const d = detectConnection('postgres://etl:s3cr%40t@db.internal:6543/warehouse?sslmode=require');
    expect(d).toEqual({
      kind: 'postgres',
      config: {
        host: 'db.internal',
        port: 6543,
        database: 'warehouse',
        user: 'etl',
        sslmode: 'require',
      },
      secret: 's3cr@t',
    });
    expect(JSON.stringify(d!.config)).not.toContain('s3cr');
  });

  it('accepts postgresql://, leaves absent parts unset, and ignores a TLS mode studio lacks', () => {
    expect(detectConnection('postgresql://db.internal/sales?sslmode=prefer')).toEqual({
      kind: 'postgres',
      config: { host: 'db.internal', database: 'sales' },
      secret: '',
    });
  });

  it('decodes an encoded user and database, and unbrackets an IPv6 host', () => {
    expect(detectConnection('postgres://a%20b@[::1]/my%20db')).toEqual({
      kind: 'postgres',
      config: { host: '::1', database: 'my db', user: 'a b' },
      secret: '',
    });
  });

  it('leaves Host for the author on a multi-host or socket URL, and refuses a stray %', () => {
    expect(detectConnection('postgres://u@h1,h2/db')).toEqual({
      kind: 'postgres',
      config: { database: 'db', user: 'u' },
      secret: '',
    });
    expect(detectConnection('postgres:///db?host=/tmp')).toEqual({
      kind: 'postgres',
      config: { database: 'db' },
      secret: '',
    });
    expect(detectConnection('postgres://u:50%off@h/db')).toBeNull();
  });

  it('reads an http(s) URL as the base URL, dropping user info, query and fragment', () => {
    expect(detectConnection('https://api.example.com/v2/')).toEqual({
      kind: 'http',
      config: { baseUrl: 'https://api.example.com/v2/' },
      secret: '',
    });
    const d = detectConnection('https://bob:hunter2@api.example.com/v2');
    expect(d).toEqual({
      kind: 'http',
      config: { baseUrl: 'https://api.example.com/v2' },
      secret: '',
    });
    expect(JSON.stringify(d)).not.toContain('hunter2');
    expect(detectConnection('http://localhost:11434/v1?api_key=K#top')).toEqual({
      kind: 'http',
      config: { baseUrl: 'http://localhost:11434/v1' },
      secret: '',
    });
  });

  it('reads a SQLite file as its path, confined to its folder', () => {
    for (const ext of ['db', 'sqlite', 'sqlite3', 'db3']) {
      expect(detectConnection(`/srv/data/app.${ext}`)).toEqual({
        kind: 'sqlite',
        config: { roots: ['/srv/data'], path: `/srv/data/app.${ext}` },
        secret: '',
      });
    }
    expect(detectConnection('/app.db')).toEqual({
      kind: 'sqlite',
      config: { roots: ['/'], path: '/app.db' },
      secret: '',
    });
  });

  it('reads a folder as a file-system root, and a data file as its folder', () => {
    expect(detectConnection('/srv/landing/')).toEqual({
      kind: 'fs',
      config: { roots: ['/srv/landing'] },
      secret: '',
    });
    expect(detectConnection('/srv/landing/orders.CSV')).toEqual({
      kind: 'fs',
      config: { roots: ['/srv/landing'] },
      secret: '',
    });
    // A dot in a folder name does not make it a file: the root is not widened.
    expect(detectConnection('/srv/release-v1.2')).toEqual({
      kind: 'fs',
      config: { roots: ['/srv/release-v1.2'] },
      secret: '',
    });
  });

  it('reads Windows paths, quoted ones, and file:// URLs', () => {
    expect(detectConnection('"C:\\data\\in\\orders.xlsx"')).toEqual({
      kind: 'fs',
      config: { roots: ['C:\\data\\in'] },
      secret: '',
    });
    expect(detectConnection('D:/stores/app.sqlite')).toEqual({
      kind: 'sqlite',
      config: { roots: ['D:/stores'], path: 'D:/stores/app.sqlite' },
      secret: '',
    });
    expect(detectConnection('C:\\')).toEqual({
      kind: 'fs',
      config: { roots: ['C:\\'] },
      secret: '',
    });
    expect(detectConnection('file:///C:/data/x.csv')).toEqual({
      kind: 'fs',
      config: { roots: ['C:/data'] },
      secret: '',
    });
    expect(detectConnection("  'file:///srv/my%20files/'  ")).toEqual({
      kind: 'fs',
      config: { roots: ['/srv/my files'] },
      secret: '',
    });
  });

  it('recognises nothing else', () => {
    for (const text of [
      '',
      '   ',
      'orders.csv',
      'data/in',
      '~/data',
      'mysql://h/db',
      'not a url',
      '/srv/a\n/srv/b',
      'postgres://',
      '\\\\srv\\share',
      'file://server/share/x.csv',
      'file:///srv/%zz',
    ]) {
      expect(detectConnection(text), text).toBeNull();
    }
  });
});
