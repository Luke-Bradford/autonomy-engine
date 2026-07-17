import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { catalog, isStructuralCallActivity } from '@autonomy-studio/shared';
import { NodePanel, Palette } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

// #4 A9 — the palette auto-renders one button per catalog entry. `execute_pipeline`
// is catalogued but is a STRUCTURAL-CALL activity (config in `node.call`, not
// `node.config`), so the generic property panel cannot author it — the palette must
// hide it until the dedicated call-node authoring UI (#425). A headless render test
// verifies the omission (a button removal has no visual subtlety needing a real
// browser); `NodePanel`'s read-only stub for a loaded one is covered separately.
describe('Palette (#4 A9 structural-call exclusion)', () => {
  it('renders a button for every generically-authorable activity but hides execute_pipeline', () => {
    render(<Palette store={createCanvasStore()} />);

    // Every non-structural-call entry is offered by its catalog title.
    const authorable = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));
    for (const entry of authorable) {
      expect(screen.getByRole('button', { name: `+ ${entry.title}` })).toBeTruthy();
    }
    // The structural-call entry is NOT offered.
    expect(screen.queryByRole('button', { name: '+ Execute Pipeline' })).toBeNull();

    // Sanity: the exclusion is real (execute_pipeline exists in the catalog) and
    // it removed exactly one button, not the whole palette.
    const rendered = screen.getAllByRole('button').filter((b) => b.textContent?.startsWith('+ '));
    expect(rendered).toHaveLength(authorable.length);
    expect(authorable.length).toBe(catalog.size - 1);
  });
});

// A structural-call node can still be LOADED (authored via the API), so the
// inspector must not offer the generic `node.config` editor for it — that would
// validate `node.config` against `CallConfigSchema` (the `node.call` blob) and
// always fail. It shows a read-only stub deferring to #425 instead.
describe('NodePanel (#4 A9 structural-call stub)', () => {
  it('renders a read-only stub (no config editor) for an execute_pipeline node', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        nodeId="n_ep"
        nodeType="execute_pipeline"
        config={{}}
        connectionId={undefined}
      />,
    );
    expect(isStructuralCallActivity('execute_pipeline')).toBe(true);
    expect(screen.getByText(/call-node editor \(#425\)/)).toBeTruthy();
    // The generic config-JSON editor + Apply are NOT offered.
    expect(screen.queryByLabelText(/Config \(JSON\)/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply config' })).toBeNull();
  });

  it('still renders the generic config editor for a normal (non-call) activity', () => {
    render(
      <NodePanel
        store={createCanvasStore()}
        connections={[]}
        nodeId="n_http"
        nodeType="http_request"
        config={{}}
        connectionId={undefined}
      />,
    );
    // A normal activity keeps the JSON config editor + Apply button.
    expect(screen.getByRole('button', { name: 'Apply config' })).toBeTruthy();
    expect(screen.queryByText(/call-node editor \(#425\)/)).toBeNull();
  });
});
