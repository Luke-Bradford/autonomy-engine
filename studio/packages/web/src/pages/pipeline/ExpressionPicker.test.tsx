import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from 'zustand';
import type { Edge, Node, Param } from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';

/**
 * U8a — the expression-insert flyout, mounted in its real home.
 *
 * Asserted through `NodePanel` rather than over `ExpressionPicker` alone,
 * because the thing worth pinning is the whole path: a click has to reach the
 * textarea, survive the panel's controlled state, and land in the DOC. A test
 * that mounted the picker with a stub `onSelect` would pass with the caret
 * plumbing removed entirely.
 */

const at = { x: 0, y: 0 };

function mount(nodes: Node[], edges: Edge[], params: Param[], selected: string) {
  const store = createCanvasStore();
  store.setState({ nodes, edges, params });

  function Harness() {
    const node = useStore(store, (s) => s.nodes.find((n) => n.id === selected));
    if (!node) return null;
    return (
      <NodePanel
        store={store}
        connections={[]}
        nodeId={node.id}
        nodeType={node.type}
        config={node.config}
        connectionId={node.connectionId}
      />
    );
  }

  render(<Harness />);
  return {
    storedConfig: () => store.getState().nodes.find((n) => n.id === selected)?.config ?? {},
    apply: () => fireEvent.click(screen.getByRole('button', { name: 'Apply config' })),
    open: (field: string) =>
      fireEvent.click(screen.getByRole('button', { name: `Insert reference into ${field}` })),
    // The label text alone is ambiguous — the picker's toggle carries the same
    // field name in its accessible name — so the textarea is reached by role.
    field: (label: string) => screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement,
  };
}

/** `fetch` declares an output; `call` reads it. A success chain, so `fetch` dominates. */
const FETCH: Node = {
  id: 'fetch',
  type: 'http_request',
  config: { method: 'GET', url: 'https://a.test', outputs: [{ name: 'body', type: 'string' }] },
  position: at,
};
const CALL: Node = {
  id: 'call',
  type: 'http_request',
  config: { method: 'GET', url: '' },
  position: at,
};
const CHAIN: Edge[] = [{ id: 'e1', from: 'fetch', to: 'call', on: 'success' }];
const PARAMS: Param[] = [{ name: 'topic', type: 'string', required: true }];

