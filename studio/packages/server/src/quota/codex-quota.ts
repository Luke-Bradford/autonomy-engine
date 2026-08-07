import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AccountQuotaUnavailableReason,
  type AccountQuotaWindow,
  type CodexAccountQuota,
  CodexAccountQuotaSchema,
} from '@autonomy-studio/shared';
import { isoToEpochSeconds } from './claude-quota.js';

/**
 * #990 — the codex half of the account-quota surface.
 *
 * ## Where the reading comes from, and why it is a SCRAPE
 *
 * Codex has no usage endpoint studio can poll. What it does have is a record it
 * writes for itself: every session appends JSONL to
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, and each `token_count`
 * event carries a `rate_limits` object with the account's current window
 * utilization. So this reader tails codex's own bookkeeping rather than asking
 * a provider anything.
 *
 * Two consequences follow, and both are load-bearing rather than incidental:
 *
 * 1. **The reading is as old as the operator's last codex run.** Claude's is at
 *    most one TTL old because it is polled; this one is whatever codex last
 *    wrote — minutes, or days. It therefore carries `read_at` and the panel
 *    renders it aged. A scraped snapshot shown as a live figure is precisely
 *    the fail-open presentation #987 built the aged-reading machinery for.
 * 2. **There is no credential to protect and no rate limit to respect.** This
 *    reader cannot be throttled by a provider and cannot leak a token, which is
 *    why it carries none of `claude-quota.ts`'s Keychain or 429-backoff
 *    machinery. It keeps the TTL cache for one narrower reason: a walk of the
 *    session tree is real filesystem work, and the panel may be refreshed
 *    freely.
 *
 * ## Shape decisions measured, not inherited
 *
 * The prototype's port target (`engine/lib/dashboard_state.py:247`) is the
 * right map but was NOT trusted blindly. Verified against the real tree on the
 * operator's host, 2026-08-07:
 *
 * - `resets_at` is **epoch seconds** (`1786283144`), NOT the ISO string
 *   `claude-quota.ts`'s `mapWindow` parses. Reusing that mapper would have
 *   rejected every codex window.
 * - `used_percent` is a **percent** (`64.0`) where the wire wants a fraction.
 * - `secondary` is consistently `null` on a `plus` plan: codex reports ONE
 *   window (`window_minutes: 10080`). Hence optional windows — see
 *   `CodexAccountQuotaSchema`.
 * - The newest file by mtime frequently has **no snapshot at all**, so the walk
 *   must fall through to the next file rather than conclude UNREADABLE.
 * - `plan_type` and `credits` are present in the payload and are deliberately
 *   DROPPED. #990 asks for per-window utilization, the reset instant and
 *   headroom; a plan name and a credit balance are a different question
 *   (what the account IS, not how much of the window is left) with no consumer
 *   on this surface. Noted rather than left silent because every other
 *   divergence from the prototype here is justified, and an unexplained
 *   omission reads as an oversight. One consequence is worth stating: codex has
 *   no `overage` analogue, so an account drawing on credits shows 0% headroom
 *   with no badge to explain it.
 *
 * ## Security model
 *
 * Reads only files the server process can already read, under a path derived
 * from `CODEX_HOME`/`$HOME` — never a request-controlled path, so there is no
 * traversal surface. Session records contain prompt and response text; this
 * reader parses each line ONLY for `payload.rate_limits` and returns two
 * numbers per window plus a timestamp. No transcript content is retained,
 * logged, or put on the wire. The route that serves it is display-only.
 */

/** `window_minutes` → the slot it names. Measured; the prototype agrees. */
const CODEX_WINDOW_MINUTES: Readonly<Record<number, 'five_hour' | 'seven_day'>> = Object.freeze({
  300: 'five_hour',
  10080: 'seven_day',
});

/**
 * Position → slot, used ONLY when `window_minutes` is missing or unrecognised.
 * Inherited from the prototype, and deliberately the fallback rather than the
 * rule: on the measured host `primary` IS the 7-day window, so trusting
 * position first would mislabel a real reading as the 5-hour one.
 */
