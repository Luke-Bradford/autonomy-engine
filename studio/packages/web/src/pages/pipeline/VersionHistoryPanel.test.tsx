import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VersionHistoryPanel, VersionPreviewBar } from './VersionHistoryPanel';
import type { VersionEntry } from './versionHistory';

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
    ...overrides,
  };
}

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
        locked={false}
        onPreview={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => r.textContent?.startsWith('v'))).toEqual([true, true, true]);
    expect(rows[0]!.textContent).toContain('v3');
    expect(rows[0]!.textContent).toContain('latest');
    expect(rows[1]!.textContent).toContain('on the canvas');
    expect(rows[2]!.textContent).not.toContain('latest');
  });

  it('states the shape of each version, so an operator can tell them apart', () => {
    render(
      <VersionHistoryPanel
        entries={[entry({ nodeCount: 4, edgeCount: 3, containerCount: 1, paramCount: 2 })]}
        previewing={null}
        locked={false}
        onPreview={vi.fn()}
      />,
    );
    const row = screen.getByRole('button');
    expect(row.textContent).toContain('4 nodes');
    expect(row.textContent).toContain('3 edges');
    expect(row.textContent).toContain('1 container');
    expect(row.textContent).toContain('2 params');
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
        locked={false}
        onPreview={vi.fn()}
      />,
    );
    expect(screen.getByRole('button').textContent).toContain(new Date(createdAt).toLocaleString());
  });

  it('reports which row is being previewed as pressed', () => {
    render(
      <VersionHistoryPanel
        entries={[entry({ id: 'plv_2', version: 2 }), entry({ id: 'plv_1', version: 1 })]}
        previewing={1}
        locked={false}
        onPreview={vi.fn()}
      />,
    );
    const rows = screen.getAllByRole('button');
    expect(rows[0]!).toHaveAttribute('aria-pressed', 'false');
    expect(rows[1]!).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks for the version a row names when it is clicked', async () => {
    const onPreview = vi.fn();
    render(
      <VersionHistoryPanel
        entries={[entry({ version: 7 })]}
        previewing={null}
        locked={false}
        onPreview={onPreview}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
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
        locked
        onPreview={onPreview}
      />,
    );
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toBeDisabled();
    await userEvent.click(rows[0]!);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('says a pipeline has no versions rather than rendering an empty list', () => {
    render(
      <VersionHistoryPanel entries={[]} previewing={null} locked={false} onPreview={vi.fn()} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('version-history').textContent).toMatch(/no versions yet/i);
  });
});

describe('VersionPreviewBar', () => {
  it('says which version is on screen and that it cannot be edited', () => {
    render(
      <VersionPreviewBar
        version={2}
        refusal={null}
        restoring={false}
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
        onRestore={vi.fn()}
        onBackToEditing={onBackToEditing}
      />,
    );
    const back = screen.getByRole('button', { name: /back to editing/i });
    expect(back).toBeDisabled();
    await userEvent.click(back);
    expect(onBackToEditing).not.toHaveBeenCalled();
  });
});
