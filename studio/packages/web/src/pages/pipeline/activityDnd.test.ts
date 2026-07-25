import { describe, expect, it } from 'vitest';
import { fakeDataTransfer } from '../../testing/fakeDataTransfer';
import {
  ACTIVITY_DND_MIME,
  hasActivityDragType,
  readActivityDragType,
  setActivityDragType,
} from './activityDnd';

/** A drag carrying a real activity, as the toolbox writes it. */
function activityDrag(type: string, protectedMode = false): DataTransfer {
  const dt = fakeDataTransfer({ protectedMode });
  setActivityDragType(dt, type);
  return dt;
}

describe('setActivityDragType / readActivityDragType', () => {
  it('round-trips a catalogued activity type', () => {
    expect(readActivityDragType(activityDrag('http_request'))).toBe('http_request');
  });

  it('marks the drag as a COPY — nothing leaves the toolbox', () => {
    const dt = activityDrag('http_request');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('ignores a foreign drag that carries no activity payload', () => {
    // Dragging a file or a text selection onto the canvas must not author a node.
    const dt = fakeDataTransfer();
    dt.setData('text/plain', 'http_request');
    expect(hasActivityDragType(dt)).toBe(false);
    expect(readActivityDragType(dt)).toBeNull();
  });

  it('ignores a payload naming a type that is not in the catalog', () => {
    // The MIME type alone is not authority: another tab of an older/newer build,
    // or a hand-crafted drag, must not mint a node of an unknown type.
    const dt = fakeDataTransfer();
    dt.setData(ACTIVITY_DND_MIME, 'not_an_activity');
    expect(hasActivityDragType(dt)).toBe(true);
    expect(readActivityDragType(dt)).toBeNull();
  });

  it('ignores a payload naming the structural-call activity', () => {
    // `execute_pipeline` is catalogued but un-authorable by the generic config
    // form (#4 A9 / #425). The toolbox never offers it; this is the second gate,
    // so a payload from anywhere else cannot smuggle one in.
    const dt = fakeDataTransfer();
    dt.setData(ACTIVITY_DND_MIME, 'execute_pipeline');
    expect(readActivityDragType(dt)).toBeNull();
  });

  it('ignores an EMPTY payload under the right MIME type', () => {
    const dt = fakeDataTransfer();
    dt.setData(ACTIVITY_DND_MIME, '');
    expect(readActivityDragType(dt)).toBeNull();
  });
});

describe('hasActivityDragType (the dragover gate)', () => {
  it('recognises OUR drag while the data store is in protected mode', () => {
    // This is the case that matters: `dragover` fires with the payload
    // unreadable, so the gate MUST work off `types` alone.
    const dt = activityDrag('http_request', true);
    expect(dt.getData(ACTIVITY_DND_MIME)).toBe('');
    expect(hasActivityDragType(dt)).toBe(true);
  });

  it('still rejects a foreign drag in protected mode', () => {
    const dt = fakeDataTransfer({ protectedMode: true });
    dt.setData('Files', '');
    expect(hasActivityDragType(dt)).toBe(false);
  });

  it('is false for a null dataTransfer, which a synthetic event can carry', () => {
    expect(hasActivityDragType(null)).toBe(false);
    expect(readActivityDragType(null)).toBeNull();
  });
});
