import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from 'zustand';
import { listFunctions, type Edge, type Node, type Param } from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';
import { validateCanvas } from './canvasDoc';
import { applyWrap, wrapTarget } from './expressionInsert';

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
        datasets={[]}
        nodeId={node.id}
        nodeType={node.type}
        config={node.config}
        connectionId={node.connectionId}
        call={undefined}
      />
    );
  }

  render(<Harness />);
  return {
    storedConfig: () => store.getState().nodes.find((n) => n.id === selected)?.config ?? {},
    apply: () => fireEvent.click(screen.getByRole('button', { name: 'Apply config' })),
    open: (field: string) =>
      fireEvent.click(screen.getByRole('button', { name: `Insert reference into ${field}` })),
    openFunctions: (field: string) =>
      fireEvent.click(
        screen.getByRole('button', { name: `Wrap an expression in ${field} in a function` }),
      ),
    /** The functions the open list offers, by name. */
    offered: () =>
      screen
        .queryAllByRole('button')
        .map((b) => /^(\w+)\(.*\) → /.exec(b.getAttribute('aria-label') ?? '')?.[1])
        .filter((name): name is string => name !== undefined),
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
    // Named by the activity's IDENTIFYING name (#878) — the same text its box
    // carries — not by the raw node id the reference is built from.
    expect(screen.getByRole('button', { name: /HTTP Request 1 → body/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Upstream outputs' })).toBeTruthy();
  });

  /**
   * #878 — a producer is offered under the name its BOX carries, so the author
   * can match an option to a rectangle. The option text used to be the activity
   * TITLE, with the raw doc id appended only where two producers rendered the
   * same one ("HTTP Request (fetch)"); that bought uniqueness with a string the
   * canvas shows nowhere. The ordinal is unique AND readable.
   */
  it('names a producer the way the canvas names it', () => {
    const gate: Node = { id: 'gate', type: 'if', config: { condition: '${item}' }, position: at };
    mount([FETCH, gate], [{ id: 'e1', from: 'fetch', to: 'gate', on: 'success' }], [], 'gate');
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference into condition' }));
    expect(screen.getByRole('button', { name: /^HTTP Request 1 → body/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /HTTP Request \(fetch\)/ })).toBeNull();
  });

  it('tells two producers of the SAME activity type apart', () => {
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
    expect(screen.getByRole('button', { name: /HTTP Request 1 → body/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /HTTP Request 2 → body/ })).toBeTruthy();
  });

  it('writes the chosen reference into the DOC, not merely onto the screen', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    ui.open('url');
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request 1 → body/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request 1 → body/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request 1 → body/ }));
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
    const item = screen.getByRole('button', { name: /HTTP Request 1 → body/ });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /HTTP Request 1 → body/ })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request 1 → body/ }));
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
    expect(screen.getByRole('button', { name: /HTTP Request 1 → rows/ })).toBeTruthy();
    // A string output, a string param and a run field are all type-refused here,
    // and so are not offered at all.
    expect(screen.queryByRole('button', { name: /HTTP Request 1 → label/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^topic/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^runId/ })).toBeNull();
  });

  it("offers ${item} in a filter's PREDICATE, and not in its items (#864)", () => {
    // Outside a foreach, `${item}` is bound only in the predicate — the lambda
    // position of the composed `filter(items, predicate)`. One node, two
    // fields, two different answers: the site is per FIELD.
    const src: Node = {
      id: 'src',
      type: 'http_request',
      config: { method: 'GET', url: 'https://a.test', outputs: [{ name: 'rows', type: 'json' }] },
      position: at,
    };
    const pick: Node = {
      id: 'pick',
      type: 'filter',
      config: { items: '${nodes.src.output.rows}', predicate: '${default(params.flag, true)}' },
      position: at,
    };
    const ui = mount(
      [src, pick],
      [{ id: 'e1', from: 'src', to: 'pick', on: 'success' }],
      [{ name: 'flag', type: 'boolean', required: false }],
      'pick',
    );
    ui.open('predicate');
    fireEvent.click(screen.getByRole('button', { name: /^item — / }));
    ui.apply();
    expect(ui.storedConfig()['predicate']).toBe('${item}');

    ui.open('items');
    expect(screen.queryByRole('button', { name: /^item — / })).toBeNull();
    expect(screen.getByRole('button', { name: /HTTP Request 1 → rows/ })).toBeTruthy();
  });

  it('withholds the control on a JSON field, which could not apply the insert', () => {
    // A `json` control parses its text with `JSON.parse` on apply, so a bare
    // `${...}` is not applicable there at all — offering the picker would be a
    // dead end rather than an affordance.
    const agent: Node = { id: 'agent', type: 'agent_task', config: {}, position: at };
    mount([FETCH, agent], [{ id: 'e1', from: 'fetch', to: 'agent', on: 'success' }], [], 'agent');
    expect(screen.getByRole('button', { name: 'Insert reference into task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Insert reference into outputSchema/ })).toBeNull();
    // The json field itself is still rendered — this is about the picker only.
    expect(screen.getByRole('textbox', { name: /outputSchema/ })).toBeTruthy();
  });

  it('offers a header VALUE a reference, and never its key or a secret name (#852)', () => {
    // A record key is copied verbatim by `substitute` and never scanned, so the
    // validator would wave every reference through on it — the false offer.
    // A secret name may not hold `${}` at all.
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    fireEvent.click(screen.getByRole('button', { name: 'Add headers row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add secretHeaders row' }));
    expect(
      screen.getByRole('button', { name: 'Insert reference into headers row 1 value' }),
    ).toBeTruthy();
    for (const cell of [
      'headers row 1 key',
      'secretHeaders row 1 key',
      'secretHeaders row 1 secret name',
    ]) {
      expect(screen.getByRole('textbox', { name: cell })).toBeTruthy();
      expect(screen.queryByRole('button', { name: `Insert reference into ${cell}` })).toBeNull();
    }

    // Picked while the row has no key yet: the candidate still carries the
    // probed row (`placeRowCandidate`, unit-tested), so the value lands.
    ui.open('headers row 1 value');
    fireEvent.click(screen.getByRole('button', { name: /HTTP Request 1 → body/ }));
    fireEvent.change(ui.field('headers row 1 key'), { target: { value: 'X-Body' } });
    fireEvent.change(ui.field('secretHeaders row 1 key'), { target: { value: 'Authorization' } });
    fireEvent.change(ui.field('secretHeaders row 1 secret name'), { target: { value: 'tok' } });
    fireEvent.change(ui.field('url'), { target: { value: 'https://b.test' } });
    ui.apply();
    expect(ui.storedConfig()).toMatchObject({
      headers: { 'X-Body': '${nodes.fetch.output.body}' },
      secretHeaders: { Authorization: { $secret: 'tok' } },
    });
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

// #864 — the FUNCTIONS half: a function goes AROUND the expression at the caret.
describe('ExpressionPicker — wrap in a function', () => {
  const READS: Node = { ...CALL, config: { method: 'GET', url: '${nodes.fetch.output.body}' } };

  it('wraps the expression in the field and writes the result into the DOC', () => {
    const ui = mount([FETCH, READS], CHAIN, [], 'call');
    ui.openFunctions('url');
    fireEvent.click(screen.getByRole('button', { name: /^toUpper\(/ }));
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('${toUpper(nodes.fetch.output.body)}');
  });

  it('offers nothing the save gate would refuse — every row validates as clean as the field already does', () => {
    const ui = mount([FETCH, READS], CHAIN, [], 'call');
    ui.openFunctions('url');
    const offered = ui.offered();
    // Non-trivial on both sides: plenty is offered, and plenty is not.
    expect(offered).toContain('toUpper');
    expect(offered).toContain('concat');
    expect(offered.length).toBeLessThan(listFunctions().length);
    // Two required arguments, so a one-argument wrap is an arity refusal.
    expect(offered).not.toContain('substring');
    expect(offered).not.toContain('default');

    const url = READS.config['url'] as string;
    const span = wrapTarget(url, url.length, url.length)!;
    const issues = (value: string) =>
      validateCanvas([FETCH, { ...READS, config: { ...READS.config, url: value } }], CHAIN, [], []);
    const baseline = issues(url);
    for (const name of offered) {
      const after = issues(applyWrap(url, span, name).value);
      expect(
        after.filter((i) => !baseline.includes(i)),
        name,
      ).toEqual([]);
    }
  });

  it('offers only what a TYPE-CHECKED field would accept', () => {
    // A `filter`'s `items` must be an array: a string-returning wrap would
    // leave the doc unsavable.
    const src: Node = {
      id: 'src',
      type: 'http_request',
      config: { method: 'GET', url: 'https://a.test', outputs: [{ name: 'rows', type: 'json' }] },
      position: at,
    };
    const pick: Node = {
      id: 'pick',
      type: 'filter',
      config: { items: '${nodes.src.output.rows}', predicate: '${item}' },
      position: at,
    };
    const ui = mount(
      [src, pick],
      [{ id: 'e1', from: 'src', to: 'pick', on: 'success' }],
      [],
      'pick',
    );
    ui.openFunctions('items');
    const offered = ui.offered();
    expect(offered).not.toContain('toUpper');
    expect(offered).not.toContain('length');
  });

  it('wraps only the SELECTED part of an expression, in place', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    const url = ui.field('url');
    const text = '${concat(nodes.fetch.output.body, "x")}';
    fireEvent.change(url, { target: { value: text } });
    url.selectionStart = text.indexOf('nodes');
    url.selectionEnd = text.indexOf(',');
    fireEvent.select(url);

    ui.openFunctions('url');
    fireEvent.click(screen.getByRole('button', { name: /^toUpper\(/ }));
    ui.apply();
    expect(ui.storedConfig()['url']).toBe('${concat(toUpper(nodes.fetch.output.body), "x")}');
  });

  it('says what to do when the caret is in no expression, rather than offering a bare call', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    fireEvent.change(ui.field('url'), { target: { value: 'https://a.test' } });
    ui.openFunctions('url');
    expect(screen.getByText(/Put the cursor inside a \$\{…\} expression/)).toBeTruthy();
    expect(ui.offered()).toEqual([]);
  });

  it('offers nothing around an expression the save already refuses — a wrap cannot repair it', () => {
    const ui = mount([FETCH, CALL], CHAIN, [], 'call');
    fireEvent.change(ui.field('url'), { target: { value: '${nodes.nope.output.x}' } });
    ui.openFunctions('url');
    expect(ui.offered()).toEqual([]);
    expect(screen.getByText(/No function takes this expression/)).toBeTruthy();
  });

  it('CLOSES when the field is edited while open, so a choice cannot put back the old text', () => {
    const ui = mount([FETCH, READS], CHAIN, [], 'call');
    ui.openFunctions('url');
    expect(ui.offered()).toContain('toUpper');
    const edited = '${nodes.fetch.output.body} and more';
    fireEvent.change(ui.field('url'), { target: { value: edited } });
    expect(ui.offered()).toEqual([]);
    expect(
      screen
        .getByRole('button', { name: 'Wrap an expression in url in a function' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(ui.field('url').value).toBe(edited);

    // Editing BACK to the text it opened on (an undo) must not revive it.
    fireEvent.change(ui.field('url'), { target: { value: READS.config['url'] } });
    expect(ui.offered()).toEqual([]);
  });

  it('keeps ONE list open at a time', () => {
    const ui = mount([FETCH, READS], CHAIN, [], 'call');
    ui.open('url');
    expect(screen.getByRole('button', { name: /HTTP Request 1 → body/ })).toBeTruthy();
    ui.openFunctions('url');
    expect(screen.queryByRole('button', { name: /HTTP Request 1 → body/ })).toBeNull();
    expect(ui.offered()).toContain('toUpper');
    ui.open('url');
    expect(ui.offered()).toEqual([]);
  });
});
