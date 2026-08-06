import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatZodIssues } from './zod-issues.js';

/**
 * #856 — the one rendering of a Zod failure, replacing nine copies that had
 * already drifted into three answers for the empty-path case.
 *
 * The cases below are written against REAL Zod output rather than hand-built
 * issue literals, because the whole point of the empty-path branch is that Zod
 * genuinely produces `path: []` for a whole-object failure — a fixture asserting
 * that from memory would keep passing if it stopped doing so.
 */
describe('formatZodIssues', () => {
  const Obj = z.object({ name: z.string(), port: z.number() });

  function issuesOf(schema: z.ZodType, value: unknown): z.core.$ZodIssue[] {
    const parsed = schema.safeParse(value);
    expect(parsed.success, 'fixture was supposed to FAIL validation').toBe(false);
    return parsed.error!.issues;
  }

  it('prefixes each issue with its dotted path', () => {
    const out = formatZodIssues(issuesOf(Obj, { name: 1, port: 'x' }));
    expect(out).toContain('name: ');
    expect(out).toContain('port: ');
    expect(out.split('; ')).toHaveLength(2);
  });

  it('names a NESTED path in full', () => {
    const Nested = z.object({ auth: z.object({ token: z.string() }) });
    expect(formatZodIssues(issuesOf(Nested, { auth: { token: 9 } }))).toContain('auth.token: ');
  });

  /**
   * The case the nine copies disagreed about. Zod reports an empty `path` for a
   * failure of the object ITSELF, and four of the web copies rendered that as a
   * bare leading `': '` — an operator-facing line beginning with punctuation and
   * naming nothing.
   */
  it('drops the prefix entirely when the issue has no path', () => {
    const issues = issuesOf(Obj, []);
    expect(issues[0]!.path).toEqual([]); // the premise: Zod really does report none
    // Asserted as EQUALITY, not as "contains no colon". Zod's own message says
    // `Invalid input: expected object, received array`, so a colon test would
    // fail on the message rather than on the prefix it is meant to be about.
    expect(formatZodIssues(issues)).toBe(issues[0]!.message);
  });

  it('substitutes a caller-supplied label for a missing path, when given one', () => {
    expect(formatZodIssues(issuesOf(Obj, []), 'pipeline')).toMatch(/^pipeline: /);
  });

  it('does NOT let the fallback displace a real path', () => {
    expect(formatZodIssues(issuesOf(Obj, { name: 1, port: 2 }), 'pipeline')).toMatch(/^name: /);
  });

  it('joins several issues with a separator that is not the path separator', () => {
    // `; ` rather than `, ` on purpose: a Zod message may itself contain a comma
    // (`Expected string, received number`), so a comma-joined list is ambiguous.
    const out = formatZodIssues(issuesOf(Obj, { name: 1, port: 'x' }));
    expect(out).toContain('; ');
  });

  it('renders an empty issue list as an empty string, not a stray separator', () => {
    expect(formatZodIssues([])).toBe('');
  });
});