describe('ExpressionPicker in NodePanel', () => {
  it('lists an upstream output the author had no other way to discover', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    ui.open('url');
    // Named by the activity's CATALOG title — the same text its box carries —
    // not by the raw node id the reference is built from.
    expect(screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Upstream outputs' })).toBeTruthy();
  });

  it('names a producer by title ALONE when that title is unambiguous', () => {
    // An activity title names a TYPE. It identifies an instance only while it is
    // the doc's only node of that type — so the id is appended when it is not,
    // and withheld when it is, rather than always or never.
    const gate: Node = { id: 'gate', type: 'if', config: { condition: '${item}' }, position: at };
    mount([FETCH, gate], [{ id: 'e1', from: 'fetch', to: 'gate', on: 'success' }], [], 'gate');
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference into condition' }));
    expect(screen.getByRole('button', { name: /^HTTP Request → body/ })).toBeTruthy();
  });

  it('disambiguates two producers of the SAME activity type by id', () => {
    const second: Node = {
      ...FETCH,
      id: 'other',
      config: { ...FETCH.config, outputs: [{ name: 'body', type: 'string' }] },
    };
    mount(
      [FETCH, second, CALL],
      [
        { id: 'e1', from: 'fetch', to: 'other', on: 'success' },
        { id: 'e2', from: 'other', to: 'call', on: 'success' },
      ],
      [],
      'call',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference into url' }));
    // Both are offered, and each says WHICH box it is — the list's whole job.
    expect(screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /HTTP Request \(other\) → body/ })).toBeTruthy();
  });

  it('writes the chosen reference into the DOC, not merely onto the screen', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    ui.open('url');
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ }));
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('${nodes.fetch.output.body}');
  });

  it('splices at the caret, leaving the text the author already typed', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    const url = ui.field('url');
    fireEvent.change(url, { target: { value: 'https://x.test/?q=&page=2' } });
    url.selectionStart = 'https://x.test/?q='.length;
    url.selectionEnd = url.selectionStart;
    // A real caret move fires `select`, which is how the control learns the
    // author has actually placed one — see the never-focused test below.
    fireEvent.select(url);

    ui.open('url');
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ }));
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('https://x.test/?q=${nodes.fetch.output.body}&page=2');
  });

  it('REPLACES a whole-value field instead, and says so before the author picks', () => {
    // An `if` condition must be one whole `${...}` and nothing else, so splicing
    // into it would produce a doc the save gate refuses.
    const gate: Node = { id: 'gate', type: 'if', config: { condition: 'stale' }, position: at };
    const ui = mount(
      [FETCH, gate],
      [{ id: 'e1', from: 'fetch', to: 'gate', on: 'success' }],
      [],
      'gate',
    );

    ui.open('condition');
    expect(screen.getByText(/REPLACES its current value/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request → body/ }));
    ui.apply();
    expect(ui.storedConfig()['condition']).toBe('${nodes.fetch.output.body}');
  });

  it('offers a declared param and never a secret-typed one', () => {
    const params: Param[] = [
      { name: 'topic', type: 'string', required: true },
      { name: 'apiKey', type: 'secret', required: true },
    ];
    const ui = mount([FETCH, CALL], CHAIN, params, 'call');
    ui.open('url');
    expect(screen.getByRole('button', { name: /^topic/ })).toBeTruthy();
    // A secret's only sink is the executor env channel — it never enters the
    // `${}` language, so offering it would be a reference the doc refuses.
    expect(screen.queryByRole('button', { name: /^apiKey/ })).toBeNull();
  });

  it('closes on Escape without touching the field', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    ui.open('url');
    const item = screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /HTTP Request \(fetch\) → body/ })).toBeNull();
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('');
  });

  it('APPENDS when the author never placed a caret, rather than prepending', () => {
    // The commonest flow of all: select a node, click Insert reference without
    // clicking into the field first. A textarea nobody has focused reports
    // `selectionStart === 0`, so the naive read puts the reference in FRONT of
    // the value already there.
    const seeded: Node = { ...CALL, config: { method: 'GET', url: 'https://api.test/v1/' } };
    const ui = mount([FETCH, seeded], CHAIN, [], 'call');
    ui.open('url');
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request \(fetch\) → body/ }));
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('https://api.test/v1/${nodes.fetch.output.body}');
  });

  it('offers only what a TYPE-CHECKED field would accept, in the destructive mode', () => {
    // A `filter`'s `items` must resolve to an ARRAY, and it is whole-value — so
    // the picker is in REPLACE mode there. An unfiltered list would destroy the
    // author's working expression AND leave the doc unsavable, which is the one
    // combination that must never ship.
    const src: Node = {
      id: 'src',
      type: 'http_request',
      config: {
        method: 'GET',
        url: 'https://a.test',
        outputs: [
          { name: 'rows', type: 'json' },
          { name: 'label', type: 'string' },
        ],
      },
      position: at,
    };
    const pick: Node = {
      id: 'pick',
      type: 'filter',
      config: { items: '${nodes.src.output.rows}', predicate: '${item}' },
      position: at,
    };
    mount([src, pick], [{ id: 'e1', from: 'src', to: 'pick', on: 'success' }], PARAMS, 'pick');
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference into items' }));

    // The json output is assignable to an array and survives.
    expect(screen.getByRole('button', { name: /HTTP Request → rows/ })).toBeTruthy();
    // A string output, a string param and a run field are all type-refused here,
    // and so are not offered at all.
    expect(screen.queryByRole('button', { name: /HTTP Request → label/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^topic/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^runId/ })).toBeNull();
  });

  it('withholds the control on a JSON field, which could not apply the insert', () => {
    // A `json` control parses its text with `JSON.parse` on apply, so a bare
    // `${...}` is not applicable there at all — offering the picker would be a
    // dead end rather than an affordance.
    mount([FETCH, CALL], CHAIN, [], 'call');
    expect(screen.getByRole('button', { name: 'Insert reference into url' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert reference into headers' })).toBeNull();
    // The json field itself is still rendered — this is about the picker only.
    expect(screen.getByRole('textbox', { name: /headers/ })).toBeTruthy();
  });

  it('withholds the control on a switch case list, which the engine matches LITERALLY', () => {
    // `evalSwitchBranch` compares `rawCases.includes(out)` straight off
    // `node.config` — no `substitute` — so a `${}` case label saves clean and
    // then never matches anything, routing every value to `default`. A false
    // offer that passes every gate is worse than no offer.
    mount([FETCH, { id: 'sw', type: 'switch', config: { on: '' }, position: at }], [], [], 'sw');
    expect(screen.getByRole('button', { name: 'Insert reference into on' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert reference into cases' })).toBeNull();
    expect(screen.getByRole('textbox', { name: /cases/ })).toBeTruthy();
  });

  it('keeps the control alive for the FIRST node, which has no upstream at all', () => {
    // `fetch` runs first: no upstream producer, no params — but `run`/`trigger`
    // are always available, so the control must still be there. The empty case
    // is a node in a doc with neither, which cannot happen for a real node; what
    // this pins is that the always-available roots keep the control alive.
    const ui = mount([FETCH, CALL], CHAIN, [], 'fetch');
    ui.open('url');
    expect(screen.getByRole('button', { name: /^runId/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Upstream outputs' })).toBeNull();
  });
});
