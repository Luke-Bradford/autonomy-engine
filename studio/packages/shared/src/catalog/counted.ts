/**
 * `n` and its unit, singular for one: "1 byte", "3 files", "2 minutes". The
 * one pluraliser for prose the catalog and its activities write (#1600 OR41
 * C6b folded `connection-config.ts`'s copy and the files Copy's into it).
 * An English unit whose plural is not `+s` is not one this serves.
 */
export function counted(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}
