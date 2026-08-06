import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportResult } from '@autonomy-studio/shared';
import { ImportPanel } from './ImportPanel';
import { ApiError } from '../api/client';
import { renderWithRouter } from '../testing/renderWithRouter';
import * as portability from '../api/portability';

vi.mock('../api/portability', async (importActual) => {
  const actual = await importActual<typeof import('../api/portability')>();
  // Only the network call is mocked. `parseEnvelopeText`, `describeAttention`
  // and `describeImported` are the REAL ones — they are the substance of what
  // this panel says, and mocking them would leave the assertions testing the
  // mock rather than the sentence the operator reads.
  return { ...actual, importEnvelope: vi.fn() };
});

const importMock = vi.mocked(portability.importEnvelope);

beforeEach(() => {
  importMock.mockReset();
});

function envelopeFile(contents: string, name = 'pipeline-x.json'): File {
  return new File([contents], name, { type: 'application/json' });
}

function pipelineResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    kind: 'pipeline',
    pipeline: {
      id: 'pl_new',
      resourceId: 'res_1',
      ownerId: 'own_1',
      name: 'Imported flow',
      concurrency: 1,
      archived: false,
      createdAt: 1_754_438_400_000,
      updatedAt: 1_754_438_400_000,
    },
    versions: [],
    attention: [],
    ...overrides,
  } as ImportResult;
}

async function pick(file: File) {
  await userEvent.upload(screen.getByLabelText('Export file'), file);
}

describe('ImportPanel', () => {
  it('imports a picked file, refreshes the list, and names the NEW id', async () => {
    importMock.mockResolvedValue(pipelineResult());
    const onImported = vi.fn().mockResolvedValue(undefined);
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={onImported} />);

    await pick(envelopeFile('{"kind":"pipeline"}'));

    await waitFor(() => expect(importMock).toHaveBeenCalledWith({ kind: 'pipeline' }));
    expect(onImported).toHaveBeenCalledTimes(1);
    // The id, not just the name: two imports of one file leave two rows with
    // the same name, so the name alone would not identify what just appeared.
    expect(await screen.findByText(/pl_new/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Imported flow' })).toHaveAttribute(
      'href',
      expect.stringContaining('pl_new'),
    );
  });

  it('refuses a file that is not JSON without sending anything', async () => {
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    await pick(envelopeFile('this is not json', 'notes.txt'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/notes\.txt.*not a JSON file/);
    // The refusal is LOCAL — nothing was posted, so nothing can have been
    // created by a file the operator picked by mistake.
    expect(importMock).not.toHaveBeenCalled();
  });

  it('lists every attention item, so a pipeline is not reported as ready when it is not', async () => {
    importMock.mockResolvedValue(
      pipelineResult({
        attention: [
          { type: 'unresolvedConnectionRef', nodeId: 'summarise' },
          { type: 'unresolvedConnectionRef', nodeId: 'classify' },
        ],
      }),
    );
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    await pick(envelopeFile('{"kind":"pipeline"}'));

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/summarise/);
    expect(items[1]).toHaveTextContent(/classify/);
  });

  it('says where a resource of ANOTHER kind went, rather than leaving it invisible', async () => {
    // `/api/import` takes any envelope kind, so a connection export dropped on
    // the pipelines page really does create a connection — which would appear
    // nowhere on this page unless the panel says so.
    importMock.mockResolvedValue({
      kind: 'connection',
      connection: {
        id: 'conn_new',
        name: 'OpenAI',
        provider: 'openai',
        model: 'gpt-4',
        hasSecret: false,
        createdAt: 1_754_438_400_000,
        updatedAt: 1_754_438_400_000,
      },
      attention: [{ type: 'requiresSecret' }],
    } as unknown as ImportResult);
    const onImported = vi.fn();
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={onImported} />);

    await pick(envelopeFile('{"kind":"connection"}', 'connection-openai.json'));

    expect(await screen.findByText(/conn_new/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage → Connections' })).toBeInTheDocument();
    // Nothing landed in THIS list, so refreshing it would be a pointless
    // request that implies something changed here.
    expect(onImported).not.toHaveBeenCalled();
  });

  it('warns that an imported trigger arrives disabled — a fact no attention item carries', async () => {
    importMock.mockResolvedValue({
      kind: 'trigger',
      trigger: {
        id: 'trg_new',
        name: 'Nightly',
        mode: 'schedule',
        enabled: false,
        pipelineVersionId: null,
        createdAt: 1_754_438_400_000,
        updatedAt: 1_754_438_400_000,
      },
      attention: [{ type: 'unboundPipelineVersion' }],
    } as unknown as ImportResult);
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    await pick(envelopeFile('{"kind":"trigger"}', 'trigger-nightly.json'));

    expect(await screen.findByText(/arrive disabled/i)).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent(/never fire/i);
  });

  it('shows the server refusal, and creates nothing', async () => {
    importMock.mockRejectedValue(
      new ApiError(400, 'Cannot import: catalogVersion 99 is newer than this build supports (3)'),
    );
    const onImported = vi.fn();
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={onImported} />);

    await pick(envelopeFile('{"kind":"pipeline","catalogVersion":99}'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/newer than this build supports/);
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lets the same file be picked twice — each import mints an independent resource', async () => {
    importMock
      .mockResolvedValueOnce(pipelineResult())
      .mockResolvedValueOnce(
        pipelineResult({ pipeline: { ...pipelineResult().pipeline, id: 'pl_second' } } as never),
      );
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    const file = envelopeFile('{"kind":"pipeline"}');
    await pick(file);
    expect(await screen.findByText(/pl_new/)).toBeInTheDocument();
    await pick(file);

    // Without the input's value being cleared, the second pick fires no
    // `change` event at all and the panel silently does nothing.
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/pl_second/)).toBeInTheDocument();
  });

  it('makes no request on mount', () => {
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    expect(importMock).not.toHaveBeenCalled();
  });
});
