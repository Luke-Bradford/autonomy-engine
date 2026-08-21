import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ISSUE_LIST_CAP, formatZodIssues, summarizeIssueList } from './zod-issues.js';

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

/**
 * #1183 — the bound. `formatZodIssues` is the SSOT renderer behind ~44 call
 * sites and joined every issue with no cap, while the rest of the codebase
 * already capped the same list at `ISSUE_LIST_CAP`. One reachable path let the
 * unbounded string leave the process: `portability/envelope.ts` throws an
 * `ImportError` whose message the server sends VERBATIM as the `import_error`
 * 400 body.
 *
 * The boundary cases are the whole test: an off-by-one here either drops one
 * issue silently (the #473 fail-open shape) or renders a "…and 0 more" tail.
 */
describe('summarizeIssueList (#1183)', () => {
  const line = (n: number) => `field${n}: Required`;

  it('leaves a list AT the cap whole, with NO tail', () => {
    const out = summarizeIssueList(Array.from({ length: ISSUE_LIST_CAP }, (_, i) => line(i)));
    expect(out).not.toContain('more');
    expect(out.split('; ')).toHaveLength(ISSUE_LIST_CAP);
    expect(out).toContain(line(ISSUE_LIST_CAP - 1));
  });

  it('caps at ISSUE_LIST_CAP and STATES the remainder rather than dropping it', () => {
    const out = summarizeIssueList(Array.from({ length: ISSUE_LIST_CAP + 1 }, (_, i) => line(i)));
    expect(out).toContain('…and 1 more');
    // The dropped tail is genuinely absent — a cap that still emitted it would
    // bound nothing.
    expect(out).not.toContain(line(ISSUE_LIST_CAP));
    expect(out).toContain(line(ISSUE_LIST_CAP - 1));
  });

  it('renders the tail byte-identically to the other three sites (`; …and N more`)', () => {
    const out = summarizeIssueList(Array.from({ length: ISSUE_LIST_CAP + 50 }, (_, i) => line(i)));
    // U+2026, not three dots: `server/errors.test.ts` and `web/api/client.ts`
    // both assert on this exact literal.
    expect(out.endsWith('; …and 50 more')).toBe(true);
  });

  it('is a plain join below the cap', () => {
    expect(summarizeIssueList(['a: x', 'b: y'])).toBe('a: x; b: y');
    expect(summarizeIssueList([])).toBe('');
  });
});

describe('formatZodIssues is bounded by the same cap (#1183)', () => {
  it('caps a Zod failure with one issue per field and states the remainder', () => {
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < ISSUE_LIST_CAP + 7; i += 1) shape[`f${i}`] = z.string();
    const parsed = z.object(shape).safeParse({});
    expect(parsed.success, 'fixture was supposed to FAIL validation').toBe(false);
    expect(parsed.error!.issues.length).toBe(ISSUE_LIST_CAP + 7);

    const out = formatZodIssues(parsed.error!.issues);
    expect(out).toContain('…and 7 more');
    expect(out).not.toContain(`f${ISSUE_LIST_CAP + 6}:`);
  });

  /**
   * The output being bounded does not make the WORK bounded: rendering every
   * issue and then slicing gives the same string while staying O(issues). This
   * counts renders rather than reading the result, so it fails if the slice
   * moves back after the `map`.
   */
  it('never renders an issue beyond the cap', () => {
    let renders = 0;
    const issues = Array.from({ length: ISSUE_LIST_CAP + 50 }, (_, i) => ({
      message: `m${i}`,
      // `formatZodIssues` reaches an issue's text through `path.join` and
      // `message`; counting the join is counting one render.
      path: {
        join: () => {
          renders += 1;
          return `f${i}`;
        },
      },
    })) as unknown as z.core.$ZodIssue[];

    const out = formatZodIssues(issues);

    expect(renders).toBe(ISSUE_LIST_CAP);
    // …and the tail still counts the ones it did not render.
    expect(out.endsWith('; …and 50 more')).toBe(true);
  });
});
