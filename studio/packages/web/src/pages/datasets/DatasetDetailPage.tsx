import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type {
  Dataset,
  DatasetReference,
  DatasetReferencesResponse,
  MappingAgreementNote,
} from '@autonomy-studio/shared';
import type { ConnectionPublic } from '@autonomy-studio/shared';
import { listConnections } from '../../api/connections';
import { getDataset, getDatasetReferences } from '../../api/datasets';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';
import { pipelinePath } from '../author/pipelinePath';
import { StoreCell } from './StoreCell';

/**
 * #996 M9 (#1185) — the dataset detail page: which of this owner's pipelines
 * reference this dataset, and which of their pinned mappings no longer agree
 * with the columns it declares.
 *
 * §2.1 calls this a READ-SIDE AFFORDANCE, not a write-side gate, and the wording
 * on this page has to hold that line. A dataset's declared column list is §7's
 * schema (1); the dispatch gate compares the node's mapping against the store's
 * ACTUAL columns, schema (3). So a row flagged here MAY still run — the store
 * may have the column the dataset forgot to declare — and a row that agrees here
 * is not a promise the copy succeeds. Nothing on this page may say "will fail".
 */

const NOTE_PROSE: Record<MappingAgreementNote['kind'], (columns: readonly string[]) => string> = {
  source_missing: (c) => `reads ${list(c)}, which this dataset no longer declares`,
  source_ambiguous: (c) => `reads ${list(c)}, which matches more than one declared column`,
  source_unmapped: (c) => `does not read ${list(c)}`,
  sink_undeclared: (c) => `writes ${list(c)}, which this dataset does not declare`,
  sink_required_unwritten: (c) => `writes nothing into ${list(c)}, which cannot be null`,
  sink_optional_unwritten: (c) => `writes nothing into ${list(c)}`,
  sink_duplicate_write: (c) => `writes ${list(c)}, two spellings of one column`,
};

function list(columns: readonly string[]): string {
  return columns.map((c) => `“${c}”`).join(', ');
}

const BINDING_PROSE: Record<string, string> = {
  latest: 'latest version',
  active: 'published version',
  trigger: 'pinned by a trigger',
};

