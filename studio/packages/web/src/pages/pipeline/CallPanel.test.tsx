import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Param, PipelineVersion } from '@autonomy-studio/shared';
import { MAX_CALL_DEPTH } from '@autonomy-studio/shared';
import { CallPanel } from './CallPanel';
import { buildParams, parseJsonParams, seedCall, type CallTarget } from './callRules';
import { createCanvasStore } from './canvasStore';

/**
 * #425 — the call-node editor.
 *
 * The read model (`seedCall`) and the two write paths (`buildParams`,
 * `parseJsonParams`) are tested as functions, because that is where every
 * clobber hazard is decided; the component test then covers the one thing they
 * cannot — that the panel writes to the store exactly once, with what the form
 * shows.
 */

const CHILD_PARAMS: Param[] = [
  { name: 'query', type: 'string', required: true },
  { name: 'limit', type: 'number', required: false, default: 10 },
];

const TARGETS: CallTarget[] = [
  { pipelineId: 'p_a', pipelineName: 'Alpha', versionId: 'pv_a1', version: 1, params: [] },
  {
    pipelineId: 'p_a',
    pipelineName: 'Alpha',
    versionId: 'pv_a2',
    version: 2,
    params: CHILD_PARAMS,
  },
  { pipelineId: 'p_b', pipelineName: 'Beta', versionId: 'pv_b1', version: 1, params: [] },
];

describe('seedCall (#425 read model)', () => {
  it('puts a brand-new node (no call) in pick mode with nothing chosen', () => {
    const seed = seedCall(undefined, TARGETS);
    expect(seed.mode).toBe('pick');
    expect(seed.pipelineId).toBe('');
    expect(seed.versionId).toBe('');
    expect(seed.wait).toBe(false);
  });

  it('resolves a stored literal version id back to its pipeline AND version', () => {
    const seed = seedCall({ pipelineVersionId: 'pv_a2', params: {} }, TARGETS);
    expect(seed.mode).toBe('pick');
    expect(seed.pipelineId).toBe('p_a');
    expect(seed.versionId).toBe('pv_a2');
    // The target's declared params are offered as rows even though the node
    // carries no value for them — that is how the operator learns what to pass.
    expect(Object.keys(seed.params).sort()).toEqual(['limit', 'query']);
  });

  it('shows an EXPRESSION target as text rather than as "nothing chosen"', () => {
    const seed = seedCall({ pipelineVersionId: '${params.target}', params: {} }, TARGETS);
    expect(seed.mode).toBe('expression');
    expect(seed.expression).toBe('${params.target}');
  });

  it('shows a DEAD literal id as text too, so an Apply cannot silently drop it', () => {
    // A version that was deleted (or belongs to another owner) is not in the
    // list. Presenting the node as "no target chosen" would lose the id on the
    // first Apply, with nothing on screen to say what was lost.
    const seed = seedCall({ pipelineVersionId: 'pv_gone', params: {} }, TARGETS);
    expect(seed.mode).toBe('expression');
    expect(seed.expression).toBe('pv_gone');
  });

  it('keeps a param key the target does NOT declare, alongside the declared ones', () => {
    const seed = seedCall({ pipelineVersionId: 'pv_a2', params: { stale: 'keep me' } }, TARGETS);
    expect(Object.keys(seed.params).sort()).toEqual(['limit', 'query', 'stale']);
    expect(seed.params['stale']).toBe('keep me');
  });

  it('renders stored values as editable text via the params editor coercion', () => {
    const seed = seedCall(
      { pipelineVersionId: 'pv_a2', params: { query: 'hi', limit: 5 }, wait: true },
      TARGETS,
    );
    expect(seed.params['query']).toBe('hi');
    expect(seed.params['limit']).toBe('5');
    expect(seed.wait).toBe(true);
  });
});

describe('buildParams (#425 typed argument values)', () => {
  const declared = new Map(CHILD_PARAMS.map((p) => [p.name, p]));

  it('coerces each value to its DECLARED type', () => {
    const out = buildParams({ query: 'ships', limit: '25' }, declared);
    expect(out).toEqual({ ok: true, value: { query: 'ships', limit: 25 } });
  });

  it('OMITS a blank value so the child pipeline applies its own default', () => {
    const out = buildParams({ query: 'ships', limit: '' }, declared);
    expect(out.ok && Object.keys(out.value)).toEqual(['query']);
  });

  it('stores a ${} value VERBATIM whatever the declared type', () => {
    // Coercing `${params.n}` against a `number` param would reject the one
    // dynamic form the schema documents; it is resolved at dispatch, not here.
    const out = buildParams({ limit: '${params.n}' }, declared);
    expect(out).toEqual({ ok: true, value: { limit: '${params.n}' } });
  });

  it('reports a type error against the offending param by NAME', () => {
    const out = buildParams({ limit: 'lots' }, declared);
    expect(out).toEqual({ ok: false, error: 'limit: expected a number' });
  });

  it('carries an UNDECLARED key as its text rather than guessing a type', () => {
    const out = buildParams({ stale: 'keep me' }, declared);
    expect(out).toEqual({ ok: true, value: { stale: 'keep me' } });
  });
});

