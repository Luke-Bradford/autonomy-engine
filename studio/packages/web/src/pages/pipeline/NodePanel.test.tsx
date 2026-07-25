import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { isStructuralCallActivity } from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

// Named for what it tests, not for the sibling that used to share the file. U5
// replaced the flat `Palette` with `ActivityToolbox` (own file, own spec), and
// `src/palette.test.ts` — the CSS COLOUR-palette test — already owned the word
// "palette" in this package's test names.

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
