import { describe, expect, it } from 'vitest';
import {
  SESSION_LOG_RUN_MAX_LINES,
  SessionLog,
  sessionLogRunValues,
  sessionLogText,
} from '../session-log.js';

/** #1600 OR41 C9c — the session log's lines, shared by Delete and Copy's C6 (catalogue §5). */
const at = (iso: string) => () => new Date(iso);

describe('SessionLog', () => {
  it('Everything keeps every line, Warnings drops Info, Off keeps none', () => {
    const add = (log: SessionLog) => {
      log.add('Info', 'FileDelete', 'a.txt', 'deleted');
      log.add('Warning', 'FileSkip', 'b.txt', 'skipped');
      log.add('Error', 'FileDelete', 'c.txt', 'EACCES');
      return log.lines.map((l) => l.level);
    };
    expect(add(new SessionLog('info'))).toEqual(['Info', 'Warning', 'Error']);
    expect(add(new SessionLog('warning'))).toEqual(['Warning', 'Error']);
    expect(add(new SessionLog('off'))).toEqual([]);
  });

  it('stamps each line when it is added', () => {
    let t = 0;
    const log = new SessionLog('info', () => new Date(Date.UTC(2026, 9, 17, 0, 0, t++)));
    log.add('Info', 'FileDelete', 'a.txt', 'deleted');
    log.add('Info', 'FileDelete', 'b.txt', 'deleted');
    expect(log.lines.map(sessionLogText)).toEqual([
      '2026-10-17T00:00:00.000Z Info FileDelete a.txt deleted',
      '2026-10-17T00:00:01.000Z Info FileDelete b.txt deleted',
    ]);
  });
});

describe('sessionLogRunValues', () => {
  const lines = (n: number) => {
    const log = new SessionLog('info', at('2026-10-17T00:00:00Z'));
    for (let i = 0; i < n; i += 1) log.add('Info', 'FileDelete', `f${i}`, 'deleted');
    return log.lines;
  };

  it(`keeps up to ${SESSION_LOG_RUN_MAX_LINES} lines whole`, () => {
    expect(sessionLogRunValues(lines(SESSION_LOG_RUN_MAX_LINES))).toHaveLength(
      SESSION_LOG_RUN_MAX_LINES,
    );
  });

  it('past the cap, an Error line is still kept, ahead of the count', () => {
    const log = new SessionLog('info', at('2026-10-17T00:00:00Z'));
    for (let i = 0; i < SESSION_LOG_RUN_MAX_LINES + 2; i += 1)
      log.add('Info', 'FileDelete', `f${i}`, 'deleted');
    log.add('Error', 'FileDelete', 'last', 'EACCES');
    const values = sessionLogRunValues(log.lines, at('2026-10-17T00:00:09Z'));
    expect(values).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 2);
    expect(values.at(-2)).toBe('2026-10-17T00:00:00.000Z Error FileDelete last EACCES');
    expect(values.at(-1)).toContain(' 2 more lines not kept');
  });

  it('past the cap, keeps the first lines and ends with how many more there were', () => {
    const values = sessionLogRunValues(
      lines(SESSION_LOG_RUN_MAX_LINES + 1),
      at('2026-10-17T00:00:09Z'),
    );
    expect(values).toHaveLength(SESSION_LOG_RUN_MAX_LINES + 1);
    expect(values[0]).toBe('2026-10-17T00:00:00.000Z Info FileDelete f0 deleted');
    expect(values.at(-1)).toBe(
      '2026-10-17T00:00:09.000Z Warning SessionLog  1 more line not kept in the run log; write the session log to a folder to keep every line',
    );
  });
});
