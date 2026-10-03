import type { ActiveVersionLabel } from './versionHistory';

/**
 * #1476 OR28 — the editor's state badge, as pure rules.
 *
 * Colour follows ONE rule (the issue's): `success` when the live version is the
 * canvas, `warning` when something is pending (a draft, a newer head, nothing
 * published), `neutral` otherwise. The text always carries the meaning on its
 * own, so the colour is never the only cue (WCAG 1.4.1).
 *
 * Labels are SHORT on purpose: they share the fixed-height toolbar row with the
 * title, the notice strip and every action, and that row must not wrap at
 * 1280px (#1475). The sentence lives in `detail`.
 */
export type BadgeTone = 'success' | 'warning' | 'neutral';

export interface BadgePart {
  label: string;
  /** The full sentence behind the label: its tooltip and its hidden text. */
  detail: string;
  tone: BadgeTone;
  /** The canvas IS this version — drawn as a ✓ beside the label. */
  current?: boolean;
}

export interface EditingInput {
  dirty: boolean;
  /** The version the editor was opened from (`loaded`), the draft's basis. */
  loadedVersion: number | null;
  /** The newest saved version (`latestVersion`). */
  headVersion: number | null;
  /** The version shown read-only in place of the editor, or `null`. */
  previewedVersion: number | null;
}

/**
 * The version the canvas SHOWS, or `null` when it shows something no saved
 * version holds (unsaved edits, or nothing saved yet).
 *
 * `loaded`, not the head: after a refused save the head is refetched and moves
 * on while the canvas stays on the version it was opened from, and a badge
 * reading the head would then name a version that is not on screen.
 */
export function canvasVersion(s: EditingInput): number | null {
  if (s.previewedVersion !== null) return s.previewedVersion;
  return s.dirty ? null : s.loadedVersion;
}

export function editingState(s: EditingInput): BadgePart {
  if (s.previewedVersion !== null) {
    const v = s.previewedVersion;
    const isHead = v === s.headVersion;
    return {
      label: `Viewing v${String(v)}${isHead ? ' (latest)' : ''}`,
      detail:
        `A read-only preview of v${String(v)}${isHead ? ', the latest saved version' : ''}.` +
        (s.dirty ? ' Your unsaved changes are kept and return when the preview closes.' : ''),
      tone: 'neutral',
    };
  }
  if (s.loadedVersion === null) {
    return s.dirty
      ? {
          label: 'Draft',
          detail: 'Unsaved changes. Nothing is saved yet: Save version keeps them as v1.',
          tone: 'warning',
        }
      : { label: 'Not saved', detail: 'This pipeline has no saved version yet.', tone: 'neutral' };
  }
  const v = String(s.loadedVersion);
  const newer =
    s.headVersion !== null && s.headVersion > s.loadedVersion ? String(s.headVersion) : null;
  if (s.dirty) {
    return {
      label: `Draft · v${v}`,
      detail:
        `Draft — unsaved changes on v${v}.` +
        (newer !== null ? ` v${newer} is newer.` : '') +
        ' Save version keeps them as a new version.',
      tone: 'warning',
    };
  }
  if (newer !== null) {
    return {
      label: `v${v} · v${newer} is newer`,
      detail: `The canvas shows v${v}; v${newer} is the latest saved version.`,
      tone: 'warning',
    };
  }
  return { label: `v${v} (latest)`, detail: `v${v}, the latest saved version.`, tone: 'neutral' };
}

export interface LiveInput {
  /** Is a git repo connected? `undefined` while unread or after a failed read. */
  gitConnected: boolean | undefined;
  /** `activeVersionLabel(active, versions)`. */
  active: ActiveVersionLabel;
  /** `canvasVersion(...)`. */
  canvas: number | null;
}

/** Live is the ACTIVE (published) version — the word the history list uses. */
const LIVE_MEANS = 'Live is the active (published) version.';

/**
 * The live part, or `null` when it is not shown.
 *
 * Hidden outside git mode: a DB-only workspace has no publish and no active
 * pointer (triggers bind to the latest version), so "Not published" there would
 * be a false alarm. Hidden too when the publish state is UNREAD — a failed read
 * shows nothing rather than a guess (absent, not wrong).
 */
export function liveState(s: LiveInput): BadgePart | null {
  if (s.gitConnected !== true || s.active === undefined) return null;
  if (s.active === null) {
    return {
      label: 'Not published',
      detail: `No version is published yet. ${LIVE_MEANS}`,
      tone: 'warning',
    };
  }
  if (s.active === 'unnamed') {
    return {
      label: 'Live: unlisted version',
      detail: `A version published after this page loaded is live; reload to see which. ${LIVE_MEANS}`,
      tone: 'warning',
    };
  }
  const v = String(s.active);
  if (s.active === s.canvas) {
    return {
      label: `Live: v${v}`,
      detail: `v${v} is live and is what the canvas shows. ${LIVE_MEANS}`,
      tone: 'success',
      current: true,
    };
  }
  return {
    label: `Live: v${v}`,
    detail: `v${v} is live; the canvas shows ${s.canvas === null ? 'unsaved changes' : `v${String(s.canvas)}`}. ${LIVE_MEANS}`,
    tone: 'warning',
  };
}
