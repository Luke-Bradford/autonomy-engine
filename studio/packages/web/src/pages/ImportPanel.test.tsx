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

/**
 * The PIPELINE variant, narrowed. `ImportResult` is a discriminated union, so a
 * helper typed as the union cannot have its `.pipeline` read back by a caller
 * building a second fixture from the first.
 */
type PipelineImportResult = Extract<ImportResult, { kind: 'pipeline' }>;

function pipelineResult(overrides: Partial<PipelineImportResult> = {}): PipelineImportResult {
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
  };
}

async function pick(file: File) {
  await userEvent.upload(screen.getByLabelText('Export file'), file);
}

describe('ImportPanel', () => {
  // #1114 (M2) — the crash this test exists for is NOT type-visible. `dataset`
  // joined `ExportEnvelopeSchema`, so `foreignEnvelopeKind` started returning
  // it, while `SECTION` was still keyed by the narrower import type — making
  // `SECTION[foreign.kind].label` a read on `undefined`. The panel rendered a
  // blank error boundary instead of a refusal.
  it('refuses a dataset export without crashing, and offers no destination', async () => {
    renderWithRouter(<ImportPanel listKind="connection" onImported={vi.fn()} />);

    await pick(envelopeFile('{"kind":"dataset"}', 'customers.json'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /is a dataset export.*this panel cannot import it.*nothing was created/i,
    );
    // Nothing was SENT — the refusal is local, before any request.
    expect(importMock).not.toHaveBeenCalled();
    // ...and no link is offered, because every page on offer would refuse it too.
    expect(screen.queryByRole('link', { name: /dataset/i })).not.toBeInTheDocument();
  });

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

  it('refuses a file belonging to another section BEFORE sending it anywhere', async () => {
    // `/api/import` takes any envelope kind, so a connection export dropped on
    // the pipelines page would really create a connection — a row on a page
    // that cannot show it, which the operator then has to hunt down and delete.
    // There is no dry-run, so the refusal has to happen here, before the POST.
    const onImported = vi.fn();
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={onImported} />);

    await pick(envelopeFile('{"kind":"connection"}', 'connection-openai.json'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/is a connection export/);
    expect(screen.getByRole('link', { name: 'Manage → Connections' })).toBeInTheDocument();
    // The whole point: nothing was sent, so nothing was created.
    expect(importMock).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sends an UNRECOGNISED kind anyway — the server owns what is importable', async () => {
    // The local check answers "does this belong on my page", not "is this
    // importable". A kind this build has never heard of is the server's call:
    // refusing it here would be a client that fails closed against its own
    // server the day a fourth kind ships.
    importMock.mockResolvedValue(pipelineResult());
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={vi.fn()} />);

    await pick(envelopeFile('{"kind":"workspace"}', 'future.json'));

    await waitFor(() => expect(importMock).toHaveBeenCalledWith({ kind: 'workspace' }));
  });

  it('still reports the created resource when the list refresh fails', async () => {
    // Past the POST the resource EXISTS. Reporting a failed reload as a failed
    // import would be a false negative, and `/api/import` does not dedupe — so
    // the operator's natural retry would mint a duplicate.
    importMock.mockResolvedValue(pipelineResult());
    const onImported = vi.fn().mockRejectedValue(new Error('list unavailable'));
    renderWithRouter(<ImportPanel listKind="pipeline" onImported={onImported} />);

    await pick(envelopeFile('{"kind":"pipeline"}'));

    expect(await screen.findByRole('status')).toHaveTextContent(/pl_new/);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be reloaded/);
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
    // On the TRIGGERS list — a trigger file dropped on Pipelines is now refused
    // before it is sent, and this case is about what the outcome SAYS.
    renderWithRouter(<ImportPanel listKind="trigger" onImported={vi.fn()} />);

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
        pipelineResult({ pipeline: { ...pipelineResult().pipeline, id: 'pl_second' } }),
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
