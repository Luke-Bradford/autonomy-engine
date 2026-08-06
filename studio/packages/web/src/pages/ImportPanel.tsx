import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { messageOf } from '../api/client';
import {
  describeAttention,
  describeImported,
  importEnvelope,
  parseEnvelopeText,
  type ImportedResource,
} from '../api/portability';
import type { ImportAttentionItem } from '@autonomy-studio/shared';
import { pipelinePath } from './author/pipelinePath';

/**
 * Bring a resource into this workspace from an export file (#959).
 *
 * ONE panel, not one per list page, because `POST /api/import` is ONE route
 * that switches on the envelope's own `kind` — pipeline, connection and
 * trigger all arrive through it. Three kind-policed copies would each be a
 * second authority on what is importable, and each would start refusing an
 * envelope the server accepts the moment a fourth kind is added. So this panel
 * takes any export file and REPORTS what it turned out to be, pointing at the
 * section that owns it when that is not the page you are standing on.
 *
 * It performs no I/O on mount — every request is behind the file picker. That
 * is a design constraint, not an accident: `routes.test.tsx` mounts every hub
 * section at once, and a page that fetches on mount has to be mocked there.
 */

/** Where a resource of each kind lives, for the "not this page" pointer. */
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
   * The list this panel sits beside. An import of THIS kind lands in it, so it
   * is refreshed; an import of another kind is reported with a pointer instead.
   */
  listKind: ImportedResource['kind'];
  /** Reload the surrounding list. Awaited, so a failure to reload is visible. */
  onImported: () => Promise<void> | void;
}

export function ImportPanel({ listKind, onImported }: ImportPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setOutcome(null);
      try {
        const envelope = parseEnvelopeText(await file.text(), file.name);
        const result = await importEnvelope(envelope);
        const resource = describeImported(result);
        // Refresh BEFORE reporting: the row the message points at should
        // already be on screen when the operator looks for it.
        if (resource.kind === listKind) await onImported();
        if (!mounted.current) return;
        setOutcome({ resource, attention: result.attention });
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
      {outcome && <ImportOutcome outcome={outcome} listKind={listKind} />}
    </section>
  );
}

function ImportOutcome({
  outcome,
  listKind,
}: {
  outcome: Outcome;
  listKind: ImportedResource['kind'];
}) {
  const { resource, attention } = outcome;
  const section = SECTION[resource.kind];
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
      {resource.kind !== listKind && (
        <p>
          It is a {resource.kind}, so it is listed under <Link to={section.path}>{section.label}</Link>
          , not on this page.
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
