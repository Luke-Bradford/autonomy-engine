import { useEffect, useRef, useState } from 'react';

/**
 * #1347 — a row list's ↑ / ↓, shared by the config row list
 * (`ObjectListControl`) and a Script's blocks (`ScriptBlocksEditor`). `move`
 * writes the reordered rows and bumps `moves`, which a list keys its rows by so
 * a moved row's controls remount with its content.
 *
 * Where the last move put its row is remembered: the buttons are index-keyed,
 * so the focused one now belongs to the row that shifted the other way. Focus
 * follows the moved row instead, found in `groupRef` by `buttonName`, so
 * pressing again keeps moving it.
 */
export function useRowMoves<T>(
  rows: readonly T[],
  onChange: (next: readonly T[]) => void,
  buttonName: (index: number, direction: 'up' | 'down') => string,
) {
  const [moves, setMoves] = useState(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const moved = useRef<{
    index: number;
    direction: 'up' | 'down';
    name: typeof buttonName;
  } | null>(null);
  const move = (from: number, to: number) => {
    const next = [...rows];
    const [row] = next.splice(from, 1);
    if (row === undefined) return;
    next.splice(to, 0, row);
    moved.current = { index: to, direction: to < from ? 'up' : 'down', name: buttonName };
    setMoves((n) => n + 1);
    onChange(next);
  };
  useEffect(() => {
    const target = moved.current;
    moved.current = null;
    if (target === null) return;
    const byName = (direction: 'up' | 'down') =>
      Array.from(groupRef.current?.querySelectorAll('button') ?? []).find(
        (b) => b.getAttribute('aria-label') === target.name(target.index, direction),
      );
    // At either end the same direction is disabled, and a disabled button
    // cannot hold focus; the other direction is the row's only move left.
    const same = byName(target.direction);
    (same && !same.disabled ? same : byName(target.direction === 'up' ? 'down' : 'up'))?.focus();
  }, [moves]);
  return { moves, move, groupRef };
}
