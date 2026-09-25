import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Container, Edge, Node } from '@autonomy-studio/shared';
import { createCanvasStore } from './canvasStore';
import { enclosingContainers, PolicyEditor } from './PolicyEditor';

const node = (id: string, type: string, extra: Partial<Node> = {}): Node => ({
  id,
  type,
  config: {},
  position: { x: 0, y: 0 },
  ...extra,
});

/**
 * Mount the editor over a real store and hand back a reader for the node's
 * STORED policy — every assertion is about what the editor wrote to the doc.
 */
function mount(nodes: Node[], opts: { edges?: Edge[]; containers?: Container[] } = {}) {
  const store = createCanvasStore();
  store.setState({ nodes, edges: opts.edges ?? [], containers: opts.containers ?? [] });
  render(<PolicyEditor store={store} nodeId={nodes[0]!.id} />);
  const section = screen.getByRole('group', { name: 'Run policy' });
  return {
    store,
    section,
    policy: () => store.getState().nodes[0]?.policy,
    field: (name: string) => within(section).getByLabelText(name),
  };
}

/** Type then blur — the number fields commit on blur, as the bounce cap does. */
function enter(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input, { target: { value } });
}

describe('PolicyEditor (#1312)', () => {
  it('shows the stored policy', () => {
    const { field } = mount([
      node('a', 'http_request', { policy: { retry: 3, retryIntervalSeconds: 90, secureOutput: true } }),
    ]);
    expect(field('Retries')).toHaveProperty('value', '3');
    expect(field('Retry interval (seconds)')).toHaveProperty('value', '90');
    expect(field('Secure output')).toHaveProperty('checked', true);
    expect(field('Secure input')).toHaveProperty('checked', false);
  });

  it('commits retries and interval on blur as numbers, and blank removes the key', () => {
    const { field, policy } = mount([node('a', 'http_request')]);
    enter(field('Retries'), '2');
    enter(field('Retry interval (seconds)'), ' 120 ');
    expect(policy()).toEqual({ retry: 2, retryIntervalSeconds: 120 });
    enter(field('Retry interval (seconds)'), '');
    expect(policy()).toEqual({ retry: 2 });
    enter(field('Retries'), '');
    expect(policy()).toBeUndefined();
  });

  it('an explicit 0 is written — it pins "never retry", which blank does not', () => {
    const { field, policy } = mount([node('a', 'http_request')]);
    enter(field('Retries'), '0');
    expect(policy()).toEqual({ retry: 0 });
  });

  it('a non-whole entry is reported and NOT written, and correcting it clears the error', () => {
    const { field, policy, section } = mount([node('a', 'http_request', { policy: { retry: 1 } })]);
    enter(field('Retries'), '1.5');
    expect(within(section).getByRole('alert').textContent).toMatch(/not a whole number/);
    expect(policy()).toEqual({ retry: 1 });
    // Retyping the stored value writes nothing but must still clear the error.
    enter(field('Retries'), '1');
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('range is left to the write schema: a negative commits, and is badged', () => {
    const { field, policy, section } = mount([node('a', 'http_request')]);
    enter(field('Retries'), '-1');
    expect(policy()).toEqual({ retry: -1 });
    expect(within(section).getByText(/policy\.retry:/)).toBeTruthy();
  });

  it('an interval with no retry is explained in the section, before any save', () => {
    const { field, section } = mount([node('a', 'http_request')]);
    enter(field('Retry interval (seconds)'), '60');
    expect(within(section).getByText(/has no effect without retry/)).toBeTruthy();
  });

  it('the secure checkboxes write the flag and clear it', () => {
    const { field, policy } = mount([node('a', 'http_request')]);
    fireEvent.click(field('Secure output'));
    fireEvent.click(field('Secure input'));
    expect(policy()).toEqual({ secureOutput: true, secureInput: true });
    fireEvent.click(field('Secure output'));
    fireEvent.click(field('Secure input'));
    expect(policy()).toBeUndefined();
  });

  it('editing one setting keeps the others, including a stored timeout', () => {
    const { field, policy } = mount([
      node('a', 'http_request', { policy: { timeoutSeconds: 60, secureOutput: true } }),
    ]);
    enter(field('Retries'), '1');
    expect(policy()).toEqual({ timeoutSeconds: 60, secureOutput: true, retry: 1 });
  });

  it('a stored timeout is said to be unenforced, and can be removed', () => {
    const { policy, section } = mount([
      node('a', 'http_request', { policy: { timeoutSeconds: 40_000_000, retry: 1 } }),
    ]);
    expect(within(section).getByText(/not enforced/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Remove the timeout' }));
    expect(policy()).toEqual({ retry: 1 });
    expect(within(section).queryByText(/not enforced/)).toBeNull();
  });

  it('explains why a secure flag is refused on an if node, by name', () => {
    const { section } = mount([
      node('a', 'if', { config: { condition: '${true}' }, policy: { secureOutput: true } }),
    ]);
    expect(within(section).getByText(/secureOutput is not supported on 'if'/)).toBeTruthy();
  });

  it('explains a downstream ref refused because this node is secure', () => {
    const { section } = mount(
      [
        node('p', 'http_request', { policy: { secureOutput: true } }),
        node('c', 'http_request', { config: { url: '${nodes.p.output.body}' } }),
      ],
      { edges: [{ id: 'e', from: 'p', to: 'c', on: 'success' }] },
    );
    expect(within(section).getByText(/has secure outputs/)).toBeTruthy();
  });

  it('an undo re-seeds the number field rather than showing the undone value', () => {
    const { field, store } = mount([node('a', 'http_request')]);
    enter(field('Retries'), '4');
    act(() => store.getState().undo());
    expect(field('Retries')).toHaveProperty('value', '');
  });

  it('a clean policy lists no issues', () => {
    const { section } = mount([node('a', 'http_request', { policy: { retry: 2 } })]);
    expect(within(section).queryByRole('list')).toBeNull();
  });
});

describe('enclosingContainers (#1312)', () => {
  const box = (id: string, children: string[]) => ({ id, children }) as unknown as Container;

  it('walks outward through nested containers, innermost first', () => {
    const containers = [box('outer', ['inner', 'x']), box('inner', ['k'])];
    expect(enclosingContainers('k', containers)).toEqual(['inner', 'outer']);
    expect(enclosingContainers('x', containers)).toEqual(['outer']);
    expect(enclosingContainers('free', containers)).toEqual([]);
  });

  it('terminates on a malformed cycle rather than looping', () => {
    expect(enclosingContainers('k', [box('a', ['k', 'b']), box('b', ['a'])])).toEqual(['a', 'b']);
  });
});
