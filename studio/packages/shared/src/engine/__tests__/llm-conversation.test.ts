import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { validateDoc, validateRefs } from '../params.js';

// ===========================================================================
// #2 L12 — multi-turn via stateless dataflow: the save-time gates for the
// `history` input (whole-value `${}`, non-scalar type) and the `emitMessages`
// transcript opt-in (structured coupling, declared-row conflicts).
// ===========================================================================

// --- helpers ---------------------------------------------------------------

let seq = 0;
function llm(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'llm_call', config, position: { x: seq, y: 0 } };
}

function edge(from: string, to: string): Edge {
  return { id: `${from}->${to}`, from, to, on: 'success' };
}

function doc(
  nodes: Node[],
  edges: Edge[] = [],
  params: Param[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}

/** An upstream llm node whose (post-lowering) contract declares the transcript. */
function upstreamWithTranscript(id: string): Node {
  return llm(id, {
    prompt: 'p',
    emitMessages: true,
    outputs: [
      { name: 'text', type: 'string' },
      { name: 'stopReason', type: 'string' },
      { name: 'messages', type: 'json' },
    ],
  });
}

// ===========================================================================
// validateDoc — the config-SHAPE half (validateLlmCallConversation)
// ===========================================================================

describe('validateDoc — llm_call conversation surface (#2 L12)', () => {
  it('accepts emitMessages:true on a text-mode node with the lowered json row', () => {
    expect(validateDoc(doc([upstreamWithTranscript('a')]))).toEqual([]);
  });

  it("rejects emitMessages:true with outputMode:'structured'", () => {
    const d = doc([
      llm('a', {
        prompt: 'p',
        emitMessages: true,
        outputMode: 'structured',
        outputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      }),
    ]);
    expect(validateDoc(d).join(' ')).toMatch(/emitMessages is not supported/);
  });

  it('rejects a LITERAL-array history at save (dataflow refs only — literal turns belong in `messages`)', () => {
    const d = doc([llm('a', { prompt: 'p', history: [{ role: 'user', content: 'x' }] })]);
    expect(validateDoc(d).join(' ')).toMatch(/history must be a whole-value/);
  });

  it('rejects a declared `messages` output row WITHOUT emitMessages (the flag is the opt-in, not the row)', () => {
    const d = doc([
      llm('a', {
        prompt: 'p',
        outputs: [
          { name: 'text', type: 'string' },
          { name: 'messages', type: 'json' },
        ],
      }),
    ]);
    expect(validateDoc(d).join(' ')).toMatch(/declare the transcript via emitMessages/);
  });

  it('rejects emitMessages:true when the author declared a non-json `messages` row', () => {
    const d = doc([
      llm('a', {
        prompt: 'p',
        emitMessages: true,
        outputs: [{ name: 'messages', type: 'string' }],
      }),
    ]);
    expect(validateDoc(d).join(' ')).toMatch(/must be declared type 'json'/);
  });
});

// ===========================================================================
// validateRefs — the EXPRESSION half (whole-value mode + non-scalar type)
// ===========================================================================

describe('validateRefs — llm_call history expression (#2 L12)', () => {
  it('accepts a whole-value ref to an upstream transcript output', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', { prompt: 'next', history: '${nodes.a.output.messages}' }),
      ],
      [edge('a', 'b')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects an interpolated (non-whole-value) history', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', { prompt: 'next', history: 'past: ${nodes.a.output.messages}' }),
      ],
      [edge('a', 'b')],
    );
    expect(validateRefs(d).join(' ')).toMatch(/history must be a whole-value/);
  });

  it('rejects a definitely-scalar history expression (a string output can never be a turn array)', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', { prompt: 'next', history: '${nodes.a.output.text}' }),
      ],
      [edge('a', 'b')],
    );
    expect(validateRefs(d).join(' ')).toMatch(/history must resolve to an array/);
  });

  it('rejects a ref to a DOWNSTREAM node (generic availability still applies to history)', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', { prompt: 'next', history: '${nodes.a.output.messages}' }),
      ],
      [edge('b', 'a')], // a runs AFTER b — its transcript can never exist for b
    );
    expect(validateRefs(d).join(' ')).toMatch(/does not name an upstream node/);
  });

  it('still enforces the history rules when `tools` are declared (the deferred-eval branch scans the rest)', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', {
          prompt: 'next',
          history: '${nodes.a.output.text}',
          tools: [
            {
              name: 'adder',
              description: 'Adds.',
              parameters: { type: 'object', properties: { a: { type: 'number' } } },
              expression: '${add(tool.args.a, 1)}',
            },
          ],
        }),
      ],
      [edge('a', 'b')],
    );
    expect(validateRefs(d).join(' ')).toMatch(/history must resolve to an array/);
  });
});

describe('validateDoc/validateRefs — L12 review-hardening rules', () => {
  it('rejects a whitespace-PADDED whole-value history (dispatch substitutes untrimmed)', () => {
    const d = doc(
      [
        upstreamWithTranscript('a'),
        llm('b', { prompt: 'next', history: '${nodes.a.output.messages} ' }),
      ],
      [edge('a', 'b')],
    );
    expect(validateRefs(d).join(' ')).toMatch(/whitespace around the whole-value/);
  });

  it('rejects conversation fields on a CALL node (they would be silently inert)', () => {
    const call: Node = {
      id: 'c',
      type: 'llm_call',
      config: { emitMessages: true },
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_x', params: {} },
    };
    expect(validateDoc(doc([call])).join(' ')).toMatch(/no effect on a call node/);
  });
});
