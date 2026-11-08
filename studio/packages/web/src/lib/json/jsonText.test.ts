import { describe, expect, it } from 'vitest';
import {
  MAX_LAYOUT_DEPTH,
  describeJsonProblem,
  formatJsonText,
  lineOfPath,
  notValidJson,
  scanJson,
} from './jsonText';

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const VALID = [
  '{}',
  '[]',
  '0',
  '-0',
  '-12.5e+3',
  '1E2',
  '0.5',
  'true',
  'false',
  'null',
  '""',
  '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9"',
  '"\ud800"',
  ' \t\r\n{ "a" : [ 1 , 2 ] } \n',
  '{"a":{"b":[{"c":null}]},"d":[]}',
  '[[[]],[{}]]',
  '"${nodes.fetch.output}"',
  '{"a":1,"a":2}',
  '12345678901234567890',
];

const INVALID = [
  '',
  '   ',
  '{',
  '[',
  '}',
  '{"a"}',
  '{"a":}',
  '{"a":1,}',
  '[1,]',
  '[1 2]',
  '{a:1}',
  "{'a':1}",
  '-',
  '1.',
  '.5',
  '01',
  '+1',
  '1e',
  'tru',
  'nul',
  'True',
  '"abc',
  '"\\x"',
  '"\\u12g4"',
  '"a\tb"',
  '"a\nb"',
  '﻿{}',
  ' {}',
  '{} {}',
  '[1]]',
  '{"a":1 "b":2}',
  '${x}',
];

describe('scanJson (#1396)', () => {
  it.each(VALID)('accepts what JSON.parse accepts: %j', (text) => {
    expect(parses(text)).toBe(true);
    expect(scanJson(text)).toEqual({ ok: true });
  });

  it.each(INVALID)('refuses what JSON.parse refuses: %j', (text) => {
    expect(parses(text)).toBe(false);
    expect(scanJson(text).ok).toBe(false);
  });

  it('names the place and the reason', () => {
    expect(scanJson('[tru]')).toEqual({
      ok: false,
      offset: 1,
      reason: "'tru' is not a JSON value (the words are true, false and null)",
    });
    expect(scanJson('[01]')).toEqual({ ok: false, offset: 1, reason: 'invalid number' });
    expect(scanJson('{"a":1,}')).toEqual({
      ok: false,
      offset: 7,
      reason: 'expected a property name in double quotes',
    });
    expect(scanJson('[1 2]')).toEqual({ ok: false, offset: 3, reason: "expected ',' or ']'" });
    expect(scanJson('{"a" 1}')).toEqual({ ok: false, offset: 5, reason: "expected ':'" });
    expect(scanJson('{"a":1')).toEqual({ ok: false, offset: 6, reason: 'unexpected end of input' });
    expect(scanJson('{} x')).toEqual({
      ok: false,
      offset: 3,
      reason: 'unexpected text after the JSON value',
    });
    expect(scanJson('{"a":$x}')).toEqual({
      ok: false,
      offset: 5,
      reason: "unexpected character '$'",
    });
    expect(scanJson('\ufeff{}')).toEqual({
      ok: false,
      offset: 0,
      reason: 'unexpected character U+FEFF',
    });
    expect(scanJson('"a\\qb"')).toEqual({
      ok: false,
      offset: 2,
      reason: 'invalid escape in a string',
    });
  });

  it('survives nesting deep enough to overflow a recursive scanner', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(scanJson(deep)).toEqual({ ok: true });
  });
});

