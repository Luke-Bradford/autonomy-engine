/**
 * #1199 — where every package's vitest tests live, declared ONCE.
 *
 * The ticket asked two questions. The first was why vitest's default `exclude`
 * stopped covering `dist/`: it is a version change. On the pinned **4.1.10**,
 * `defaultExclude` is exactly `["**\/node_modules\/**", "**\/.git\/**"]`
 * (`vitest/dist/chunks/defaults.*.js`), where every release through 3.x also
 * excluded `dist`. `defaultInclude` still matches
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)`, so a compiled `*.test.js` in a
 * gitignored `dist/` is collected as a SECOND copy of the whole suite.
 * Measured, after one `tsc -b packages/shared`: `vitest list` reported 5238
 * tests, 2619 of them from `dist/`.
 *
 * The second question was where the fix belongs — "one config or a shared
 * base" — and this file is the answer: a shared base. All four packages are
 * exposed identically, because the exposure is structural (a project that
 * includes tests and can emit) rather than a property of `server`. Four
 * hand-copied `include` lines would be four things to keep in step, and
 * NOTHING IN CI WOULD REPORT ONE DRIFTING: `studio-ci` typechecks with
 * `--noEmit` and builds only AFTER it tests, so no workflow step plants
 * compiled tests before the test step. This hazard is invisible to CI by
 * construction, which is exactly the condition under which a duplicated guard
 * rots unnoticed.
 *
 * AN ALLOWLIST, not a `dist` exclusion. Naming the directory that burned us
 * fixes that directory; `coverage/`, `.vite/`, a stray `out/`, a copied tree
 * would each need adding later. Stating where tests DO live is closed under the
 * next directory instead. (Checked: every `*.test.*` in all four packages is
 * under `src/`, and the only `*.spec.*` files in the workspace are Playwright's,
 * in `e2e/`, which no package's vitest run collects.)
 *
 * ONE pattern rather than a per-package one: `.tsx` tests exist only in `web`
 * today, and a pattern that admits them everywhere costs nothing in a package
 * that has none, whereas two spellings would be a thing to choose wrongly.
 *
 * This is the second of TWO defences and deliberately not the first. The
 * artifacts are stopped from existing at all by `noEmit` on each package's
 * typecheck project; this stops them being COLLECTED however else they arrive.
 * Both are needed — an `include`/`exclude` alone leaves the compiled copies
 * rotting on disk, where they feed the worse half of the same class: a stale
 * compiled tree going GREEN on code that no longer exists.
 */
export const TEST_INCLUDE = ['src/**/*.test.{ts,tsx}'];