const CODEX_WINDOW_POSITIONS = [
  ['primary', 'five_hour'],
  ['secondary', 'seven_day'],
] as const;

/** One minute, matching the claude reader's TTL so the panel ages uniformly. */
const DEFAULT_TTL_MS = 60_000;

/**
 * How far back a session may be and still be worth reading, 7 days.
 *
 * Bounds the walk, and bounds staleness at the width of the widest window codex
 * reports: a reading older than the window it describes has already reset and
 * would be a number about a period that has ended.
 */
const DEFAULT_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many candidate sessions to open before giving up.
 *
 * The tree grows without bound (1736 files on the measured host), and the
 * snapshot is in the newest file that has one — which is the first or second
 * candidate in every observed case. The cap stops a pathological tree turning a
 * panel refresh into an unbounded read; exhausting it reports `no_reading`,
 * which is honest, rather than a partial answer.
 */
const DEFAULT_MAX_FILES_SCANNED = 25;

/**
 * The longest a single sample may spend on the filesystem before it gives up.
 *
 * `claude-quota.ts` bounds BOTH its I/O calls (`KEYCHAIN_TIMEOUT_MS`,
 * `HTTP_TIMEOUT_MS`) because a hung one would stall a Fastify request handler
 * indefinitely. This reader runs on a request path too, and a walk has exactly
 * the same failure mode with none of the same excuses: a network-mounted home
 * directory, an autofs mount that has gone away, or simply years of session
 * history. Without a bound, every cache miss (once per TTL) can hang the
 * response, and the in-flight dedupe means it hangs every concurrent caller
 * with it.
 *
 * Exceeding it degrades to `reader_error` — an absence of evidence, which is
 * the safe direction — rather than to a partial answer assembled from whatever
 * the walk had reached. A partial walk's "newest file" is only the newest so
 * far, so a reading built from it could silently be an old one.
 */
const DEFAULT_DEADLINE_MS = 3_000;

/** Thrown internally when the walk runs out of time; never escapes `sample`. */
class DeadlineExceeded extends Error {}

export type CodexAccountQuotaReading =
  | { value: CodexAccountQuota; unavailable: null }
  | { value: null; unavailable: AccountQuotaUnavailableReason };

export interface CodexAccountQuotaReader {
  read(): Promise<CodexAccountQuotaReading>;
}

