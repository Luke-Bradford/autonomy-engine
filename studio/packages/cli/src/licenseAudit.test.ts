import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  assertPlausibleTree,
  auditLicenses,
  evaluateLicenseExpression,
  type LicenseListMap,
} from './licenseAudit.js';

describe('evaluateLicenseExpression', () => {
  it('allows the common permissive SPDX ids', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD', 'CC0-1.0']) {
      expect(evaluateLicenseExpression(id, ALLOWED_LICENSES)).toBe(true);
    }
  });

  it('allows the two documented build-time exceptions (MPL-2.0, CC-BY-4.0)', () => {
    expect(evaluateLicenseExpression('MPL-2.0', ALLOWED_LICENSES)).toBe(true);
    expect(evaluateLicenseExpression('CC-BY-4.0', ALLOWED_LICENSES)).toBe(true);
  });

  it('denies copyleft and unknown/unlicensed (fail-closed)', () => {
    for (const id of [
      'GPL-3.0-only',
      'AGPL-3.0',
      'LGPL-3.0',
      'UNLICENSED',
      'Unknown',
      '',
      '   ',
      'SEE LICENSE IN LICENSE',
    ]) {
      expect(evaluateLicenseExpression(id, ALLOWED_LICENSES)).toBe(false);
    }
  });

  it('OR is a disjunction — allowed if ANY operand is permissive', () => {
    expect(evaluateLicenseExpression('(MIT OR WTFPL)', ALLOWED_LICENSES)).toBe(true);
    expect(evaluateLicenseExpression('(MIT OR GPL-3.0-only)', ALLOWED_LICENSES)).toBe(true);
    expect(evaluateLicenseExpression('(GPL-3.0-only OR LGPL-3.0)', ALLOWED_LICENSES)).toBe(false);
  });

  it('AND is a conjunction — allowed only if ALL operands are permissive', () => {
    expect(evaluateLicenseExpression('(MIT AND CC0-1.0)', ALLOWED_LICENSES)).toBe(true);
    expect(evaluateLicenseExpression('(MIT AND GPL-3.0-only)', ALLOWED_LICENSES)).toBe(false);
  });

  it('fails closed on ambiguous mixed OR/AND precedence', () => {
    expect(evaluateLicenseExpression('MIT AND ISC OR GPL-3.0-only', ALLOWED_LICENSES)).toBe(false);
    expect(evaluateLicenseExpression('MIT OR ISC AND GPL-3.0-only', ALLOWED_LICENSES)).toBe(false);
  });

  it('strips a WITH exception per-term', () => {
    expect(evaluateLicenseExpression('Apache-2.0 WITH LLVM-exception', ALLOWED_LICENSES)).toBe(
      true,
    );
    expect(
      evaluateLicenseExpression('(MIT OR Apache-2.0 WITH LLVM-exception)', ALLOWED_LICENSES),
    ).toBe(true);
    expect(
      evaluateLicenseExpression('GPL-3.0-only WITH Classpath-exception-2.0', ALLOWED_LICENSES),
    ).toBe(false);
  });

  it('tolerates surrounding parens and whitespace', () => {
    expect(evaluateLicenseExpression('  ( MIT ) ', ALLOWED_LICENSES)).toBe(true);
  });
});

describe('auditLicenses', () => {
  const permissive: LicenseListMap = {
    MIT: [{ name: 'a', versions: ['1.0.0'] }],
    'Apache-2.0': [{ name: 'b', versions: ['2.0.0'] }],
    'MPL-2.0': [{ name: 'lightningcss', versions: ['1.0.0'] }],
  };

  it('passes an all-permissive tree', () => {
    const r = auditLicenses(permissive, ALLOWED_LICENSES);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('flags a copyleft bucket with its packages', () => {
    const map: LicenseListMap = {
      ...permissive,
      'GPL-3.0-only': [{ name: 'bad', versions: ['9.9.9'] }],
    };
    const r = auditLicenses(map, ALLOWED_LICENSES);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({
      license: 'GPL-3.0-only',
      packages: [{ name: 'bad', versions: ['9.9.9'] }],
    });
  });

  it('flags an Unknown bucket (fail-closed on missing license metadata)', () => {
    const map: LicenseListMap = { Unknown: [{ name: 'mystery', versions: ['0.0.0'] }] };
    const r = auditLicenses(map, ALLOWED_LICENSES);
    expect(r.ok).toBe(false);
    expect(r.violations[0]?.license).toBe('Unknown');
  });
});

describe('assertPlausibleTree', () => {
  it('accepts a tree at or above the floor', () => {
    const map: LicenseListMap = {
      MIT: Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, versions: ['1.0.0'] })),
    };
    expect(() => assertPlausibleTree(map, 50)).not.toThrow();
  });

  it('throws on an empty map (fail-closed against a silent no-op audit)', () => {
    expect(() => assertPlausibleTree({}, 50)).toThrow();
  });

  it('throws on an implausibly small tree', () => {
    const map: LicenseListMap = { MIT: [{ name: 'only', versions: ['1.0.0'] }] };
    expect(() => assertPlausibleTree(map, 50)).toThrow();
  });
});
