import { useState } from 'react';
import { useBusyAction } from '../hooks/useBusyAction';
import { shortId } from './ids';

/**
 * #1392 — an id shown SHORT, with the whole id one click away.
 *
 * A page that leads with a name still owes the operator the id (to paste into
 * a query, a ticket, an API call). This shows the tail (`shortId`), carries the
 * full id in `title` for hover, and copies the FULL id — never the short one,
 * which would be a display form masquerading as a key.
 *
 * The copy button is feature-detected, as in `pages/runs/CappedValue.tsx`:
 * `navigator.clipboard` is absent outside a secure context, and offering a
 * control that cannot work is worse than not offering one. A rejected write is
 * reported, never treated as success, and the write is single-flighted through
 * `useBusyAction` for the same reason as there: two overlapping writes would
 * race for the one status line.
 */
const COPY_KEY = 'copy';

export function CopyableId({ id, noun }: { id: string; noun: string }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const copy = useBusyAction();
  const canCopy = typeof navigator !== 'undefined' && navigator.clipboard !== undefined;
  return (
    <span className="copyable-id">
      <code title={id}>{shortId(id)}</code>
      {canCopy && (
        <button
          type="button"
          className="copyable-id__copy"
          aria-label={`Copy ${noun} id`}
          disabled={copy.active.has(COPY_KEY)}
          onClick={() => {
            void copy.run(COPY_KEY, () =>
              navigator.clipboard.writeText(id).then(
                () => setResult('copied'),
                () => setResult('failed'),
              ),
            );
          }}
        >
          Copy
        </button>
      )}
      <span role="status" className="copyable-id__status">
        {result === 'copied' ? 'Copied' : result === 'failed' ? 'Could not copy' : ''}
      </span>
    </span>
  );
}
