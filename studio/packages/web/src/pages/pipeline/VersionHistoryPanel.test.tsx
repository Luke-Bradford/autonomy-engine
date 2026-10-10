import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Pipeline } from '@autonomy-studio/shared';
import userEvent from '@testing-library/user-event';
import { VersionHistoryPanel, VersionPreviewBar } from './VersionHistoryPanel';
import type { VersionEntry } from './versionHistory';
import { formatTimestamp } from '../../lib/displayTime';
import { chooseRowAction } from '../../testing/rowActions';

function entry(overrides: Partial<VersionEntry> = {}): VersionEntry {
  return {
    id: 'plv_1',
    version: 1,
    createdAt: 1_700_000_000_000,
    nodeCount: 2,
    edgeCount: 1,
    containerCount: 0,
    paramCount: 0,
    outputCount: 0,
    isHead: false,
    isCurrent: false,
    isActive: false,
    ...overrides,
  };
}

/** The version rows — the list's toggles, not the column's Close or a row's ⋯. */
const rowButtons = () =>
  within(screen.getByRole('list'))
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-pressed'));

describe('VersionHistoryPanel', () => {
  it('renders the entries in the order it is given, marking the latest and the canvas one', () => {
    render(
      <VersionHistoryPanel
        entries={[
          entry({ id: 'plv_3', version: 3, isHead: true }),
          entry({ id: 'plv_2', version: 2, isCurrent: true }),
          entry({ id: 'plv_1', version: 1 }),
        ]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const rows = rowButtons();
    expect(rows.map((r) => r.textContent?.startsWith('v'))).toEqual([true, true, true]);
    expect(rows[0]!.textContent).toContain('v3');
    expect(rows[0]!.textContent).toContain('Latest');
    expect(rows[1]!.textContent).toContain('On the canvas');
    expect(rows[2]!.textContent).not.toContain('Latest');
  });

  it('states the shape of each version, so an operator can tell them apart', () => {
    render(
      <VersionHistoryPanel
        entries={[entry({ nodeCount: 4, edgeCount: 3, containerCount: 1, paramCount: 2 })]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const row = rowButtons()[0]!;
    expect(row.textContent).toContain('4 nodes');
    expect(row.textContent).toContain('3 edges');
    expect(row.textContent).toContain('1 container');
    expect(row.textContent).toContain('2 parameters');
  });

  /* The timestamp is how an operator tells two same-shaped versions apart, and
     it is rendered through the runs page's `formatWhen` rather than a second
     formatter. Asserted against that function's own output, so the test cannot
     bake in a locale the CI box does not share. */
  it('dates each version', () => {
    const createdAt = 1_700_000_000_000;
    render(
      <VersionHistoryPanel
        entries={[entry({ createdAt })]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(rowButtons()[0]!.textContent).toContain(formatTimestamp(createdAt, 'local'));
  });

  it('reports which row is being previewed as pressed', () => {
    render(
      <VersionHistoryPanel
        entries={[entry({ id: 'plv_2', version: 2 }), entry({ id: 'plv_1', version: 1 })]}
        previewing={1}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const rows = rowButtons();
    expect(rows[0]!).toHaveAttribute('aria-pressed', 'false');
    expect(rows[1]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks for the version a row names when it is clicked', async () => {
    const onPreview = vi.fn();
    render(
      <VersionHistoryPanel
        entries={[entry({ version: 7 })]}
        previewing={null}
        locked={null}
        onPreview={onPreview}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(rowButtons()[0]!);
    expect(onPreview).toHaveBeenCalledWith(7);
  });

  /* A row toggles the preview, so while a restore is in flight it is an exit
     from the preview like any other: leaving remounts the editor under a
     response that is about to rebase the canvas, and switching versions yanks
     the operator somewhere they did not ask to be. */
  it('makes every row inert while a restore is in flight', async () => {
    const onPreview = vi.fn();
    render(
      <VersionHistoryPanel
        entries={[entry({ id: 'plv_2', version: 2 }), entry({ id: 'plv_1', version: 1 })]}
        previewing={1}
        locked="Saving — wait for it to finish."
        onPreview={onPreview}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const rows = rowButtons();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toBeDisabled();
    await userEvent.click(rows[0]!);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('says a pipeline has no versions rather than rendering an empty list', () => {
    render(
      <VersionHistoryPanel
        entries={[]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByTestId('version-history').textContent).toMatch(/no versions yet/i);
  });
});

describe('VersionHistoryPanel — the column (#1475 OR27)', () => {
  it('is a named region whose Close button closes it, and is dead while a restore runs', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <VersionHistoryPanel
        entries={[entry()]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('region', { name: 'Version history' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close version history' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <VersionHistoryPanel
        entries={[entry()]}
        previewing={1}
        locked="Saving — wait for it to finish."
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={onClose}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close version history' });
    expect(close).toBeDisabled();
    // The tooltip names the request that is running, not always "Restoring".
    expect(close).toHaveAttribute('title', 'Saving — wait for it to finish.');
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps its Close button when there are no versions yet', () => {
    render(
      <VersionHistoryPanel
        entries={[]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Close version history' })).toBeEnabled();
  });
});

describe('VersionHistoryPanel — the active tag (#979)', () => {
  it('marks the active version, and only it, alongside the other two marks', () => {
    render(
      <VersionHistoryPanel
        entries={[
          entry({ id: 'plv_3', version: 3, isHead: true, isCurrent: true }),
          entry({ id: 'plv_1', version: 1, isActive: true }),
        ]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const rows = rowButtons();
    expect(rows[0]!.textContent).not.toContain('Active');
    // The whole point of the tag: what is deployed is NOT what is on screen.
    expect(rows[1]!.textContent).toContain('Active');
  });

  it('marks nothing when no version is active', () => {
    render(
      <VersionHistoryPanel
        entries={[entry({ id: 'plv_1', version: 1, isHead: true })]}
        previewing={null}
        locked={null}
        onPreview={vi.fn()}
        pipelineName="Demo"
        onClone={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('version-history').textContent).not.toContain('Active');
  });
});

describe('VersionPreviewBar', () => {
  it('says which version is on screen and that it cannot be edited', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    expect(screen.getByTestId('version-preview-bar').textContent).toContain('Viewing v2');
    expect(screen.getByTestId('version-preview-bar').textContent).toMatch(/read-only/i);
  });

  /* The refusal is a fail-safe, so it must reach the control itself and not
     only the prose beside it — a live button with an explanation elsewhere is
     the shape that loses unsaved work. */
  it('disables Restore and states the reason when the restore is refused', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal="Save or discard your unsaved changes first."
        restoring={false}
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    const restore = screen.getByRole('button', { name: /restore v2/i });
    expect(restore).toBeDisabled();
    expect(restore).toHaveAttribute('title', 'Save or discard your unsaved changes first.');
    expect(screen.getByTestId('version-preview-bar').textContent).toContain('unsaved changes');
  });

  it('offers Restore when nothing refuses it', async () => {
    const onRestore = vi.fn();
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={onRestore}
        onBackToEditing={vi.fn()}
      />,
    );
    const restore = screen.getByRole('button', { name: /restore v2/i });
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('cannot be clicked twice while a restore is in flight', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /restoring/i })).toBeDisabled();
  });

  it('leaves the preview when Back to editing is clicked', async () => {
    const onBackToEditing = vi.fn();
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={onBackToEditing}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /back to editing/i }));
    expect(onBackToEditing).toHaveBeenCalledOnce();
  });

  /* The data-loss case. The restore rebases the canvas onto the version it is
     minting, which is only safe into an editor that is NOT mounted — and this
     button is what mounts one. An operator who leaves here mid-flight and types
     would have that work overwritten by the arriving response, silently. */
  it('refuses to leave the preview while the restore is still in flight', async () => {
    const onBackToEditing = vi.fn();
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring
        publishRefusal="not this test's concern"
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={onBackToEditing}
      />,
    );
    const back = screen.getByRole('button', { name: /back to editing/i });
    expect(back).toBeDisabled();
    await userEvent.click(back);
    expect(onBackToEditing).not.toHaveBeenCalled();
  });

  /* #979 — Publish. The two acts are refused independently, so each test states
     only its own refusal and leaves the other's alone. */
  it('offers Publish when nothing refuses it', async () => {
    const onPublish = vi.fn();
    render(
      <VersionPreviewBar
        version={2}
        refusal="restoring is refused here, and must not disable Publish"
        restoring={false}
        publishRefusal={null}
        publishing={false}
        onPublish={onPublish}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    const publish = screen.getByRole('button', { name: /publish v2/i });
    expect(publish).toBeEnabled();
    await userEvent.click(publish);
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('disables Publish and carries the reason on the control itself', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal="v2 was authored here, not imported from a commit."
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    const publish = screen.getByRole('button', { name: /publish v2/i });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', 'v2 was authored here, not imported from a commit.');
    // Reachable by AT, not by hover alone: a disabled control has no tooltip a
    // keyboard can summon, so the reason is also described.
    const describedBy = publish.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'v2 was authored here, not imported from a commit.',
    );
    // Present to AT, absent from the layout — the visual argument above stands.
    expect(document.getElementById(describedBy!)).toHaveClass('visually-hidden');
  });

  it('describes nothing when Publish is available', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal={null}
        publishing={false}
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /publish v2/i })).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('cannot be clicked twice while a publish is in flight, and locks the bar', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
        publishRefusal={null}
        publishing
        onPublish={vi.fn()}
        onRestore={vi.fn()}
        onBackToEditing={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /publishing/i })).toBeDisabled();
    // The other two acts are held too: a restore mid-publish would rebase the
    // canvas under a CAS whose result has not landed.
    expect(screen.getByRole('button', { name: /restore v2/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /back to editing/i })).toBeDisabled();
  });
});

describe('VersionHistoryPanel — Clone vN as new pipeline (#1569 OR37)', () => {
  const clone: Pipeline = {
    id: 'pl_9',
    resourceId: 'res_9',
    ownerId: 'local',
    name: 'Demo v1 (copy)',
    concurrency: null,
    folder: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };

  function renderPanel(
    onClone: (version: number, name: string) => Promise<Pipeline>,
    locked: string | null = null,
  ) {
    render(
      <MemoryRouter>
        <VersionHistoryPanel
          entries={[
            entry({ id: 'plv_2', version: 2, isHead: true }),
            entry({ id: 'plv_1', version: 1 }),
          ]}
          previewing={null}
          locked={locked}
          onPreview={vi.fn()}
          pipelineName="Demo"
          onClone={onClone}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('names the clone from the pipeline and version, clones THAT version, and links to it', async () => {
    const user = userEvent.setup();
    const onClone = vi.fn().mockResolvedValue(clone);
    renderPanel(onClone);

    await chooseRowAction(user, 'v1', 'Clone v1 as new pipeline…');
    const name = screen.getByRole('textbox', { name: 'New pipeline name' });
    expect(name).toHaveValue('Demo v1 (copy)');
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    expect(onClone).toHaveBeenCalledWith(1, 'Demo v1 (copy)');
    const status = await screen.findByRole('status');
    expect(within(status).getByRole('link', { name: 'Demo v1 (copy)' })).toHaveAttribute(
      'href',
      '/author/pipelines/pl_9',
    );
    expect(screen.queryByRole('textbox', { name: 'New pipeline name' })).not.toBeInTheDocument();
    // Focus goes back to the ⋯ the clone was started from, not to <body>.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actions for v1' })).toHaveFocus(),
    );
  });

  it('keeps the name as typed and says why when the clone is refused', async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn().mockRejectedValue(new Error('nodes: unknown activity type')));

    await chooseRowAction(user, 'v2', 'Clone v2 as new pipeline…');
    const name = screen.getByRole('textbox', { name: 'New pipeline name' });
    await user.clear(name);
    await user.type(name, 'Mine');
    await user.click(screen.getByRole('button', { name: 'Clone' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not clone v2: nodes: unknown activity type',
    );
    const input = screen.getByRole('textbox', { name: 'New pipeline name' });
    expect(input).toHaveValue('Mine');
    // Focus stays in the row, so the name can be corrected from the keyboard.
    expect(input).toHaveFocus();
    // Cancel takes the refusal with it.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses an empty name, and Escape cancels', async () => {
    const user = userEvent.setup();
    const onClone = vi.fn();
    renderPanel(onClone);

    await chooseRowAction(user, 'v1', 'Clone v1 as new pipeline…');
    await user.clear(screen.getByRole('textbox', { name: 'New pipeline name' }));
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New pipeline name' })).not.toBeInTheDocument();
    expect(onClone).not.toHaveBeenCalled();
  });

  it('stays available while a save or restore holds the rows', async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn().mockResolvedValue(clone), 'Saving…');
    const item = await chooseRowAction(user, 'v1', 'Clone v1 as new pipeline…');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('textbox', { name: 'New pipeline name' })).toBeInTheDocument();
  });
});
