import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONNECTION_KIND_DESCRIPTIONS } from '@autonomy-studio/shared';
import { ConnectionKindGallery } from './ConnectionKindGallery';
import { connectionKindGroups } from './connectionKindGroups';

const kindsOf = (query: string) =>
  connectionKindGroups(query).flatMap((g) => g.tiles.map((t) => t.kind));

describe('connectionKindGroups (#1477)', () => {
  it('lists every kind, in its group, with no search', () => {
    expect(connectionKindGroups('').map((g) => g.label)).toEqual([
      'Database',
      'File',
      'HTTP/API',
      'AI',
    ]);
    expect(kindsOf('')).toHaveLength(8);
  });

  it('matches the label, the kind id and the group label; trimmed, any case', () => {
    expect(kindsOf('  POST ')).toEqual(['postgres']);
    expect(kindsOf('agent_cli')).toEqual(['agent_cli']);
    expect(kindsOf('database')).toEqual(['sqlite', 'postgres']);
  });

  it('does not match on description prose, and drops empty groups', () => {
    // "folders" is only in the fs/sqlite descriptions.
    expect(connectionKindGroups('folders')).toEqual([]);
    expect(connectionKindGroups('sqlite').map((g) => g.key)).toEqual(['database']);
  });

  it('carries a context reason onto the kinds it disables', () => {
    const groups = connectionKindGroups('', (k) => (k === 'fs' ? 'not a sink' : undefined));
    const tiles = groups.flatMap((g) => g.tiles);
    expect(tiles.find((t) => t.kind === 'fs')).toEqual({
      kind: 'fs',
      disabledReason: 'not a sink',
    });
    expect(tiles.find((t) => t.kind === 'sqlite')).toEqual({ kind: 'sqlite' });
  });
});

describe('ConnectionKindGallery (#1477)', () => {
  it('picks an enabled kind; the tile is named by its kind and described by its one-liner', async () => {
    const onPick = vi.fn();
    render(<ConnectionKindGallery onPick={onPick} />);
    const tile = screen.getByRole('button', { name: 'SQLite' });
    expect(tile).toHaveAccessibleDescription(CONNECTION_KIND_DESCRIPTIONS.sqlite);
    await userEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith('sqlite');
  });

  it('shows a disabled kind with its reason and refuses it by click and keyboard', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectionKindGallery
        onPick={onPick}
        disabledReason={(k) => (k === 'fs' ? "Can't be a Copy sink yet" : undefined)}
      />,
    );
    const tile = screen.getByRole('button', { name: 'File system' });
    expect(tile).toHaveAttribute('aria-disabled', 'true');
    expect(tile).toHaveAccessibleDescription(
      `Can't be a Copy sink yet ${CONNECTION_KIND_DESCRIPTIONS.fs}`,
    );
    expect(screen.getByText("Can't be a Copy sink yet")).toBeVisible();
    await user.click(tile);
    tile.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('filters as you type and says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<ConnectionKindGallery onPick={() => {}} />);
    const search = screen.getByRole('textbox', { name: 'Search connection kinds' });
    await user.type(search, 'post');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['PostgreSQL']);
    const group = screen.getByRole('region', { name: 'Database' });
    expect(within(group).getByRole('button', { name: 'PostgreSQL' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No connection kinds match')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers paste-to-detect only when asked, and opens the detected kind', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ConnectionKindGallery onPick={() => {}} />);
    expect(screen.queryByRole('textbox', { name: 'Paste a path or URL' })).toBeNull();
    unmount();

    const onDetect = vi.fn();
    const onPick = vi.fn();
    render(<ConnectionKindGallery onPick={onPick} onDetect={onDetect} />);
    const paste = screen.getByRole('textbox', { name: 'Paste a path or URL' });
    await user.click(paste);
    await user.paste('postgres://etl:pw@db/sales');
    await user.keyboard('{Enter}');
    expect(onDetect).toHaveBeenCalledWith({
      kind: 'postgres',
      config: { host: 'db', database: 'sales', user: 'etl' },
      secret: 'pw',
    });
    // Cleared: the text held a password.
    expect(paste).toHaveValue('');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says when a paste is not recognised, and refuses a kind this context cannot use', async () => {
    const user = userEvent.setup();
    const onDetect = vi.fn();
    render(
      <ConnectionKindGallery
        onPick={() => {}}
        onDetect={onDetect}
        disabledReason={(k) => (k === 'fs' ? "Can't be a Copy sink yet" : undefined)}
      />,
    );
    const paste = screen.getByRole('textbox', { name: 'Paste a path or URL' });
    const use = screen.getByRole('button', { name: 'Use' });
    expect(use).toBeDisabled();
    // Enter on an empty field agrees with the disabled button: nothing happens.
    await user.type(paste, '{Enter}');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await user.type(paste, 'orders.csv');
    await user.click(use);
    expect(paste).toHaveAccessibleDescription('Not a recognised path or URL');

    await user.clear(paste);
    await user.type(paste, '/srv/landing');
    await user.click(use);
    expect(screen.getByRole('status')).toHaveTextContent("File system: Can't be a Copy sink yet");
    expect(paste).toHaveValue('/srv/landing');
    expect(onDetect).not.toHaveBeenCalled();
  });
});