/** The reader for a host that has switched codex quota off. */
export const DISABLED_CODEX_QUOTA_READER: CodexAccountQuotaReader = {
  read: async () => ({ value: null, unavailable: 'disabled' }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `$CODEX_HOME/sessions`, or `~/.codex/sessions`. Never request-derived. */
export function defaultCodexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(home, 'sessions');
}

/**
 * Is codex a provider on THIS host at all?
 *
 * The ABSENT/UNREADABLE distinction #990 turns on. A host with no codex gets
 * the key omitted from the body entirely — saying "unreadable" about software
 * that was never installed would put a failure on the operator's panel where
 * there is none to fix.
 */
export async function codexQuotaSourcePresent(
  sessionsRoot: string = defaultCodexSessionsRoot(),
): Promise<boolean> {
  const info = await stat(sessionsRoot).catch(() => null);
  return info !== null && info.isDirectory();
}

/**
 * One codex window → the wire shape, or `null` if malformed.
 *
 * Every rejection returns `null` rather than substituting a default, for the
 * reason the whole surface exists: an unparsable window is the ABSENCE of a
 * reading, and a manufactured benign value for it reads as headroom.
 */
export function mapCodexWindow(input: unknown): AccountQuotaWindow | null {
  if (!isRecord(input)) return null;
  const used = input.used_percent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  // Integer, not merely finite: codex sends epoch SECONDS, and accepting a
  // fractional value would let a millisecond timestamp through as a reset
  // instant ~56000 years out while still looking like a number.
  const resets = input.resets_at;
  if (typeof resets !== 'number' || !Number.isInteger(resets)) return null;
  return { utilization: used / 100, resets_at: resets };
}

/**
 * A `rate_limits` object + the instant it was written → a validated reading.
 *
 * `null` whenever no window survives mapping. This is the ONE place untrusted
 * bytes are validated (`CodexAccountQuotaSchema.safeParse`), mirroring
 * `buildQuota`'s role for claude, so the route downstream can trust its input
 * without re-parsing its own output.
 */
export function buildCodexQuota(rateLimits: unknown, readAt: number): CodexAccountQuota | null {
  if (!isRecord(rateLimits)) return null;
  const windows: { five_hour?: AccountQuotaWindow; seven_day?: AccountQuotaWindow } = {};
  // TWO PASSES, because a DECLARED slot must beat a POSITIONAL GUESS regardless
  // of which entry codex happened to list first.
  //
  // One pass with "first writer wins" is wrong in a way that shows the operator
  // a real number under the wrong heading. Given `primary` with no
  // `window_minutes` and `secondary` declaring `300`, the single pass writes
  // `primary` into `five_hour` on a guess, then finds the slot taken and DROPS
  // the entry that actually said it was the 5-hour window — so a 95% figure is
  // discarded and `primary`'s 5% is captioned "5-hour". Understating usage is
  // the permissive direction, which is the one this surface may not take.
  const declared: { slot: 'five_hour' | 'seven_day'; raw: Record<string, unknown> }[] = [];
  const positional: typeof declared = [];
  for (const [key, positionalSlot] of CODEX_WINDOW_POSITIONS) {
    const raw = rateLimits[key];
    if (!isRecord(raw)) continue;
    const declaredMinutes = raw.window_minutes;
    const namedSlot =
      typeof declaredMinutes === 'number' ? CODEX_WINDOW_MINUTES[declaredMinutes] : undefined;
    if (namedSlot !== undefined) declared.push({ slot: namedSlot, raw });
    else positional.push({ slot: positionalSlot, raw });
  }
  for (const { slot, raw } of [...declared, ...positional]) {
    // A displaced positional guess is DROPPED, not re-homed into whichever slot
    // is still free. Its only claim to that slot was its position, and being
    // displaced has just shown that claim wrong — re-homing it would stack a
    // second guess on a discredited first one and caption a number with a
    // window nobody reported. Within a pass, first writer likewise wins: two
    // entries declaring the same window is a payload we have no basis to
    // arbitrate, and preferring the later one is as arbitrary as the earlier.
    if (windows[slot] !== undefined) continue;
    const window = mapCodexWindow(raw);
    if (window !== null) windows[slot] = window;
  }
  const parsed = CodexAccountQuotaSchema.safeParse({ ...windows, read_at: readAt });
  return parsed.success ? parsed.data : null;
}

interface SessionFile {
  path: string;
  mtimeMs: number;
}

async function collectSessionFiles(
  dir: string,
  cutoffMs: number,
  out: SessionFile[],
  expired: () => boolean,
): Promise<void> {
  if (expired()) throw new DeadlineExceeded();
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (expired()) throw new DeadlineExceeded();
    const path = join(dir, entry.name);
    // `isDirectory()` is false for a SYMLINK (readdir reports link entries as
    // links, verified on this platform), so the walk never follows one and a
    // symlink cycle under the sessions root cannot loop it. Real directories
    // only, which is also why no depth bound is needed: a real tree is finite.
    if (entry.isDirectory()) {
      await collectSessionFiles(path, cutoffMs, out, expired);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
    const info = await stat(path).catch(() => null);
    if (info === null || info.mtimeMs < cutoffMs) continue;
    out.push({ path, mtimeMs: info.mtimeMs });
  }
}

interface Snapshot {
  rateLimits: unknown;
  timestamp: unknown;
}

/**
 * The LAST `rate_limits` snapshot in one session file, or `null`.
 *
 * Last, not first: utilization climbs across a session, so the earliest entry
 * would understate the account by exactly the amount the session spent — an
 * error in the permissive direction.
 */
function scanSnapshot(text: string): Snapshot | null {
  let found: Snapshot | null = null;
  for (const line of text.split('\n')) {
    // Cheap reject before the parse: most lines in a session are transcript.
    if (!line.includes('"rate_limits"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated tail is normal for a session still being written. Skipping
      // the line keeps the earlier, complete snapshots in the same file usable.
      continue;
    }
    if (!isRecord(parsed)) continue;
    const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
    if (payload.type !== 'token_count') continue;
    if (!isRecord(payload.rate_limits)) continue;
    found = { rateLimits: payload.rate_limits, timestamp: parsed.timestamp };
  }
  return found;
}

export interface CodexAccountQuotaReaderOptions {
  /** The directory to walk. Defaults to `$CODEX_HOME/sessions`. */
  sessionsRoot?: string;
  now?: () => number;
  ttlMs?: number;
  cutoffMs?: number;
  maxFilesScanned?: number;
  /** Wall-clock budget for one sample's filesystem work. */
  deadlineMs?: number;
}

export function createCodexAccountQuotaReader(
  opts: CodexAccountQuotaReaderOptions = {},
): CodexAccountQuotaReader {
  const sessionsRoot = opts.sessionsRoot ?? defaultCodexSessionsRoot();
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cutoffMs = opts.cutoffMs ?? DEFAULT_CUTOFF_MS;
  const maxFilesScanned = opts.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

  let cached: CodexAccountQuotaReading | null = null;
  let cachedAt: number | null = null;
  let inFlight: Promise<CodexAccountQuotaReading> | null = null;

  async function sample(at: number): Promise<CodexAccountQuotaReading> {
    const rootInfo = await stat(sessionsRoot).catch(() => null);
    // Nothing to read FROM. Distinct from a source that is present and empty.
    if (rootInfo === null) return { value: null, unavailable: 'no_credential' };

    const expired = (): boolean => now() - at >= deadlineMs;
    let files: SessionFile[];
    try {
      files = [];
      await collectSessionFiles(sessionsRoot, at - cutoffMs, files, expired);
    } catch {
      // A walk that threw OR ran out of time is an absence of evidence, never
      // evidence of headroom. Both collapse to the same honest answer.
      return { value: null, unavailable: 'reader_error' };
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let sawPayloadWithoutWindow = false;
    for (const file of files.slice(0, maxFilesScanned)) {
      // Reading the files is the other half of the budget: a handful of large
      // sessions off a slow mount can exhaust it just as a wide tree can.
      if (expired()) return { value: null, unavailable: 'reader_error' };
      let text: string;
      try {
        text = await readFile(file.path, 'utf8');
      } catch {
        continue;
      }
      const snapshot = scanSnapshot(text);
      if (snapshot === null) continue;
      const readAt = isoToEpochSeconds(snapshot.timestamp) ?? Math.floor(file.mtimeMs / 1000);
      const value = buildCodexQuota(snapshot.rateLimits, readAt);
      if (value !== null) return { value, unavailable: null };
      // A snapshot that parsed but named no usable window. Remember it and keep
      // looking: an older session may still hold a good one, and only if none
      // does is "the payload was not what we expect" the honest answer.
      sawPayloadWithoutWindow = true;
    }
    return {
      value: null,
      unavailable: sawPayloadWithoutWindow ? 'unrecognized_payload' : 'no_reading',
    };
  }

  return {
    async read() {
      const at = now();
      // `at >= cachedAt` for the reason `claude-quota.ts` spells out: `now` is
      // WALL clock, so a backwards step makes the age negative — still `< ttl`,
      // which would pin a stale reading until wall time caught up.
      if (cached !== null && cachedAt !== null && at >= cachedAt && at - cachedAt < ttlMs) {
        return cached;
      }
      if (inFlight) return inFlight;
      inFlight = sample(at)
        .then((outcome) => {
          // A failure stamps the cache exactly as a success does: it REPLACES
          // the previous value rather than letting it survive, so no last-good
          // is ever served from inside the reader.
          cachedAt = at;
          cached = outcome;
          return outcome;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
