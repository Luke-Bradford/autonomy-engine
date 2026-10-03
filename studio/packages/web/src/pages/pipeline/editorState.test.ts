import { describe, expect, it } from 'vitest';
import { canvasVersion, editingState, liveState, type EditingInput } from './editorState';

const base: EditingInput = {
  dirty: false,
  loadedVersion: 3,
  headVersion: 3,
  previewedVersion: null,
};

describe('editingState', () => {
  it('a clean canvas on the head reads as the latest version', () => {
    expect(editingState(base)).toMatchObject({ label: 'v3 (latest)', tone: 'neutral' });
  });

  it('a dirty canvas is a draft on the version it was opened from', () => {
    const p = editingState({ ...base, dirty: true });
    expect(p).toMatchObject({ label: 'Draft · v3', tone: 'warning' });
    expect(p.detail).toContain('Draft — unsaved changes on v3.');
  });

  it('names the LOADED version, not the head, when the head moved on', () => {
    // After a refused save the head is refetched; the canvas stays on v1.
    const clean = editingState({ ...base, loadedVersion: 1, headVersion: 2 });
    expect(clean).toMatchObject({ label: 'v1 · v2 is newer', tone: 'warning' });
    const dirty = editingState({ ...base, dirty: true, loadedVersion: 1, headVersion: 2 });
    expect(dirty.label).toBe('Draft · v1');
    expect(dirty.detail).toContain('v2 is newer');
  });

  it('a preview names the previewed version, and marks the head', () => {
    expect(editingState({ ...base, previewedVersion: 2 })).toMatchObject({
      label: 'Viewing v2',
      tone: 'neutral',
    });
    expect(editingState({ ...base, previewedVersion: 3 }).label).toBe('Viewing v3 (latest)');
  });

  it('a preview over unsaved changes says they are kept', () => {
    expect(editingState({ ...base, dirty: true, previewedVersion: 2 }).detail).toContain(
      'unsaved changes are kept',
    );
    expect(editingState({ ...base, previewedVersion: 2 }).detail).not.toContain('unsaved');
  });

  it('a pipeline with no saved version', () => {
    const none = { ...base, loadedVersion: null, headVersion: null };
    expect(editingState(none)).toMatchObject({ label: 'Not saved', tone: 'neutral' });
    expect(editingState({ ...none, dirty: true })).toMatchObject({
      label: 'Draft',
      tone: 'warning',
    });
  });
});

describe('canvasVersion', () => {
  it('is the preview, else the loaded version, else nothing while dirty', () => {
    expect(canvasVersion({ ...base, previewedVersion: 2 })).toBe(2);
    expect(canvasVersion({ ...base, dirty: true, previewedVersion: 2 })).toBe(2);
    expect(canvasVersion({ ...base, loadedVersion: 1, headVersion: 2 })).toBe(1);
    expect(canvasVersion({ ...base, dirty: true })).toBeNull();
  });
});

describe('liveState', () => {
  it('is hidden outside git mode and while the publish state is unread', () => {
    expect(liveState({ gitConnected: false, active: null, canvas: 3 })).toBeNull();
    expect(liveState({ gitConnected: undefined, active: null, canvas: 3 })).toBeNull();
    expect(liveState({ gitConnected: true, active: undefined, canvas: 3 })).toBeNull();
  });

  it('says when nothing is published', () => {
    expect(liveState({ gitConnected: true, active: null, canvas: 3 })).toMatchObject({
      label: 'Not published',
      tone: 'warning',
    });
  });

  it('is green with a check only when the canvas IS the live version', () => {
    expect(liveState({ gitConnected: true, active: 3, canvas: 3 })).toMatchObject({
      label: 'Live: v3',
      tone: 'success',
      current: true,
    });
    const other = liveState({ gitConnected: true, active: 2, canvas: 3 });
    expect(other).toMatchObject({ label: 'Live: v2', tone: 'warning' });
    expect(other?.current).toBeUndefined();
    expect(other?.detail).toContain('the canvas shows v3');
    const dirty = liveState({ gitConnected: true, active: 3, canvas: null });
    expect(dirty).toMatchObject({ label: 'Live: v3', tone: 'warning' });
    expect(dirty?.detail).toContain('unsaved changes');
  });

  it('an active version the page has not listed is named as such, never guessed', () => {
    expect(liveState({ gitConnected: true, active: 'unnamed', canvas: 3 })).toMatchObject({
      label: 'Live: unlisted version',
      tone: 'warning',
    });
  });
});
