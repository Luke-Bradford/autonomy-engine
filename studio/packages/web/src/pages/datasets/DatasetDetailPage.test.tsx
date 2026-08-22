import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { Dataset, DatasetReference, DatasetReferencesResponse } from '@autonomy-studio/shared';
import { DatasetDetailPage } from './DatasetDetailPage';
import * as datasetsApi from '../../api/datasets';
import * as connectionsApi from '../../api/connections';
import { renderWithRouter } from '../../testing/renderWithRouter';

vi.mock('../../api/datasets', async (importActual) => ({
  ...(await importActual<typeof import('../../api/datasets')>()),
  getDataset: vi.fn(),
  getDatasetReferences: vi.fn(),
}));

vi.mock('../../api/connections', async (importActual) => ({
  ...(await importActual<typeof import('../../api/connections')>()),
  listConnections: vi.fn(),
}));

const getMock = vi.mocked(datasetsApi.getDataset);
const connectionsMock = vi.mocked(connectionsApi.listConnections);
const refsMock = vi.mocked(datasetsApi.getDatasetReferences);

const dataset: Dataset = {
  id: 'ds_1',
  resourceId: 'res_ds_1',
  ownerId: 'local',
  name: 'Customers',
  kind: 'table',
  connectionId: 'conn_1',
  config: { table: 'customers' },
  columns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'email', type: 'string', nullable: true },
  ],
  parameters: [],
  createdAt: 1,
  updatedAt: 1,
};

function reference(overrides: Partial<DatasetReference> = {}): DatasetReference {
  return {
    pipelineId: 'pipe_1',
    pipelineName: 'Nightly load',
    pipelineArchived: false,
    versionId: 'pv_1',
    version: 3,
    boundBy: ['latest'],
    triggerIds: [],
    nodeId: 'copy1',
    nodeType: 'copy',
    end: 'sink',
    status: 'agrees',
    agreement: { agrees: true, disagreements: [], informational: [] },
    unreadable: null,
    unnamedRows: 0,
    mappedRows: 2,
    ...overrides,
  };
}

function resolve(refs: Partial<DatasetReferencesResponse> = {}): void {
  getMock.mockResolvedValue(dataset);
  refsMock.mockResolvedValue({ references: [], dynamic: [], ...refs });
  connectionsMock.mockResolvedValue([{ id: 'conn_1', name: 'Warehouse', kind: 'sqlite' } as never]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DatasetDetailPage (#996 M9)', () => {
  it('names the dataset and lists the columns it declares', async () => {
    resolve();
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(await screen.findByRole('heading', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText(/not null/)).toBeInTheDocument();
  });

  /**
   * #1242 — the back link's TREATMENT, not merely its presence.
   *
   * `page-back` is not decoration here: `index.css` styles the header chip by
   * that class alone (a `.page-header a` descendant selector was rejected in
   * #1239, because `.page-header` is a layout wrapper 18 pages put arbitrary
   * content in). So the class IS the contract, and dropping it silently
   * downgrades the control to accent-coloured prose — a change jsdom cannot
   * see, since it computes no cascade. The resolved colours are pinned in
   * `e2e/bug-sweep.spec.ts`; what this file owns is that the opt-in is made.
   */
  it('offers a back link that is an anchor, addressed, and carries the header treatment', async () => {
    resolve();
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    const back = await screen.findByRole('link', { name: 'Back to datasets' });
    expect(back).toHaveAttribute('href', '/manage/datasets');
    expect(back).toHaveClass('page-back');
  });

  it('lists a referencing pipeline with the version and the end it binds', async () => {
    resolve({ references: [reference()] });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    const row = await screen.findByRole('row', { name: /Nightly load/ });
    expect(within(row).getByText('v3')).toBeInTheDocument();
    expect(within(row).getByText(/sink/)).toBeInTheDocument();
    expect(within(row).getByText('latest version')).toBeInTheDocument();
    expect(within(row).getByText('agrees')).toBeInTheDocument();
  });

  /**
   * The route reads the id back with `useParams`, which decodes exactly once,
   * so the link must encode exactly once. Today's `pl_`+nanoid alphabet needs
   * no escaping, which is precisely why a raw template string here would look
   * correct until the alphabet widened.
   */
  it('encodes a pipeline id that needs escaping, rather than splitting it across segments', async () => {
    resolve({ references: [reference({ pipelineId: 'pl/1' })] });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    const link = await screen.findByRole('link', { name: 'Nightly load' });
    expect(link).toHaveAttribute('href', '/author/pipelines/pl%2F1');
  });

  it('names the columns a mapping no longer agrees on, rather than only flagging it', async () => {
    resolve({
      references: [
        reference({
          status: 'disagrees',
          agreement: {
            agrees: false,
            disagreements: [{ kind: 'sink_required_unwritten', columns: ['id'] }],
            informational: [],
          },
        }),
      ],
    });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(await screen.findByText(/no longer agrees/)).toBeInTheDocument();
    expect(screen.getByText(/writes nothing into “id”, which cannot be null/)).toBeInTheDocument();
  });

  it('renders an unreadable mapping as its own state, never as agreement', async () => {
    resolve({
      references: [
        reference({
          status: 'unreadable',
          agreement: null,
          unreadable: 'this node declares no column mapping',
        }),
      ],
    });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(
      await screen.findByText(/unreadable — this node declares no column mapping/),
    ).toBeInTheDocument();
    expect(screen.queryByText('agrees')).not.toBeInTheDocument();
  });

  it('says which nodes pick their dataset by expression, so an empty list is not read as "none"', async () => {
    resolve({
      dynamic: [
        {
          pipelineId: 'pipe_2',
          pipelineName: 'Dynamic load',
          versionId: 'pv_2',
          version: 1,
          nodeId: 'copy9',
          nodeType: 'copy',
          end: 'source',
        },
      ],
    });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(await screen.findByText(/choose their dataset with an expression/)).toBeInTheDocument();
    expect(screen.getByText(/Dynamic load · copy9 \(source\)/)).toBeInTheDocument();
  });

  it('states the version bound when nothing references it, rather than a bare "none"', async () => {
    resolve();
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    // The empty answer is only true of the versions actually walked — saying so
    // is what stops it reading as "this dataset is unused".
    expect(await screen.findByText(/No pipeline references this dataset/)).toBeInTheDocument();
    expect(screen.getByText(/an older version kept for a rerun is not/)).toBeInTheDocument();
  });

  it('flags an archived pipeline rather than hiding it', async () => {
    resolve({ references: [reference({ pipelineArchived: true })] });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    const row = await screen.findByRole('row', { name: /Nightly load/ });
    expect(within(row).getByText('archived')).toBeInTheDocument();
  });

  it('names the store rather than printing its id, as the list row does', async () => {
    resolve();
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(await screen.findByText('Warehouse')).toBeInTheDocument();
    expect(screen.queryByText('conn_1')).not.toBeInTheDocument();
  });

  it('says a mapping with no rows moves nothing, which the verdict alone cannot', async () => {
    // An empty mapping disagrees with nothing on the SOURCE side, so it would
    // otherwise render as a bare "agrees" for a copy that moves no column.
    resolve({
      references: [reference({ end: 'source', mappedRows: 0 })],
    });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    expect(await screen.findByText(/this mapping has no rows/)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering an empty page', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    refsMock.mockResolvedValue({ references: [], dynamic: [] });
    connectionsMock.mockResolvedValue([]);
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'));
  });
});
