/**
 * #1567 OR36 A5 — `node.failed.detail`: what a THROWN error can say beyond its
 * message, kept small enough to sit in every failure.
 *
 * - The cause chain: the error, then each `cause` in turn, at most
 *   `ERROR_DETAIL_MAX_CAUSES`, each message cut at `ERROR_DETAIL_MAX_MESSAGE`.
 * - The stack: frames only (the message line is the first cause), at most
 *   `ERROR_DETAIL_MAX_FRAMES`, with every absolute path trimmed to the part
 *   from `packages/` or `node_modules/` on, so the log names no home directory.
 *
 * A non-Error throw has no cause and no stack, so it records nothing.
 */
import type { ErrorDetail } from './types.js';
import { surrogateSafeCut } from './surrogate.js';

export const ERROR_DETAIL_MAX_CAUSES = 5;
export const ERROR_DETAIL_MAX_MESSAGE = 1_000;
export const ERROR_DETAIL_MAX_FRAMES = 20;

const cut = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, surrogateSafeCut(s, max))}…`;

/** A frame with its absolute path trimmed to `packages/…` or `node_modules/…`. */
export function trimFramePath(frame: string): string {
  return frame
    .replace(/(?<=[\s(])(?:file:\/\/)?\/[^\s():]*?\/(packages|node_modules)\//g, '$1/')
    .replace(/(?<=[\s(])(?:file:\/\/)?\/[^\s():]*\/([^/\s():]+:\d+:\d+)/g, '$1');
}

export function errorDetail(err: unknown): ErrorDetail | undefined {
  if (!(err instanceof Error)) return undefined;
  const causes: ErrorDetail['causes'] = [];
  const seen = new Set<unknown>();
  let at: unknown = err;
  while (at !== undefined && at !== null && causes.length < ERROR_DETAIL_MAX_CAUSES) {
    if (seen.has(at)) break;
    seen.add(at);
    const message = at instanceof Error ? at.message : String(at);
    const code = (at as { code?: unknown }).code;
    causes.push({
      message: cut(message, ERROR_DETAIL_MAX_MESSAGE),
      ...(typeof code === 'string' ? { code } : {}),
    });
    at = at instanceof Error ? at.cause : undefined;
  }
  const frames = (err.stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, ERROR_DETAIL_MAX_FRAMES)
    .map(trimFramePath);
  return { causes, ...(frames.length > 0 ? { stack: frames } : {}) };
}
