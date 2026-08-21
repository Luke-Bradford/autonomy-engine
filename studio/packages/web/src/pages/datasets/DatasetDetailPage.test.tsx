import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import type { Dataset, DatasetReference, DatasetReferencesResponse } from '@autonomy-studio/shared';
import { DatasetDetailPage } from './DatasetDetailPage';
import * as datasetsApi from '../../api/datasets';
import { renderWithRouter } from '../../testing/renderWithRouter';

vi.mock('../../api/datasets', async (importActual) => ({
  ...(await importActual<typeof import('../../api/datasets')>()),
  getDataset: vi.fn(),
  getDatasetReferences: vi.fn(),
}));

const getMock = vi.mocked(datasetsApi.getDataset);
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
    ...overrides,
  };
}

function resolve(refs: Partial<DatasetReferencesResponse> = {}): void {
  getMock.mockResolvedValue(dataset);
  refsMock.mockResolvedValue({ references: [], dynamic: [], ...refs });
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

  it('lists a referencing pipeline with the version and the end it binds', async () => {
    resolve({ references: [reference()] });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    const row = await screen.findByRole('row', { name: /Nightly load/ });
    expect(within(row).getByText('v3')).toBeInTheDocument();
    expect(within(row).getByText(/sink/)).toBeInTheDocument();
    expect(within(row).getByText('latest version')).toBeInTheDocument();
    expect(within(row).getByText('agrees')).toBeInTheDocument();
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

  it('surfaces a load failure instead of rendering an empty page', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    refsMock.mockResolvedValue({ references: [], dynamic: [] });
    renderWithRouter(<DatasetDetailPage datasetId="ds_1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'));
  });
});
