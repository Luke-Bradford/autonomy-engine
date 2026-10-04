import { docNodeIdOf, type SkipReason } from '@autonomy-studio/shared';

/**
 * #1484 M2 — why an activity or container was skipped, in words, from the
 * reason the reducer recorded (`SkipReasonSchema`). Names come from the version
 * that ran; a ForEach's blame is an instance key (`a@1`), named by its canvas
 * node. A failure handler whose activity succeeded was simply not needed, and
 * says so rather than reading like an error.
 */
export function skipReasonText(reason: SkipReason, nameOf: (id: string) => string | null): string {
  const named = (id: string) => nameOf(id) ?? id;
  switch (reason.kind) {
    case 'branch':
      return 'branch not taken';
    case 'upstream':
      if (reason.outcome === 'failure') return `upstream failed: ${named(reason.from)}`;
      if (reason.outcome === 'skipped') return `upstream skipped: ${named(reason.from)}`;
      return `not needed: ${named(reason.from)} succeeded`;
    case 'timeout':
      return `loop timed out: ${named(reason.containerId)}`;
    case 'doomed':
      return `ForEach stopped: ${named(docNodeIdOf(reason.blame))} failed`;
  }
}
