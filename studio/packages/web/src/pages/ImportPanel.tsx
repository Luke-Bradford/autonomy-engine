import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { messageOf } from '../api/client';
import {
  describeAttention,
  describeImported,
  foreignEnvelopeKind,
  importEnvelope,
  parseEnvelopeText,
  type ImportedResource,
} from '../api/portability';
import type { ImportAttentionItem } from '@autonomy-studio/shared';
import { pipelinePath } from './author/pipelinePath';

/**
 * Bring a resource into this workspace from an export file (#959).
 *
 * ONE component, used by all three list pages, because `POST /api/import` is
 * ONE route that switches on the envelope's own `kind` — three hand-written
 * copies of this panel would drift.
 *
 * A file whose kind is not this page's is REFUSED before any request, with a
 * pointer to the section that owns it. That check is `foreignEnvelopeKind`,
 * and it is narrow on purpose: it answers "does this belong on the page I am
 * standing on", which the server cannot answer because it does not know which
 * page asked. It does NOT judge importability — an unrecognised kind is sent,
 * because the server owns that rule. The refusal matters because there is no
 * dry-run: without it, a mis-picked file is imported for real, creating a row
 * on a page that cannot show it, which the operator must then hunt down and
 * delete.
 *
 * It performs no I/O on mount — every request is behind the file picker. That
 * is a design constraint, not an accident: `routes.test.tsx` mounts every hub
 * section at once, and a page that fetches on mount has to be mocked there.
 */

/** Where each kind lives — both this page's own name and the refusal pointer. */
const SECTION: Record<ImportedResource['kind'], { label: string; path: string }> = {
  pipeline: { label: 'Author → Pipelines', path: '/author/pipelines' },
  connection: { label: 'Manage → Connections', path: '/manage/connections' },
  trigger: { label: 'Manage → Triggers', path: '/manage/triggers' },
};

interface Outcome {
  resource: ImportedResource;
  attention: ImportAttentionItem[];
}

export interface ImportPanelProps {
  /**
   * The list this panel sits beside. An import of THIS kind lands in it and
   * refreshes it; a file of any OTHER known kind is refused before any request.
   */
  listKind: ImportedResource['kind'];
  /**
   * Reload the surrounding list. Awaited, so the imported row is on screen
   * before the outcome names it — but its failure is reported SEPARATELY from
   * the import's, because by then the resource already exists.
   */
  onImported: () => Promise<void> | void;
}

export function ImportPanel({ listKind, onImported }: ImportPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A file that belongs to another section: refused locally, nothing sent. */
  const [foreign, setForeign] = useState<{ kind: ImportedResource['kind']; name: string } | null>(
    null,
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Every `setState` below follows an `await`, and this panel can be unmounted
   * mid-flight by navigating away from the page it sits on — so the writes are
   * guarded. (#958 is the same defect one page over; it is not repeated here.)
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onPick = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setForeign(null);
      setOutcome(null);
      try {
        const envelope = parseEnvelopeText(await file.text(), file.name);
        const elsewhere = foreignEnvelopeKind(envelope, listKind);
        if (elsewhere !== null) {
          // Refused HERE, before the request. `POST /api/import` would have
          // taken it and minted a real resource on another page.
          setForeign({ kind: elsewhere, name: file.name });
          return;
        }
        const result = await importEnvelope(envelope);
        const resource = describeImported(result);
        // Refresh BEFORE reporting, so the row is already on screen when the
        // message names it — but catch its failure SEPARATELY rather than
        // letting it reach the outer `catch`. Past this line the resource
        // EXISTS; reporting a failed reload as a failed import would be a false
        // negative, and `/api/import` does not dedupe, so the operator's
        // natural retry would mint a duplicate.
        let refreshFailure: string | null = null;
        try {
          await onImported();
        } catch (refreshErr) {
          refreshFailure = messageOf(refreshErr);
        }
        if (!mounted.current) return;
        setOutcome({ resource, attention: result.attention });
        if (refreshFailure !== null) {
          setError(`Imported, but this list could not be reloaded: ${refreshFailure}`);
        }
      } catch (err) {
        if (!mounted.current) return;
        setError(messageOf(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [listKind, onImported],
  );

  return (
    <section className="connection-form" aria-labelledby="import-heading">
      <h3 id="import-heading">Import</h3>
      <p className="page-hint">
        Bring in a pipeline, connection or trigger from an export file. Secrets and connection
        bindings are never exported, so an imported resource usually needs something rebound —
        whatever that is will be listed here.
      </p>
      <label>
        Export file
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear the input's value so picking the SAME file again re-fires
            // `change` — importing one file twice is a legitimate act (it mints
            // a second, independent resource) and must not silently do nothing.
            e.target.value = '';
            if (file) void onPick(file);
          }}
        />
      </label>
      {busy && <p className="notice">Importing…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {foreign && (
        <p className="error" role="alert">
          “{foreign.name}” is a {foreign.kind} export, and this is the {SECTION[listKind].label}{' '}
          list. Import it from{' '}
          <Link to={SECTION[foreign.kind].path}>{SECTION[foreign.kind].label}</Link>. Nothing was
          created.
        </p>
      )}
      {outcome && <ImportOutcome outcome={outcome} />}
    </section>
  );
}

function ImportOutcome({ outcome }: { outcome: Outcome }) {
  const { resource, attention } = outcome;
  return (
    <div className="notice" role="status">
      <p>
        {/* The id, always. `/api/import` mints a new id and does NOT dedupe by
            name, so importing one file twice leaves two resources with the
            same name — and the name alone would then say nothing. */}
        Imported {resource.kind} “{resource.name}” as <code>{resource.id}</code>.
      </p>
      {resource.kind === 'pipeline' && (
        <p>
          <Link to={pipelinePath(resource.id)}>Open {resource.name}</Link>
        </p>
      )}
      {resource.note && <p>{resource.note}</p>}
      {attention.length > 0 && (
        <>
          <p>Before it can run:</p>
          <ul>
            {attention.map((item, i) => (
              <li key={`${item.type}-${i}`}>{describeAttention(item)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
