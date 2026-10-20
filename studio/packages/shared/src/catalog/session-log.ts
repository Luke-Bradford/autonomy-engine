import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';

/**
 * #1600 OR41 C9c — the session log (activity catalogue §4.1, §4.4, §5), the
 * SINGLE SOURCE OF TRUTH for its settings and its lines. Delete has it from C9c;
 * Copy's C6 spreads the same fields and keeps its lines the same way.
 *
 * ADF writes a file-moving activity's log to a storage folder
 * (https://learn.microsoft.com/azure/data-factory/delete-activity,
 * https://learn.microsoft.com/azure/data-factory/copy-activity-log). Studio adds
 * the run log as a destination, and keeps one line shape for both: Timestamp,
 * Level, Operation, Item, Message (§5). `logLevel` is ADF's copy log name, with
 * `warning` and `info` read as Warnings and Everything.
 *
 * Pure: the lines are collected here, and the server writes the folder file.
 */
const logLevelSchema = z.enum(['off', 'warning', 'info']);
export type SessionLogLevel = z.infer<typeof logLevelSchema>;
const logToSchema = z.enum(['run', 'folder']);
export type SessionLogDestination = z.infer<typeof logToSchema>;

/** The stream name a run-log line travels under (`node.output`, folded inert). */
export const SESSION_LOG_OUTPUT = 'sessionLog';

/** The most lines kept in the run log. A folder keeps every line. */
export const SESSION_LOG_RUN_MAX_LINES = 1000;

/** The fields a config spreads in, with `sessionLogIssues` in its `superRefine`. */
export const sessionLogConfigFields = {
  // §4.1's default: warnings, to the run log.
  logLevel: presented(logLevelSchema.default('warning'), {
    title: 'Session log',
    description:
      'Warnings logs the items skipped or kept, and any that failed. Everything also logs each item handled.',
    options: optionTitles(logLevelSchema, { off: 'Off', warning: 'Warnings', info: 'Everything' }),
  }),
  logTo: presented(logToSchema.default('run'), {
    title: 'Write to',
    description: `Run log keeps up to ${SESSION_LOG_RUN_MAX_LINES} lines with the run, in its Logs tab. Folder writes every line to a CSV file.`,
    options: optionTitles(logToSchema, { run: 'Run log', folder: 'Folder' }),
  }),
  logFolder: presented(singleLine(z.string()).min(1).optional(), {
    title: 'Log folder',
    description:
      "The folder the CSV file is written to, on the same connection. Absolute, or relative to the connection's first allowed folder. It must exist.",
  }),
};

type SessionLogConfig = {
  logLevel: SessionLogLevel;
  logTo: SessionLogDestination;
  logFolder?: string | undefined;
};

/**
 * Refuse a session log setting that would be ignored or cannot run, rather than
 * quietly ignore it. Folder while Off is reported on `logLevel`, the field the
 * form still draws then (`logTo` is drawn only while the log is on).
 */
export function sessionLogIssues(
  cfg: SessionLogConfig,
  issue: (field: string, message: string) => void,
): void {
  if (cfg.logLevel === 'off' && cfg.logTo === 'folder') {
    issue('logLevel', 'the session log is off, but it is set to write to a folder');
  }
  if (cfg.logTo === 'folder' && cfg.logFolder === undefined) {
    issue('logFolder', 'needed to write the session log to a folder');
  }
  if (cfg.logTo !== 'folder' && cfg.logFolder !== undefined) {
    issue('logFolder', 'only read when the session log is written to a folder');
  }
}

/** The columns of a folder log, in order (§5). */
export const SESSION_LOG_COLUMNS = ['Timestamp', 'Level', 'Operation', 'Item', 'Message'] as const;

export type SessionLogLineLevel = 'Info' | 'Warning' | 'Error';

export interface SessionLogLine {
  /** When the action happened, ISO 8601 UTC. */
  timestamp: string;
  level: SessionLogLineLevel;
  /** E.g. `FileDelete`, `FileSkip`, `FolderDelete`, `FolderSkip`. */
  operation: string;
  /** The file or folder, relative to the activity's path. */
  item: string;
  message: string;
}

/** The lines a log level keeps: Warnings keeps warnings and errors, Everything all. */
function keeps(level: SessionLogLevel, line: SessionLogLineLevel): boolean {
  if (level === 'off') return false;
  return level === 'info' || line !== 'Info';
}

/**
 * The lines of one attempt, in the order they happened, already filtered by
 * the log level. Bounded by what the activity plans (Delete: the connection's
 * entry limit), not by the log, unless `keepAtMost` caps it.
 *
 * #1600 OR41 C6a — `keepAtMost`: Copy can skip a line's worth of rows per row
 * read, so a log bound for the run log keeps only what the run log shows (the
 * first lines, and an Error line past them, `sessionLogRunValues`' rule) and
 * counts the rest in `dropped`, rather than holding millions of lines it would
 * throw away.
 */
export class SessionLog {
  readonly lines: SessionLogLine[] = [];
  /** Lines the level kept that `keepAtMost` left out. */
  dropped = 0;
  private readonly keepAtMost: number | undefined;

  constructor(
    private readonly level: SessionLogLevel,
    private readonly now: () => Date = () => new Date(),
    opts: { keepAtMost?: number } = {},
  ) {
    this.keepAtMost = opts.keepAtMost;
  }

  add(level: SessionLogLineLevel, operation: string, item: string, message: string): void {
    if (!keeps(this.level, level)) return;
    if (
      this.keepAtMost !== undefined &&
      level !== 'Error' &&
      this.lines.length >= this.keepAtMost
    ) {
      this.dropped += 1;
      return;
    }
    this.lines.push({ timestamp: this.now().toISOString(), level, operation, item, message });
  }
}

/** One line as the run log shows it: every column, space-separated. */
export function sessionLogText(line: SessionLogLine): string {
  return `${line.timestamp} ${line.level} ${line.operation} ${line.item} ${line.message}`;
}

/**
 * The run log's values: one string per line, the first
 * `SESSION_LOG_RUN_MAX_LINES`, then any Error line past them (there is at most
 * one, and it says why the attempt failed), and then, LAST so it stays in the
 * Logs tab's most recent rows, one line saying how many were not kept.
 *
 * `dropped` adds the lines a capped `SessionLog` already left out (C6a).
 * `folderHint` (default on) ends that line by pointing at the folder, which only
 * an activity that can write one should do: Copy cannot until C6c.
 */
export function sessionLogRunValues(
  lines: readonly SessionLogLine[],
  now: () => Date = () => new Date(),
  opts: { dropped?: number; folderHint?: boolean } = {},
): string[] {
  const rest = lines.slice(SESSION_LOG_RUN_MAX_LINES);
  const errors = rest.filter((l) => l.level === 'Error');
  const kept = [...lines.slice(0, SESSION_LOG_RUN_MAX_LINES), ...errors].map(sessionLogText);
  const dropped = rest.length - errors.length + (opts.dropped ?? 0);
  if (dropped > 0) {
    const hint =
      opts.folderHint === false ? '' : '; write the session log to a folder to keep every line';
    kept.push(
      sessionLogText({
        timestamp: now().toISOString(),
        level: 'Warning',
        operation: 'SessionLog',
        item: '',
        message: `${dropped} more line${dropped === 1 ? '' : 's'} not kept in the run log${hint}`,
      }),
    );
  }
  return kept;
}
