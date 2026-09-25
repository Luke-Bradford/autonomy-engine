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
import type { ConnectionPublic, ExportKind, ImportAttentionItem } from '@autonomy-studio/shared';
import { LabelledControl } from '../lib/LabelledControl';
import { pipelinePath } from './author/pipelinePath';

/**
 * Bring a resource into this workspace from an export file (#959).
 *
 * ONE component, used by every list page that holds an exportable kind, because `POST /api/import` is
 * ONE route that switches on the envelope's own `kind` — hand-written copies of
 * this panel would drift.
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

/**
 * Where each kind lives — both this page's own name and the refusal pointer.
 *
 * Keyed by `ExportKind`, NOT by `ImportedResource['kind']` (#1114): the table
 * must cover every kind `foreignEnvelopeKind` can return, which derives from
 * `ExportEnvelopeSchema`. Keyed by the narrower type, a kind the two disagreed
 * on would read `SECTION[foreign.kind]` as UNDEFINED and crash the panel on
 * `.label`, which no type error would catch.
 *
 * #1143 — every kind now has a page that imports it, so every entry is a path.
 * `dataset` was `null` until single-file dataset import existed: pointing at a
 * page that would refuse the file too is worse than saying nothing.
 */
const SECTION: Record<ExportKind, { label: string; path: string }> = {
  pipeline: { label: 'Author → Pipelines', path: '/author/pipelines' },
  connection: { label: 'Manage → Connections', path: '/manage/connections' },
  trigger: { label: 'Manage → Triggers', path: '/manage/triggers' },
  dataset: { label: 'Manage → Datasets', path: '/manage/datasets' },
};

interface Outcome {
  resource: ImportedResource;
  attention: ImportAttentionItem[];
}

interface ImportPanelBaseProps {
  /**
   * Reload the surrounding list. Awaited, so the imported row is on screen
   * before the outcome names it — but its failure is reported SEPARATELY from
   * the import's, because by then the resource already exists.
   *
   * "Awaited" is weaker than it reads, and deliberately so. Every current
   * caller hands over a `useGuardedLoad` refresh, whose promise resolves the
   * same way whether the answer was written, dropped as superseded, or never
   * requested because the page unmounted; failures go to that page's own error
   * slot, not to this promise. So a resolved `onImported` is evidence the
   * reload was ISSUED, not that the row is on screen — which is why the outcome
   * below names the resource from the IMPORT's own response rather than from
   * anything the list went on to show.
   */
  onImported: () => Promise<void> | void;
}

/**
 * The list this panel sits beside (`listKind`). An import of THIS kind lands in
 * it and refreshes it; a file of any OTHER known kind is refused before any
 * request.
 *
 * #1143 — a dataset's list also hands over `stores`, the connections a dataset
 * file may be landed in. A dataset cannot exist without a store, so its import
 * must be told one or resolve it; a discriminated prop rather than an optional
 * one, so no other list can be handed a picker it would never render. A prop and
 * not a fetch, because this panel performs no I/O on mount (see above).
 */
export type ImportPanelProps = ImportPanelBaseProps &
  (
    | { listKind: Exclude<ImportedResource['kind'], 'dataset'>; stores?: never }
    | { listKind: 'dataset'; stores: readonly ConnectionPublic[] }
  );

export function ImportPanel({ listKind, onImported, stores }: ImportPanelProps) {
  const [busy, setBusy] = useState(false);
  /** #1143 — the chosen store for a dataset file; `''` = resolve it by identity. */
  const [store, setStore] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A file that belongs to another section: refused locally, nothing sent.
   * `ExportKind`, not `ImportedResource['kind']` — this can be a kind the import
   * route refuses outright (#1114). */
  const [foreign, setForeign] = useState<{ kind: ExportKind; name: string } | null>(null);
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
          //
          // Guarded like every other write in this function: `await
          // file.text()` above is a suspension point, so the panel can already
          // be unmounted by the time we get here.
          if (!mounted.current) return;
          setForeign({ kind: elsewhere, name: file.name });
          return;
        }
        const result =
          listKind === 'dataset' && store !== ''
            ? await importEnvelope(envelope, { connectionId: store })
            : await importEnvelope(envelope);
        const resource = describeImported(result);
        // Refresh BEFORE reporting, so the row is on screen when the message
        // names it — as strongly as an awaited refresh can promise that, which
        // is weaker than it sounds (see the prop's docblock) — but catch its
        // failure SEPARATELY rather than letting it reach the outer `catch`.
        // Past this line the resource EXISTS; reporting a failed reload as a
        // failed import would be a false negative, and `/api/import` does not
        // dedupe, so the operator's natural retry would mint a duplicate.
        //
        // No CURRENT caller can reach this catch — every one routes its
        // failures into their own error slot (see the prop's docblock) — but the
        // prop's contract permits a rejecting `onImported`, so the guard stays
        // rather than becoming a trap for the next caller to write one.
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
    [listKind, onImported, store],
  );

  return (
    <section className="connection-form" aria-labelledby="import-heading">
      <h3 id="import-heading">Import</h3>
      <p className="page-hint">
        Bring in a pipeline, connection, trigger or dataset from an export file. Secrets are never
        exported, and neither is a pipeline&rsquo;s or trigger&rsquo;s binding to anything else, so
        an imported resource usually needs something rebound — whatever that is will be listed here.
      </p>
      {stores !== undefined && (
        <>
          {/* #1143 — chosen BEFORE the file: picking the file IS the import. */}
          <LabelledControl label="Store it in">
            {(id) => (
              <select
                id={id}
                value={store}
                disabled={busy}
                onChange={(e) => setStore(e.target.value)}
              >
                <option value="">The connection it was exported from</option>
                {stores.map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.name} ({conn.kind})
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
          <p className="page-hint">
            {stores.length === 0
              ? 'A dataset lives in a store, and there are no connections here yet — add one under Manage → Connections first.'
              : 'A dataset file names the connection it was exported from, which is only here if this is that workspace (or one synced from the same git repo). From anywhere else, choose the connection it should live in.'}
          </p>
        </>
      )}
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
