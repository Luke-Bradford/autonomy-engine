/**
 * Zero-paid-dependency license audit (P7 packaging, #409).
 *
 * autonomy-studio is MIT-licensed and self-hostable, so every third-party
 * dependency it pulls in — production AND dev/build tooling — must carry a
 * permissive OSS license that permits redistribution inside an MIT work. This
 * module is the PURE decision core; `licenseAudit.run.ts` feeds it the parsed
 * output of `pnpm licenses list --json` and turns a failed audit into a
 * non-zero CI exit.
 *
 * Design stance: FAIL-CLOSED. An unrecognised, empty, ambiguous, or
 * `Unknown`/`UNLICENSED` license is treated as DISALLOWED — never assumed
 * benign. An absent fact must not be manufactured as a passing default (the
 * same posture as the merge-gate's "a `gh` failure is never CI-green").
 */

/**
 * One package as reported by `pnpm licenses list --json`. pnpm groups every
 * installed version of a package under a single entry, so `versions` is an
 * array (e.g. `["1.2.0", "1.3.1"]`). Fields are typed as OPTIONAL because this
 * shape describes UNVALIDATED external tool output — a payload drift must be
 * tolerated by readers, not assumed away.
 */
export interface LicensedPackage {
  name?: string;
  versions?: string[];
  [key: string]: unknown;
}

/**
 * The shape of `pnpm licenses list --json`: a map keyed by the SPDX license
 * id/expression to the packages distributed under it. The key can be a bare id
 * (`MIT`) or an SPDX expression (`(MIT OR WTFPL)`).
 */
export type LicenseListMap = Record<string, LicensedPackage[]>;

/**
 * Canonical SPDX ids we accept. Each is a well-established permissive or
 * public-domain license, OR a documented build-time exception. Deliberately
 * EXCLUDES copyleft (GPL/AGPL/LGPL/EUPL/SSPL/CDDL/EPL) and the
 * no-license/unknown sentinels (`UNLICENSED`, `Unknown`) — those fall through
 * to a violation.
 *
 * Rationale, license by license:
 *  - MIT, MIT-0, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, Unlicense, WTFPL,
 *    Zlib, Python-2.0 — classic permissive / public-domain; unconditional
 *    redistribution.
 *  - Apache-2.0 — permissive with an explicit patent grant.
 *  - BlueOak-1.0.0 — modern permissive license (plain-language MIT-equivalent).
 *  - CC0-1.0 — public-domain dedication.
 *  - CC-BY-4.0 — attribution-only. Present ONLY on build-time DATA packages
 *    (`caniuse-lite`, `mdn-data`), never shipped as code in the runtime bundle;
 *    redistribution is permitted provided attribution is retained.
 *  - MPL-2.0 — weak, FILE-level copyleft. Present ONLY on unmodified
 *    build-time transitive deps (`lightningcss` + its platform binaries). MPL
 *    §3.3 explicitly permits distributing the covered files inside a "Larger
 *    Work" under other terms as long as the MPL files themselves stay MPL — we
 *    never modify them, so this is satisfied by construction.
 */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'MPL-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
  'Python-2.0',
]);

/** Strip a single balanced pair of wrapping parens, if present. */
function stripOuterParens(expr: string): string {
  const t = expr.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  // Only strip if the leading '(' matches the trailing ')' (balanced wrapper),
  // e.g. "(A OR B)" but NOT "(A) AND (B)".
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return t; // closed before the end
    }
  }
  return t.slice(1, -1).trim();
}

/** Resolve a single, operator-free license term (after `WITH` is stripped). */
function evaluateTerm(term: string, allowed: ReadonlySet<string>): boolean {
  // "Apache-2.0 WITH LLVM-exception" -> "Apache-2.0". The exception narrows,
  // never broadens, permissions, so the base id governs allow/deny.
  const base = term.split(/\s+WITH\s+/i)[0]?.trim() ?? '';
  if (base === '') return false;
  return allowed.has(base);
}

/**
 * Evaluate an SPDX license expression against the allowlist. Conservative and
 * fail-closed:
 *  - `A OR B`  -> allowed iff ANY operand is allowed (a package offered under a
 *    permissive OR a copyleft license may be taken under the permissive one).
 *  - `A AND B` -> allowed iff EVERY operand is allowed.
 *  - a top-level MIX of OR and AND -> DISALLOWED (we do not guess precedence).
 *  - a bare term -> membership check (after stripping any `WITH` exception).
 *  - empty / `Unknown` / unmatched -> DISALLOWED.
 *
 * Splitting is naive (it does not descend nested parens), which is safe: a
 * still-parenthesised fragment simply fails the membership check, i.e. errs
 * toward a violation, never toward a false pass.
 */
export function evaluateLicenseExpression(expr: string, allowed: ReadonlySet<string>): boolean {
  const inner = stripOuterParens(expr);
  if (inner === '') return false;

  const hasOr = /\sOR\s/i.test(inner);
  const hasAnd = /\sAND\s/i.test(inner);

  // Ambiguous precedence — refuse rather than guess.
  if (hasOr && hasAnd) return false;

  if (hasOr) {
    return inner.split(/\sOR\s/i).some((part) => evaluateLicenseExpression(part, allowed));
  }
  if (hasAnd) {
    return inner.split(/\sAND\s/i).every((part) => evaluateLicenseExpression(part, allowed));
  }
  return evaluateTerm(inner, allowed);
}

/** A license bucket that failed the allowlist, with the offending packages. */
export interface LicenseViolation {
  license: string;
  packages: LicensedPackage[];
}

export interface AuditResult {
  ok: boolean;
  violations: LicenseViolation[];
}

/**
 * Audit a parsed `pnpm licenses list --json` map. Every license bucket whose
 * SPDX expression is not permitted becomes a violation carrying its packages.
 */
export function auditLicenses(map: LicenseListMap, allowed: ReadonlySet<string>): AuditResult {
  const violations: LicenseViolation[] = [];
  for (const [license, packages] of Object.entries(map)) {
    if (!evaluateLicenseExpression(license, allowed)) {
      violations.push({ license, packages });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Guard against a SILENT no-op audit. `pnpm licenses list` run from the wrong
 * cwd (a package subdir reports only ~2 deps), against a partial install, or a
 * future pnpm output change could yield an empty/degenerate map — which
 * `auditLicenses` would happily pass as "0 violations". Refuse a tree that is
 * implausibly small so an audit that examined nothing fails CLOSED instead of
 * green.
 */
export function assertPlausibleTree(map: LicenseListMap, minPackages: number): void {
  let total = 0;
  for (const [license, pkgs] of Object.entries(map)) {
    // Fail CLOSED on shape drift: a non-array bucket would make an arithmetic
    // sum `NaN` (and `NaN < min` is false → the guard would silently pass). An
    // unexpected shape must be a refusal, never a free pass.
    if (!Array.isArray(pkgs)) {
      throw new Error(
        `license audit got a non-array bucket for "${license}" — unexpected ` +
          '`pnpm licenses list --json` shape; refusing to pass an unverifiable tree.',
      );
    }
    total += pkgs.length;
  }
  if (total < minPackages) {
    throw new Error(
      `license audit examined only ${total} package(s) (floor ${minPackages}) — refusing to ` +
        'pass a degenerate/empty dependency tree. Is `pnpm licenses list` running at the ' +
        'workspace root against a complete install?',
    );
  }
}