export function DatasetDetailPage({ datasetId }: { datasetId: string }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [refs, setRefs] = useState<DatasetReferencesResponse | null>(null);
  const [connections, setConnections] = useState<readonly ConnectionPublic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const guardedLoad = useGuardedLoad();

  // ONE guarded load writing both targets from a single response, the shape
  // `useGuardedLoad` blesses: the verdicts were computed against the very
  // columns this page is about to print, so two independent loads could render
  // a drift flag beside a column list from a different moment.
  const refresh = useCallback(
    () =>
      guardedLoad(
        // `Promise.all`, not three awaits: the three reads are independent, and
        // the `TriggersPage` precedent for a multi-read guarded load is the
        // parallel one. Sequential would triple the page's time to first paint
        // for no ordering the page actually needs.
        async (signal) => {
          const [row, references, conns] = await Promise.all([
            getDataset(datasetId, signal),
            getDatasetReferences(datasetId, signal),
            listConnections(signal),
          ]);
          return { dataset: row, references, connections: conns };
        },
        {
          onData: ({ dataset: row, references, connections: conns }) => {
            setDataset(row);
            setRefs(references);
            setConnections(conns);
            setLoadError(null);
          },
          onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
        },
      ),
    [guardedLoad, datasetId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="dataset-detail-heading">
      <div className="page-header">
        <h2 id="dataset-detail-heading">{dataset ? dataset.name : 'Dataset'}</h2>
        <Link to="/manage/datasets">Back to datasets</Link>
      </div>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {dataset === null && !loadError && <p>Loading dataset…</p>}

      {dataset !== null && (
        <>
          <dl className="run-meta">
            <dt>Kind</dt>
            <dd>
              <code>{dataset.kind}</code>
            </dd>
            <dt>Store</dt>
            <dd>
              {/* The SAME cell the list renders, so the detail page cannot say
                  less about a dataset than the row it was reached from — it
                  resolves the connection's name and carries #1145's kind
                  advisory. */}
              <StoreCell
                connections={connections}
                connectionId={dataset.connectionId}
                datasetKind={dataset.kind}
              />
            </dd>
            <dt>Declared columns</dt>
            <dd>
              {dataset.columns.length === 0 ? (
                'none declared'
              ) : (
                <ul className="plain-list">
                  {dataset.columns.map((column) => (
                    <li key={column.name}>
                      <code>{column.name}</code> {column.type}
                      {!column.nullable && ' · not null'}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>

          <h3 id="dataset-references-heading">Used by</h3>
          <p className="page-hint">
            Advisory, not a gate. This compares each pipeline’s pinned column mapping against the
            columns declared above; what a copy is actually checked against at run time is the
            store’s real columns, so a flagged mapping may still run and an unflagged one is not a
            guarantee.
          </p>
          {refs !== null && <ReferenceList refs={refs} />}
        </>
      )}
    </section>
  );
}

function ReferenceList({ refs }: { refs: DatasetReferencesResponse }) {
  return (
    <>
      {refs.references.length === 0 ? (
        <p>
          No pipeline references this dataset. Only each pipeline’s latest version, its published
          version, and any version a trigger pins are checked — an older version kept for a rerun is
          not.
        </p>
      ) : (
        <table aria-labelledby="dataset-references-heading">
          <thead>
            <tr>
              <th scope="col">Pipeline</th>
              <th scope="col">Version</th>
              <th scope="col">Node</th>
              <th scope="col">Bound as</th>
              <th scope="col">Mapping</th>
            </tr>
          </thead>
          <tbody>
            {refs.references.map((reference) => (
              <ReferenceRow key={rowKey(reference)} reference={reference} />
            ))}
          </tbody>
        </table>
      )}

      {refs.dynamic.length > 0 && (
        <p className="contract-advisory">
          {refs.dynamic.length} node
          {refs.dynamic.length === 1 ? '' : 's'} choose their dataset with an expression, so whether
          they use this one is only known when they run:{' '}
          {refs.dynamic.map((d) => `${d.pipelineName} · ${d.nodeId} (${d.end})`).join(', ')}.
        </p>
      )}
    </>
  );
}

function rowKey(reference: DatasetReference): string {
  return `${reference.versionId}:${reference.nodeId}:${reference.end}`;
}

function ReferenceRow({ reference }: { reference: DatasetReference }) {
  return (
    <tr>
      <td>
        <Link to={pipelinePath(reference.pipelineId)}>{reference.pipelineName}</Link>
        {reference.pipelineArchived && (
          <>
            {' '}
            <span className="contract-advisory">archived</span>
          </>
        )}
      </td>
      <td>v{reference.version}</td>
      <td>
        <code>{reference.nodeId}</code> ({reference.end})
      </td>
      <td>{reference.boundBy.map((binding) => BINDING_PROSE[binding] ?? binding).join(', ')}</td>
      <td>
        <MappingVerdict reference={reference} />
      </td>
    </tr>
  );
}

/**
 * `unreadable` is rendered as its own state, never folded into either verdict.
 * A `copy` node whose mapping cannot be read is an UNKNOWN, and printing an
 * unknown as "agrees" would manufacture reassurance out of an absent fact.
 */
function MappingVerdict({ reference }: { reference: DatasetReference }) {
  if (reference.status === 'unreadable') {
    return <span className="contract-advisory">unreadable — {reference.unreadable}</span>;
  }
  // #1221 — NOT an advisory, deliberately. A `lookup` reads the dataset whole
  // and has no column mapping, so there is nothing here that could disagree;
  // styling it like a problem would make this page cry wolf on every correct
  // lookup, which is the failure the fourth status was added to prevent.
  if (reference.status === 'not_applicable') {
    return <span>reads the whole dataset — no column mapping to check</span>;
  }
  const agreement = reference.agreement;
  if (agreement === null) return <span>—</span>;
  return (
    <>
      <span className={agreement.agrees ? '' : 'contract-advisory'}>
        {reference.status === 'agrees' ? 'agrees' : 'no longer agrees'}
      </span>
      {agreement.disagreements.length > 0 && (
        <ul className="plain-list">
          {agreement.disagreements.map((note) => (
            <li key={`${note.kind}:${note.columns.join(',')}`} className="contract-advisory">
              {NOTE_PROSE[note.kind](note.columns)}
            </li>
          ))}
        </ul>
      )}
      {agreement.informational.length > 0 && (
        <ul className="plain-list">
          {agreement.informational.map((note) => (
            <li key={`${note.kind}:${note.columns.join(',')}`}>
              {NOTE_PROSE[note.kind](note.columns)}
            </li>
          ))}
        </ul>
      )}
      {reference.mappedRows === 0 && (
        <p className="contract-advisory">
          this mapping has no rows, so the copy moves no column at all
        </p>
      )}
      {reference.unnamedRows > 0 && (
        <p className="contract-advisory">
          {reference.unnamedRows} mapping row{reference.unnamedRows === 1 ? '' : 's'} name no column
        </p>
      )}
    </>
  );
}