describe('parseJsonParams (#425 unresolved-target fallback)', () => {
  it('accepts a JSON object and treats blank as none', () => {
    expect(parseJsonParams('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonParams('  ')).toEqual({ ok: true, value: {} });
  });

  it('refuses a non-object and invalid JSON', () => {
    expect(parseJsonParams('[1,2]').ok).toBe(false);
    expect(parseJsonParams('null').ok).toBe(false);
    expect(parseJsonParams('{oops').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The component, over a stubbed listing.

const listAllPipelineVersions = vi.fn();
vi.mock('../../api/pipelines', () => ({
  listAllPipelineVersions: (signal?: AbortSignal) => listAllPipelineVersions(signal) as unknown,
}));

function version(id: string, n: number, params: Param[]): PipelineVersion {
  return {
    id,
    pipelineId: 'p_a',
    resourceId: `res_${id}`,
    version: n,
    nodes: [],
    edges: [],
    containers: [],
    params,
    outputs: [],
    catalogVersion: 1,
    createdAt: 0,
  } as unknown as PipelineVersion;
}

function mount() {
  listAllPipelineVersions.mockResolvedValue([
    { pipeline: { id: 'p_a', name: 'Alpha' }, version: version('pv_a2', 2, CHILD_PARAMS) },
  ]);
  const store = createCanvasStore();
  store.getState().loadVersion(null);
  store.getState().addNode('execute_pipeline');
  const nodeId = store.getState().nodes[0]!.id;
  render(<CallPanel store={store} nodeId={nodeId} call={undefined} />);
  return { store, nodeId };
}

describe('CallPanel (component)', () => {
  it('writes the chosen target, wait flag and typed params in ONE store write', async () => {
    const { store } = mount();
    // The declared params appear only after the listing resolves — which is the
    // whole reason the editor does not mount until then.
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Pipeline/), { target: { value: 'p_a' } });
    fireEvent.change(screen.getByLabelText(/Version/), { target: { value: 'pv_a2' } });
    await waitFor(() => expect(screen.getByLabelText(/query/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/query/), { target: { value: 'ships' } });
    fireEvent.change(screen.getByLabelText(/limit/), { target: { value: '25' } });
    fireEvent.click(screen.getByLabelText(/Wait for the child run/));

    const before = store.getState().past.length;
    fireEvent.click(screen.getByRole('button', { name: 'Apply call' }));

    expect(store.getState().nodes[0]!.call).toEqual({
      pipelineVersionId: 'pv_a2',
      params: { query: 'ships', limit: 25 },
      wait: true,
    });
    // ONE gesture, ONE undo entry (U21's rule) — not one per control touched.
    expect(store.getState().past.length).toBe(before + 1);
  });

  it('refuses an Apply with no target chosen, and writes nothing', async () => {
    const { store } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Apply call' }));
    expect(screen.getByText('Choose a pipeline and a version.')).toBeTruthy();
    expect(store.getState().nodes[0]!.call).toBeUndefined();
  });

  it('clears the version when the pipeline changes, so the pair can never disagree', async () => {
    const { store } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Pipeline/), { target: { value: 'p_a' } });
    fireEvent.change(screen.getByLabelText(/Version/), { target: { value: 'pv_a2' } });
    fireEvent.change(screen.getByLabelText(/Pipeline/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply call' }));
    expect(store.getState().nodes[0]!.call).toBeUndefined();
  });

  it('CARRIES the arguments across a pick→expression→pick mode switch', async () => {
    // The data loss the switch used to cause: the two params editors hold the
    // same fact in two shapes, and `apply` reads whichever the mode owns — so
    // toggling the mode without translating silently discarded the other one's
    // contents, with nothing on screen to say so.
    const { store } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Pipeline/), { target: { value: 'p_a' } });
    fireEvent.change(screen.getByLabelText(/Version/), { target: { value: 'pv_a2' } });
    await waitFor(() => expect(screen.getByLabelText(/query/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/query/), { target: { value: 'ships' } });
    fireEvent.change(screen.getByLabelText(/limit/), { target: { value: '25' } });

    fireEvent.click(screen.getByLabelText('Expression'));
    // Translated, and TYPED — `limit` is a number on the far side, not '25'.
    const json = (screen.getByLabelText(/Parameters/) as HTMLTextAreaElement).value;
    expect(JSON.parse(json)).toEqual({ query: 'ships', limit: 25 });

    fireEvent.click(screen.getByLabelText('Pick a version'));
    expect(screen.getByLabelText(/query/)).toHaveProperty('value', 'ships');
    expect(screen.getByLabelText(/limit/)).toHaveProperty('value', '25');

    fireEvent.click(screen.getByRole('button', { name: 'Apply call' }));
    expect(store.getState().nodes[0]!.call?.params).toEqual({ query: 'ships', limit: 25 });
  });

  it('REFUSES a mode switch it cannot translate, rather than completing it lossily', async () => {
    const { store } = mount();
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Pipeline/), { target: { value: 'p_a' } });
    fireEvent.change(screen.getByLabelText(/Version/), { target: { value: 'pv_a2' } });
    await waitFor(() => expect(screen.getByLabelText(/limit/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/limit/), { target: { value: 'lots' } });

    fireEvent.click(screen.getByLabelText('Expression'));
    // Still in pick mode, with the offending text visible and the reason said.
    expect(screen.getByText('limit: expected a number')).toBeTruthy();
    expect(screen.getByLabelText(/limit/)).toHaveProperty('value', 'lots');
    expect(store.getState().nodes[0]!.call).toBeUndefined();
  });

  /**
   * #952 — the hint is a CLAIM ABOUT ANOTHER MODULE'S BEHAVIOUR, so it drifts
   * silently when that module changes. It shipped saying a `${}` target "is not
   * checked when you save", which was true until `validateRefs` learned to scan
   * `node.call` — at which point the panel was telling the operator to distrust
   * a check that had started working. Nothing caught it, because no test read
   * the sentence.
   *
   * Pinned as the three claims that must stay in step with the code, rather
   * than as the exact wording — a future rewording is free; flipping any claim
   * is not:
   *
   *  1. the refs in a `${}` target ARE checked at save (`validateRefs` walks
   *     `node.call`, since #952);
   *  2. the SAVE-time self-call/depth guards still see LITERAL targets only
   *     (`literalCallTargets` drops a `${}` one — unfixable by construction,
   *     since the value is unknowable until dispatch);
   *  3. run time DOES bound the chain (#796 `child.ts` refuses a spawn past
   *     `MAX_CALL_DEPTH` hops of `parentRunId`), so the recursion the operator
   *     is being warned about fails at dispatch rather than running away.
   *
   * Claim 3 is the one this test was rewritten for: the panel shipped saying
   * "recursion through a DYNAMIC target is bounded by nothing" and kept saying
   * it for the whole of #796, which is the failure mode the panel's own
   * docblock names — an operator who is told a check is absent routes around
   * one that is doing its job.
   */
  it('tells the operator which call-node guards run at save time, and which at run time', async () => {
    mount();
    await waitFor(() => expect(screen.getByLabelText(/Pipeline/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Expression'));

    const hint = screen.getByText(/resolved when the node dispatches/);
    expect(hint.textContent).toMatch(/references are checked when you save/i);
    expect(hint.textContent).not.toMatch(/not checked when you save/i);
    // Claim 2 — still true, and the reason the hint survives at all.
    expect(hint.textContent).toMatch(/only see literal targets/i);
    // Claim 3 — the run-time bound, and that reaching it is a FAILURE rather
    // than a quietly-capped success. The depth is read from the SSOT so the
    // sentence cannot drift from the constant it is quoting.
    expect(hint.textContent).toMatch(/refused/i);
    expect(hint.textContent).toMatch(new RegExp(`${MAX_CALL_DEPTH}\\s+nested`, 'i'));
  });

  it('does not write anything to the store while the listing is still in flight', () => {
    // The clobber hazard the loading gate exists for: a literal target must not
    // be re-decided (or written) before the list that could resolve it arrives.
    const { store } = mount();
    expect(screen.getByText('Loading pipelines…')).toBeTruthy();
    expect(store.getState().nodes[0]!.call).toBeUndefined();
    expect(store.getState().past).toHaveLength(1); // the addNode, and nothing else
  });
});
