import { FUNCTIONS, formatSignature } from './functions.js';
import type { SigType } from './functions.js';

/**
 * #1413 OR22 — what each expression function does, in words an author can act
 * on: a one-sentence description, a name for every parameter, and one or two
 * examples.
 *
 * Kept beside the catalog rather than inside it: `functions.ts` is the
 * evaluator's private seam, and prose there would sit between the security
 * notes that matter. The two are tied together by test instead — the key set
 * must equal the catalog's, and every example is EXECUTED against the real
 * evaluator, so a description cannot outlive the behaviour it describes.
 *
 * `params` has one name per `FnSpec.args` entry; a variadic's last name is the
 * repeated one. Examples are literals only (plus `item` inside a lambda), so
 * they read on their own and run without a graph.
 */
type FnDocEntry = {
  description: string;
  params: string[];
  examples: { expr: string; result: unknown }[];
};

export const FUNCTION_DOCS: Readonly<Record<string, FnDocEntry>> = Object.freeze({
  // -- logical / comparison --------------------------------------------------
  and: {
    description: 'True when every condition is true; stops at the first false one.',
    params: ['condition'],
    examples: [{ expr: 'and(true, false)', result: false }],
  },
  or: {
    description: 'True when any condition is true; stops at the first true one.',
    params: ['condition'],
    examples: [{ expr: 'or(false, true)', result: true }],
  },
  if: {
    description:
      'Returns the second value when the condition is true, otherwise the third; only the chosen one is evaluated.',
    params: ['condition', 'whenTrue', 'whenFalse'],
    examples: [{ expr: "if(greater(5, 3), 'big', 'small')", result: 'big' }],
  },
  not: {
    description: 'Turns true into false and false into true.',
    params: ['condition'],
    examples: [{ expr: 'not(false)', result: true }],
  },
  equals: {
    description:
      'True when two values are the same, comparing arrays and objects by content and never converting types.',
    params: ['left', 'right'],
    examples: [
      { expr: "equals('a', 'a')", result: true },
      { expr: "equals(1, '1')", result: false },
    ],
  },
  greater: {
    description:
      'True when the first value is greater than the second; compare two numbers or two strings.',
    params: ['left', 'right'],
    examples: [{ expr: 'greater(10, 2)', result: true }],
  },
  greaterOrEquals: {
    description: 'True when the first value is greater than or equal to the second.',
    params: ['left', 'right'],
    examples: [{ expr: 'greaterOrEquals(2, 2)', result: true }],
  },
  less: {
    description:
      'True when the first value is less than the second; compare two numbers or two strings.',
    params: ['left', 'right'],
    examples: [{ expr: "less('apple', 'banana')", result: true }],
  },
  lessOrEquals: {
    description: 'True when the first value is less than or equal to the second.',
    params: ['left', 'right'],
    examples: [{ expr: 'lessOrEquals(3, 2)', result: false }],
  },
  default: {
    description:
      'Returns the value, or the fallback when it is missing, null, empty text or false, such as a skipped output.',
    params: ['value', 'fallback'],
    examples: [
      { expr: "default('', 'none')", result: 'none' },
      { expr: "default('set', 'none')", result: 'set' },
    ],
  },

  // -- strings -----------------------------------------------------------------
  concat: {
    description: 'Joins values into one piece of text, converting each to text first.',
    params: ['value'],
    examples: [{ expr: "concat('order-', 42)", result: 'order-42' }],
  },
  substring: {
    description:
      'Takes part of a string from a zero-based start position, optionally limited to a number of characters.',
    params: ['text', 'start', 'length'],
    examples: [
      { expr: "substring('pipeline', 4)", result: 'line' },
      { expr: "substring('pipeline', 0, 4)", result: 'pipe' },
    ],
  },
  replace: {
    description:
      'Replaces every occurrence of one piece of text with another, matching case exactly.',
    params: ['text', 'find', 'replaceWith'],
    examples: [{ expr: "replace('a-b-c', '-', '/')", result: 'a/b/c' }],
  },
  split: {
    description: 'Splits a string into an array at each separator.',
    params: ['text', 'separator'],
    examples: [{ expr: "split('a,b,c', ',')", result: ['a', 'b', 'c'] }],
  },
  trim: {
    description: 'Removes spaces, tabs and line breaks from both ends of a string.',
    params: ['text'],
    examples: [{ expr: "trim('  hello  ')", result: 'hello' }],
  },
  toLower: {
    description: 'Converts a string to lower case.',
    params: ['text'],
    examples: [{ expr: "toLower('Hello')", result: 'hello' }],
  },
  toUpper: {
    description: 'Converts a string to upper case.',
    params: ['text'],
    examples: [{ expr: "toUpper('hello')", result: 'HELLO' }],
  },
  startsWith: {
    description: 'True when a string begins with the given text, matching case exactly.',
    params: ['text', 'prefix'],
    examples: [
      { expr: "startsWith('report.csv', 'report')", result: true },
      { expr: "startsWith('Report', 'report')", result: false },
    ],
  },
  endsWith: {
    description: 'True when a string ends with the given text, matching case exactly.',
    params: ['text', 'suffix'],
    examples: [{ expr: "endsWith('report.csv', '.csv')", result: true }],
  },
  indexOf: {
    description:
      'Returns the zero-based position of the first match in a string, or -1 when there is none.',
    params: ['text', 'search'],
    examples: [
      { expr: "indexOf('banana', 'an')", result: 1 },
      { expr: "indexOf('banana', 'x')", result: -1 },
    ],
  },
  lastIndexOf: {
    description:
      'Returns the zero-based position of the last match in a string, or -1 when there is none.',
    params: ['text', 'search'],
    examples: [{ expr: "lastIndexOf('banana', 'an')", result: 3 }],
  },
  slug: {
    description:
      'Turns a value into lower-case letters, digits and dashes, safe for file names and ids.',
    params: ['value'],
    examples: [{ expr: "slug('Q3 Sales Report!')", result: 'q3-sales-report' }],
  },

  // -- collections -------------------------------------------------------------
  length: {
    description: 'Counts the characters in a string or the items in an array.',
    params: ['value'],
    examples: [
      { expr: "length('hello')", result: 5 },
      { expr: 'length(createArray(1, 2, 3))', result: 3 },
    ],
  },
  empty: {
    description: 'True when a string or an array has nothing in it.',
    params: ['value'],
    examples: [{ expr: "empty('')", result: true }],
  },
  contains: {
    description: 'True when a string contains the given text, or an array contains the given item.',
    params: ['collection', 'value'],
    examples: [
      { expr: "contains('hello world', 'world')", result: true },
      { expr: 'contains(createArray(1, 2), 3)', result: false },
    ],
  },
  first: {
    description:
      'Returns the first item of an array or the first character of a string, or null when empty.',
    params: ['collection'],
    examples: [{ expr: "first(createArray('a', 'b'))", result: 'a' }],
  },
  last: {
    description:
      'Returns the last item of an array or the last character of a string, or null when empty.',
    params: ['collection'],
    examples: [{ expr: "last(createArray('a', 'b'))", result: 'b' }],
  },
  take: {
    description: 'Returns the first given number of items from an array.',
    params: ['array', 'count'],
    examples: [{ expr: 'take(createArray(1, 2, 3), 2)', result: [1, 2] }],
  },
  skip: {
    description: 'Returns an array without its first given number of items.',
    params: ['array', 'count'],
    examples: [{ expr: 'skip(createArray(1, 2, 3), 2)', result: [3] }],
  },
  join: {
    description: "Joins an array's items into one string with a separator between them.",
    params: ['array', 'separator'],
    examples: [{ expr: "join(createArray('a', 'b', 'c'), ', ')", result: 'a, b, c' }],
  },
  intersection: {
    description: 'Returns the items that appear in every array given, each once.',
    params: ['array'],
    examples: [
      { expr: 'intersection(createArray(1, 2, 3), createArray(2, 3, 4))', result: [2, 3] },
    ],
  },
  union: {
    description: 'Merges arrays into one, keeping each distinct item once.',
    params: ['array'],
    examples: [{ expr: 'union(createArray(1, 2), createArray(2, 3))', result: [1, 2, 3] }],
  },
  createArray: {
    description: 'Builds an array from the values given.',
    params: ['item'],
    examples: [{ expr: "createArray('a', 'b')", result: ['a', 'b'] }],
  },
  range: {
    description:
      'Builds an array of consecutive whole numbers from a start value, with the given count.',
    params: ['start', 'count'],
    examples: [{ expr: 'range(1, 3)', result: [1, 2, 3] }],
  },
  filter: {
    description:
      'Keeps the items of an array for which the condition is true; write item for each one.',
    params: ['array', 'condition'],
    examples: [{ expr: 'filter(createArray(1, 5, 10), greater(item, 3))', result: [5, 10] }],
  },
  map: {
    description:
      'Builds a new array by working out an expression for each item; write item for each one.',
    params: ['array', 'expression'],
    examples: [{ expr: 'map(createArray(1, 2), mul(item, 10))', result: [10, 20] }],
  },
  count: {
    description:
      'Counts the items in an array, or only those for which an optional condition on item is true.',
    params: ['array', 'condition'],
    examples: [
      { expr: 'count(createArray(1, 2, 3))', result: 3 },
      { expr: 'count(createArray(1, 2, 3), greater(item, 1))', result: 2 },
    ],
  },
  sum: {
    description: 'Adds up an array of numbers.',
    params: ['numbers'],
    examples: [{ expr: 'sum(createArray(1, 2, 3))', result: 6 }],
  },
  avg: {
    description: 'Returns the average of an array of numbers; an empty array is an error.',
    params: ['numbers'],
    examples: [{ expr: 'avg(createArray(2, 4))', result: 3 }],
  },

  // -- conversion --------------------------------------------------------------
  string: {
    description:
      'Converts a value to text; arrays and objects become JSON and null becomes empty text.',
    params: ['value'],
    examples: [
      { expr: 'string(42)', result: '42' },
      { expr: 'string(createArray(1, 2))', result: '[1,2]' },
    ],
  },
  int: {
    description:
      'Converts a whole-number string, or a number, to an integer, dropping any fraction.',
    params: ['value'],
    examples: [{ expr: "int('42')", result: 42 }],
  },
  float: {
    description: 'Converts a numeric string, or a number, to a number that may have a fraction.',
    params: ['value'],
    examples: [{ expr: "float('2.5')", result: 2.5 }],
  },
  bool: {
    description: "Converts the text 'true' or 'false', or a number, to a boolean; zero is false.",
    params: ['value'],
    examples: [
      { expr: "bool('true')", result: true },
      { expr: 'bool(0)', result: false },
    ],
  },
  array: {
    description: 'Wraps a single value in an array; an array is returned unchanged.',
    params: ['value'],
    examples: [{ expr: "array('a')", result: ['a'] }],
  },
  json: {
    description: 'Parses JSON text into the value it holds; any other value is returned unchanged.',
    params: ['value'],
    examples: [{ expr: 'json(\'{"id": 7}\')', result: { id: 7 } }],
  },
  coalesce: {
    description: 'Returns the first value that is not null, or null when every value is.',
    params: ['value'],
    examples: [{ expr: "coalesce(json('null'), 'fallback')", result: 'fallback' }],
  },
  encodeUriComponent: {
    description: 'Encodes text for safe use inside a URL, such as a query-string value.',
    params: ['text'],
    examples: [{ expr: "encodeUriComponent('a b&c')", result: 'a%20b%26c' }],
  },
  decodeUriComponent: {
    description: 'Decodes URL-encoded text back to what it stood for.',
    params: ['text'],
    examples: [{ expr: "decodeUriComponent('a%20b')", result: 'a b' }],
  },
  base64: {
    description: 'Encodes text as Base64.',
    params: ['text'],
    examples: [{ expr: "base64('hi')", result: 'aGk=' }],
  },
  base64ToString: {
    description: 'Decodes Base64 back into the text it encodes.',
    params: ['encoded'],
    examples: [{ expr: "base64ToString('aGk=')", result: 'hi' }],
  },

  // -- math --------------------------------------------------------------------
  add: {
    description: 'Adds two numbers.',
    params: ['left', 'right'],
    examples: [{ expr: 'add(2, 3)', result: 5 }],
  },
  sub: {
    description: 'Subtracts the second number from the first.',
    params: ['left', 'right'],
    examples: [{ expr: 'sub(10, 4)', result: 6 }],
  },
  mul: {
    description: 'Multiplies two numbers.',
    params: ['left', 'right'],
    examples: [{ expr: 'mul(6, 7)', result: 42 }],
  },
  div: {
    description: 'Divides the first number by the second; dividing by zero is an error.',
    params: ['dividend', 'divisor'],
    examples: [{ expr: 'div(10, 4)', result: 2.5 }],
  },
  mod: {
    description: 'Returns the remainder after dividing the first number by the second.',
    params: ['dividend', 'divisor'],
    examples: [{ expr: 'mod(10, 3)', result: 1 }],
  },
  min: {
    description: 'Returns the smallest of the numbers given.',
    params: ['number'],
    examples: [{ expr: 'min(4, 1, 7)', result: 1 }],
  },
  max: {
    description: 'Returns the largest of the numbers given.',
    params: ['number'],
    examples: [{ expr: 'max(4, 1, 7)', result: 7 }],
  },

  // -- date / time (UTC, ISO 8601) ---------------------------------------------
  formatDateTime: {
    description: 'Formats a timestamp in UTC with the tokens yyyy, MM, dd, HH, mm, ss and fff.',
    params: ['timestamp', 'format'],
    examples: [
      { expr: "formatDateTime('2026-03-05T14:30:00Z', 'yyyy-MM-dd')", result: '2026-03-05' },
    ],
  },
  addDays: {
    description: 'Adds a number of days to a timestamp; a negative number goes back.',
    params: ['timestamp', 'days'],
    examples: [{ expr: "addDays('2026-03-05T00:00:00Z', 1)", result: '2026-03-06T00:00:00.000Z' }],
  },
  addHours: {
    description: 'Adds a number of hours to a timestamp; a negative number goes back.',
    params: ['timestamp', 'hours'],
    examples: [
      { expr: "addHours('2026-03-05T00:00:00Z', -2)", result: '2026-03-04T22:00:00.000Z' },
    ],
  },
  addMinutes: {
    description: 'Adds a number of minutes to a timestamp; a negative number goes back.',
    params: ['timestamp', 'minutes'],
    examples: [
      { expr: "addMinutes('2026-03-05T00:00:00Z', 90)", result: '2026-03-05T01:30:00.000Z' },
    ],
  },
  addSeconds: {
    description: 'Adds a number of seconds to a timestamp; a negative number goes back.',
    params: ['timestamp', 'seconds'],
    examples: [
      { expr: "addSeconds('2026-03-05T00:00:00Z', 30)", result: '2026-03-05T00:00:30.000Z' },
    ],
  },
  addToTime: {
    description: 'Adds an amount of Second, Minute, Hour, Day, Week, Month or Year to a timestamp.',
    params: ['timestamp', 'interval', 'unit'],
    examples: [
      { expr: "addToTime('2026-01-31T00:00:00Z', 1, 'Month')", result: '2026-02-28T00:00:00.000Z' },
    ],
  },
  subtractFromTime: {
    description:
      'Subtracts an amount of Second, Minute, Hour, Day, Week, Month or Year from a timestamp.',
    params: ['timestamp', 'interval', 'unit'],
    examples: [
      {
        expr: "subtractFromTime('2026-03-05T00:00:00Z', 1, 'Week')",
        result: '2026-02-26T00:00:00.000Z',
      },
    ],
  },
  startOfDay: {
    description: 'Moves a timestamp back to midnight UTC on the same day.',
    params: ['timestamp'],
    examples: [{ expr: "startOfDay('2026-03-05T14:30:00Z')", result: '2026-03-05T00:00:00.000Z' }],
  },
  startOfHour: {
    description: 'Moves a timestamp back to the start of its hour.',
    params: ['timestamp'],
    examples: [{ expr: "startOfHour('2026-03-05T14:30:00Z')", result: '2026-03-05T14:00:00.000Z' }],
  },
  startOfMonth: {
    description: 'Moves a timestamp back to midnight UTC on the first day of its month.',
    params: ['timestamp'],
    examples: [
      { expr: "startOfMonth('2026-03-05T14:30:00Z')", result: '2026-03-01T00:00:00.000Z' },
    ],
  },
  dayOfWeek: {
    description: 'Returns the day of the week in UTC, from 0 for Sunday to 6 for Saturday.',
    params: ['timestamp'],
    examples: [{ expr: "dayOfWeek('2026-03-05T00:00:00Z')", result: 4 }],
  },
  dayOfMonth: {
    description: 'Returns the day of the month in UTC, from 1 to 31.',
    params: ['timestamp'],
    examples: [{ expr: "dayOfMonth('2026-03-05T00:00:00Z')", result: 5 }],
  },
});

/** One catalog function as the help text shows it (#1413). */
export type FunctionDoc = {
  description: string;
  /** `substring(text: string, start: number, length?: number) → string`. */
  signature: string;
  returns: SigType;
  /** The first example as `call → result`, the result printed as JSON. */
  example: string;
};

export function functionDoc(name: string): FunctionDoc {
  const doc = FUNCTION_DOCS[name];
  const spec = FUNCTIONS[name];
  if (doc === undefined || spec === undefined) {
    throw new Error(`functionDoc: '${name}' is not in the catalog`);
  }
  const first = doc.examples[0]!;
  return {
    description: doc.description,
    signature: formatSignature(name, doc.params),
    returns: spec.ret,
    example: `${first.expr} → ${JSON.stringify(first.result)}`,
  };
}
