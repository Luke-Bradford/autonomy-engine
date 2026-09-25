import {
  connectionConfigSchema,
  datasetConfigSchema,
  isNonOverridableConnectionConfigKey,
  isNonOverridableDatasetConfigKey,
  type ConnectionKind,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { deriveConfigFields } from './pipeline/configForm';
import { overridableKeys, type OverrideResource } from './pipeline/paramOverrides';

/**
 * #1305 — the rules behind a connection's or dataset's own `parameters`
 * allowlist: the config keys a node may override per dispatch. #1304 gave the
 * canvas the NODE half (the overrides themselves); this is the OWNER half, kept
 * pure so the pages' checkbox set only renders it.
 *
 * The offered keys come from the KIND's own schema, never the form's field list:
 * that list also carries keys left over from another kind (`configForm.ts`,
 * `deriveFieldsWithCarried`), and a carried key is exactly one this kind does
 * not have.
 */
export type AllowlistSubject = {
  noun: OverrideResource['noun'];
  kind: string;
  /** Keys this kind can take as an override, in schema order. */
  offered: readonly string[];
  isNonOverridable: (key: string) => boolean;
};

export function connectionAllowlistSubject(kind: ConnectionKind): AllowlistSubject {
  const isNonOverridable = (key: string) => isNonOverridableConnectionConfigKey(kind, key);
  return {
    noun: 'connection',
    kind,
    offered: overridableKeys(deriveConfigFields(connectionConfigSchema(kind)) ?? [], isNonOverridable),
    isNonOverridable,
  };
}

export function datasetAllowlistSubject(kind: DatasetKind): AllowlistSubject {
  const isNonOverridable = (key: string) => isNonOverridableDatasetConfigKey(kind, key);
  return {
    noun: 'dataset',
    kind,
    offered: overridableKeys(deriveConfigFields(datasetConfigSchema(kind)) ?? [], isNonOverridable),
    isNonOverridable,
  };
}

/**
 * Why a row is shown although the kind does not offer it. `never` is a
 * security-boundary key a run refuses whatever the allowlist says; `unknown` is
 * a key this kind does not have at all (a typo, or one left from another kind).
 */
export type StrayReason = 'never' | 'unknown';

export type AllowlistRow = { key: string; checked: boolean; stray: StrayReason | null };

/**
 * The rows the checkbox set draws: every key the kind offers, then every other
 * key the allowlist holds or held when the form opened.
 *
 * A stray key is SHOWN, never dropped, so the operator can see it and untick it.
 * Rows come from the seed AS WELL AS the live list, so unticking a stray does not
 * make its row vanish — the operator can change their mind. Keys are deduped:
 * the server stores the list as written, so `['x', 'x']` is a possible row.
 */
export function allowlistRows(
  subject: AllowlistSubject,
  seed: readonly string[],
  current: readonly string[],
): AllowlistRow[] {
  const ticked = new Set(current);
  const offered = new Set(subject.offered);
  const rows: AllowlistRow[] = subject.offered.map((key) => ({
    key,
    checked: ticked.has(key),
    stray: null,
  }));
  for (const key of new Set([...seed, ...current])) {
    if (offered.has(key)) continue;
    rows.push({
      key,
      checked: ticked.has(key),
      stray: subject.isNonOverridable(key) ? 'never' : 'unknown',
    });
  }
  return rows;
}

/** Tick or untick one key, keeping the list's order and never duplicating a key. */
export function toggleAllowlistKey(list: readonly string[], key: string, on: boolean): string[] {
  if (!on) return list.filter((k) => k !== key);
  return list.includes(key) ? [...list] : [...list, key];
}

/**
 * Whether the operator changed the allowlist. Order and duplicates are not a
 * change: the gate reads the list as a set.
 *
 * This decides whether Save SENDS `parameters` at all, and that is load-bearing.
 * An explicit `[]` CLEARS the stored allowlist (the web write schemas re-declare
 * the key `.optional()` for exactly this reason), so a save that did not touch
 * it must omit the key. Omitting it also leaves an allowlist written elsewhere
 * since the form opened alone.
 */
export function allowlistChanged(seed: readonly string[], current: readonly string[]): boolean {
  const a = new Set(seed);
  const b = new Set(current);
  return a.size !== b.size || [...a].some((k) => !b.has(k));
}
