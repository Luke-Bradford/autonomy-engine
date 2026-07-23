import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Pipeline } from '@autonomy-studio/shared';
import { PipelinesPage } from './PipelinesPage';
import { ApiError } from '../api/client';
import * as pipelinesApi from '../api/pipelines';

// Mock only the network layer; the canvas is DOM-heavy (React Flow) and has its
// own coverage — stub it so this page test stays about list/create/delete/open.
vi.mock('../api/pipelines', async (importActual) => {
  const actual = await importActual<typeof import('../api/pipelines')>();
  return {
    ...actual,
    listPipelines: vi.fn(),
    createPipeline: vi.fn(),
    deletePipeline: vi.fn(),
  };
});
vi.mock('./pipeline/PipelineCanvas', () => ({
  PipelineCanvas: ({ pipelineName, onBack }: { pipelineName: string; onBack: () => void }) => (
    <div>
      <span>canvas:{pipelineName}</span>
      <button type="button" onClick={onBack}>
        ← Back to pipelines
      </button>
    </div>
  ),
}));

const listMock = vi.mocked(pipelinesApi.listPipelines);
const createMock = vi.mocked(pipelinesApi.createPipeline);
const deleteMock = vi.mocked(pipelinesApi.deletePipeline);

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'My pipeline',
    concurrency: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockResolvedValue([]);
  createMock.mockResolvedValue(pipeline());
  deleteMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PipelinesPage', () => {
  it('shows the empty state after loading', async () => {
    render(<PipelinesPage />);
    expect(await screen.findByText(/No pipelines yet/i)).toBeInTheDocument();
  });

  it('lists pipelines from the API', async () => {
    listMock.mockResolvedValue([pipeline({ name: 'Nightly digest' })]);
    render(<PipelinesPage />);
    expect(await screen.findByText('Nightly digest')).toBeInTheDocument();
  });

  it('creates a pipeline with the entered name and refreshes', async () => {
    const user = userEvent.setup();
    render(<PipelinesPage />);
    await screen.findByText(/No pipelines yet/i);
    const form = within(screen.getByRole('form', { name: /New pipeline/i }));
    await user.type(form.getByLabelText('Name'), 'Fresh');
    await user.click(form.getByRole('button', { name: /Create pipeline/i }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'Fresh' }));
    // Refresh after create: listPipelines called again (mount + post-create).
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('does not create when the name is blank', async () => {
    const user = userEvent.setup();
    render(<PipelinesPage />);
    await screen.findByText(/No pipelines yet/i);
    const form = within(screen.getByRole('form', { name: /New pipeline/i }));
    await user.click(form.getByRole('button', { name: /Create pipeline/i }));
    expect(createMock).not.toHaveBeenCalled();
  });

  it('deletes a pipeline after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    listMock.mockResolvedValue([pipeline({ name: 'Doomed' })]);
    render(<PipelinesPage />);
    await user.click(await screen.findByRole('button', { name: /Delete Doomed/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('pl_1'));
  });

  it('shows a friendly message when deleting a pipeline that has runs (409)', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    deleteMock.mockRejectedValue(new ApiError(409, 'pipeline has runs'));
    listMock.mockResolvedValue([pipeline({ name: 'Busy' })]);
    render(<PipelinesPage />);
    await user.click(await screen.findByRole('button', { name: /Delete Busy/i }));
    expect(await screen.findByText(/it has run history/i)).toBeInTheDocument();
  });

  it('does not delete when confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    listMock.mockResolvedValue([pipeline({ name: 'Safe' })]);
    render(<PipelinesPage />);
    await user.click(await screen.findByRole('button', { name: /Delete Safe/i }));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('opens a pipeline on the canvas and returns to the list', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([pipeline({ name: 'Editable' })]);
    render(<PipelinesPage />);
    await user.click(await screen.findByRole('button', { name: /Open Editable/i }));
    expect(await screen.findByText('canvas:Editable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back to pipelines/i }));
    expect(await screen.findByRole('form', { name: /New pipeline/i })).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    render(<PipelinesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/i);
  });
});