describe('formatJsonText (#1396)', () => {
  it('lays out exactly as the forms seed their text, so Format on a fresh form changes nothing', () => {
    const value = {
      url: 'https://x',
      retries: 3,
      headers: {},
      tags: [],
      nested: { a: [1, { b: null }] },
    };
    const seeded = JSON.stringify(value, null, 2);
    expect(formatJsonText(seeded)).toBe(seeded);
    expect(formatJsonText(JSON.stringify(value))).toBe(seeded);
    expect(formatJsonText('  [ 1,2 , {"a" :true} ]  ')).toBe(
      JSON.stringify([1, 2, { a: true }], null, 2),
    );
    expect(formatJsonText('"x"')).toBe('"x"');
  });

  it('never changes a value: big integers, exponents, escapes and duplicate keys stay as typed', () => {
    const typed = '{"id":12345678901234567890,"e":1E+2,"s":"\\u0041\\/","a":1,"a":2}';
    expect(formatJsonText(typed)).toBe(
      '{\n  "id": 12345678901234567890,\n  "e": 1E+2,\n  "s": "\\u0041\\/",\n  "a": 1,\n  "a": 2\n}',
    );
  });

  it('is idempotent', () => {
    const once = formatJsonText('{"a":[1,[2,{}]],"b":{"c":[]}}');
    expect(once).not.toBeNull();
    expect(formatJsonText(once!)).toBe(once);
  });

  it('does not lay out JSON nested deeper than MAX_LAYOUT_DEPTH', () => {
    const at = (n: number) => '['.repeat(n) + ']'.repeat(n);
    expect(formatJsonText(at(MAX_LAYOUT_DEPTH))).not.toBeNull();
    expect(formatJsonText(at(MAX_LAYOUT_DEPTH + 1))).toBeNull();
    expect(formatJsonText(at(200_000))).toBeNull();
  });

  it('gives null for text that is not JSON, and for blank text', () => {
    expect(formatJsonText('{"a":')).toBeNull();
    expect(formatJsonText('')).toBeNull();
    expect(formatJsonText(' \n ')).toBeNull();
  });
});

describe('describeJsonProblem (#1396)', () => {
  it('gives null for valid JSON', () => {
    expect(describeJsonProblem('{"a":1}')).toBeNull();
  });

  it('gives a line and column, counted from 1', () => {
    expect(describeJsonProblem('{\n  "a": 1,\n  "b" 2\n}')).toBe("line 3, column 7: expected ':'");
    expect(describeJsonProblem('{"a":')).toBe('line 1, column 6: unexpected end of input');
  });

  it('counts a CRLF as one line break, and a column in characters, not UTF-16 units', () => {
    expect(describeJsonProblem('{\r\n"a":1,\r\n}')).toBe(
      'line 3, column 1: expected a property name in double quotes',
    );
    expect(describeJsonProblem('["😀" 1]')).toBe("line 1, column 6: expected ',' or ']'");
  });

  it('places the problem in the text as shown when the parsed text was trimmed from it', () => {
    const shown = '\n\n  {"a" 1}  ';
    expect(describeJsonProblem(shown.trim(), shown)).toBe("line 3, column 8: expected ':'");
  });
});

describe('notValidJson (#1396)', () => {
  it('is the forms’ refusal, naming the place in the text as shown', () => {
    expect(notValidJson('[1 2]', ' [1 2]')).toBe(
      "not valid JSON (line 1, column 5: expected ',' or ']')",
    );
  });
});

describe('lineOfPath (#1573 OR38)', () => {
  const text = JSON.stringify(
    { a: 1, nodes: [{ id: 'x', config: { k: [10, { deep: true }] } }, { id: 'y' }], z: [] },
    null,
    2,
  );
  const lineOf = (needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

  it('locates an object member at its key', () => {
    expect(lineOfPath(text, ['a'])).toBe(lineOf('"a"'));
    expect(lineOfPath(text, ['z'])).toBe(lineOf('"z"'));
  });

  it('locates an array element, counting past nested containers', () => {
    expect(lineOfPath(text, ['nodes', 1])).toBe(lineOf('"y"') - 1);
    expect(lineOfPath(text, ['nodes', 1, 'id'])).toBe(lineOf('"y"'));
    expect(lineOfPath(text, ['nodes', 0, 'config', 'k', 1, 'deep'])).toBe(lineOf('"deep"'));
    expect(lineOfPath(text, ['nodes', 0, 'config', 'k', 0])).toBe(lineOf('10'));
  });

  it('falls back to the deepest value the text has', () => {
    expect(lineOfPath(text, ['nodes', 0, 'missing'])).toBe(lineOf('"id": "x"') - 1);
    expect(lineOfPath(text, ['nodes', 7])).toBe(lineOf('"nodes"'));
    expect(lineOfPath(text, [])).toBe(1);
  });

  it('reads a duplicate key at its last occurrence, as JSON.parse does', () => {
    expect(lineOfPath('{\n"a": 1,\n"a": 2\n}', ['a'])).toBe(3);
  });

  it('is null for text that is not JSON', () => {
    expect(lineOfPath('{"a": ', ['a'])).toBeNull();
  });
});
