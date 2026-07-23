import { describe, expect, it } from 'vitest';
import {
  lowerAgentTaskStructuredOutputs,
  lowerLlmEmitMessages,
  lowerLlmStructuredOutputs,
  lowerNodeOutputs,
} from '../lower.js';
import { getActivity } from '../registry.js';
import { AGENT_TASK_ACTIVITY_TYPE, LLM_CALL_ACTIVITY_TYPE } from '../types.js';
import type { Node } from '../../schemas/pipeline.js';

function node(id: string, type: string, config: Record<string, unknown> = {}): Node {
  return { id, type, config, position: { x: 0, y: 0 } };
}

describe('lowerNodeOutputs', () => {
  it('seeds an absent config.outputs from the catalog for a known activity type', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request')]);
    // http_request declares status/body/headers (registry.ts).
    expect(lowered!.config['outputs']).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
  });

  it('leaves a node that already DECLARES config.outputs unchanged (author override wins)', () => {
    const declared = [{ name: 'custom', type: 'string' }];
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { outputs: declared })]);
    expect(lowered!.config['outputs']).toBe(declared);
  });

  it('leaves an explicit empty config.outputs ([]) unchanged — "declares nothing" is NOT absent', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { outputs: [] })]);
    expect(lowered!.config['outputs']).toEqual([]);
  });

  it('leaves an unknown activity type absent (no catalog entry to seed from)', () => {
    const n = node('a', 'not_a_real_activity');
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n); // unchanged node returned as-is
  });

  it('leaves an uncatalogued call_pipeline node absent', () => {
    // A call_pipeline node carries a `call` config and is not in the catalog, so
    // its outputs come from the child projection, never a catalog default.
    const n: Node = {
      id: 'c',
      type: 'call_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_1', params: {} },
    };
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n);
  });

  it('leaves a CATALOGUED execute_pipeline call node absent (child projection, not the catalog template)', () => {
    // #4 A9 — `execute_pipeline` IS now catalogued (with `outputs:[]`), so the
    // uncatalogued escape hatch above no longer protects a call node. Lowering
    // MUST still skip it: seeding `outputs:[]` would flip the node's contract from
    // `absent` (stores ALL child outputs) to `declared []` (stores NONE), silently
    // dropping every child output. The skip keys off `node.call`, not the type.
    const n: Node = {
      id: 'c',
      type: 'execute_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_1', params: {} },
    };
    const [lowered] = lowerNodeOutputs([n]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(n);
  });

  it('deep-copies the catalog outputs so the shared registry cannot be mutated via the doc', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request')]);
    const seeded = lowered!.config['outputs'] as Array<{ name: string; type: string }>;
    const registryOutputs = getActivity('http_request')!.outputs;
    // Same contents, but fresh objects — mutating the doc must not reach the registry.
    expect(seeded).toEqual(registryOutputs);
    expect(seeded[0]).not.toBe(registryOutputs[0]);
    seeded[0]!.name = 'MUTATED';
    expect(getActivity('http_request')!.outputs[0]!.name).toBe('status');
  });

  it('seeds a node that is a container (loop/stage) child like any other', () => {
    // `lowerNodeOutputs` takes the FLAT `nodes[]` array and never sees
    // `containers` — a container references its children by id, so a child node
    // is just an ordinary entry here. There is no separate nested-node path:
    // membership is invisible to this helper, so a would-be loop/stage child is
    // seeded exactly like a top-level node.
    const [child] = lowerNodeOutputs([node('loop_child', 'http_request')]);
    expect(child!.config['outputs']).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
  });

  it('preserves the rest of the node config while seeding outputs', () => {
    const [lowered] = lowerNodeOutputs([node('a', 'http_request', { url: 'https://x' })]);
    expect(lowered!.config['url']).toBe('https://x');
    expect(lowered!.config['outputs']).toBeDefined();
  });
});

describe('lowerLlmStructuredOutputs (#2 L4a)', () => {
  const schema = {
    type: 'object',
    properties: { category: { type: 'string' }, score: { type: 'number' } },
  };

  it('derives config.outputs from a structured llm_call outputSchema', () => {
    const [lowered] = lowerLlmStructuredOutputs([
      node('a', LLM_CALL_ACTIVITY_TYPE, {
        prompt: 'classify',
        outputMode: 'structured',
        outputSchema: schema,
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'category', type: 'string' },
      { name: 'score', type: 'number' },
    ]);
  });

  it('OVERWRITES a stale catalog-default seed ([text, stopReason]) — the UI-seed path', () => {
    // The web palette seeds `[text, stopReason]` on node creation; switching to
    // structured mode + authoring an outputSchema must REPLACE that stale contract,
    // not merge with it (the whole reason the overwrite exception exists).
    const [lowered] = lowerLlmStructuredOutputs([
      node('a', LLM_CALL_ACTIVITY_TYPE, {
        prompt: 'classify',
        outputMode: 'structured',
        outputSchema: schema,
        outputs: [
          { name: 'text', type: 'string' },
          { name: 'stopReason', type: 'string' },
        ],
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'category', type: 'string' },
      { name: 'score', type: 'number' },
    ]);
  });

  it('leaves a TEXT-mode (or legacy) llm_call untouched — lowerNodeOutputs seeds it', () => {
    const textNode = node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'hi' });
    const [lowered] = lowerLlmStructuredOutputs([textNode]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(textNode); // unchanged node returned as-is
  });

  it('leaves a non-llm_call node untouched', () => {
    const http = node('a', 'http_request', { outputMode: 'structured', outputSchema: schema });
    const [lowered] = lowerLlmStructuredOutputs([http]);
    expect(lowered).toBe(http);
  });

  it('does NOT lower an INVALID outputSchema (leaves outputs as-is for validateDoc to reject)', () => {
    // A corrupt/absent-schema structured node must not lower to garbage; skipping
    // it leaves any prior contract intact and lets the save-time validator raise a
    // readable diagnostic (→ 400), so nothing bad ever persists.
    const bad = node('a', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'x',
      outputMode: 'structured',
      outputSchema: { type: 'object', properties: {} }, // empty → invalid subset
    });
    const [lowered] = lowerLlmStructuredOutputs([bad]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(bad);
  });

  it('composes with lowerNodeOutputs: structured derives, text gets the catalog default', () => {
    const [structured, text] = lowerNodeOutputs(
      lowerLlmStructuredOutputs([
        node('s', LLM_CALL_ACTIVITY_TYPE, {
          prompt: 'classify',
          outputMode: 'structured',
          outputSchema: schema,
        }),
        node('t', LLM_CALL_ACTIVITY_TYPE, { prompt: 'hi' }),
      ]),
    );
    expect(structured!.config['outputs']).toEqual([
      { name: 'category', type: 'string' },
      { name: 'score', type: 'number' },
    ]);
    // text-mode node: lowerNodeOutputs seeds the catalog default.
    expect(text!.config['outputs']).toEqual([
      { name: 'text', type: 'string' },
      { name: 'stopReason', type: 'string' },
    ]);
  });
});

describe('lowerAgentTaskStructuredOutputs (#2 L11b)', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
  };

  it('derives config.outputs from an agent_task outputSchema (presence = opt-in, no outputMode)', () => {
    const [lowered] = lowerAgentTaskStructuredOutputs([
      node('a', AGENT_TASK_ACTIVITY_TYPE, { task: 'review this', outputSchema: schema }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'verdict', type: 'string' },
      { name: 'confidence', type: 'number' },
    ]);
  });

  it('OVERWRITES a stale catalog-default seed ([output, exitCode])', () => {
    const [lowered] = lowerAgentTaskStructuredOutputs([
      node('a', AGENT_TASK_ACTIVITY_TYPE, {
        task: 't',
        outputSchema: schema,
        outputs: [
          { name: 'output', type: 'string' },
          { name: 'exitCode', type: 'number' },
        ],
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'verdict', type: 'string' },
      { name: 'confidence', type: 'number' },
    ]);
  });

  it('leaves a NON-structured agent_task (no outputSchema) untouched — lowerNodeOutputs seeds it', () => {
    const plain = node('a', AGENT_TASK_ACTIVITY_TYPE, { task: 't' });
    const [lowered] = lowerAgentTaskStructuredOutputs([plain]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(plain); // unchanged node returned as-is
  });

  it('leaves a non-agent_task node untouched', () => {
    const llm = node('a', LLM_CALL_ACTIVITY_TYPE, { outputSchema: schema });
    const [lowered] = lowerAgentTaskStructuredOutputs([llm]);
    expect(lowered).toBe(llm);
  });

  it('does NOT lower an INVALID outputSchema (leaves outputs as-is for validateDoc to reject)', () => {
    const bad = node('a', AGENT_TASK_ACTIVITY_TYPE, {
      task: 't',
      outputSchema: { type: 'object', properties: {} }, // empty → invalid subset
    });
    const [lowered] = lowerAgentTaskStructuredOutputs([bad]);
    expect(lowered!.config['outputs']).toBeUndefined();
    expect(lowered).toBe(bad);
  });

  it('composes with lowerNodeOutputs: structured derives, plain gets the catalog default', () => {
    const [structured, plain] = lowerNodeOutputs(
      lowerAgentTaskStructuredOutputs([
        node('s', AGENT_TASK_ACTIVITY_TYPE, { task: 'review', outputSchema: schema }),
        node('p', AGENT_TASK_ACTIVITY_TYPE, { task: 'run' }),
      ]),
    );
    expect(structured!.config['outputs']).toEqual([
      { name: 'verdict', type: 'string' },
      { name: 'confidence', type: 'number' },
    ]);
    // plain agent_task: lowerNodeOutputs seeds the catalog default.
    expect(plain!.config['outputs']).toEqual([
      { name: 'output', type: 'string' },
      { name: 'exitCode', type: 'number' },
    ]);
  });
});

// ===========================================================================
// #2 L12 — `lowerLlmEmitMessages`: the transcript-output opt-in appends a
// `{messages, json}` row to an emitMessages llm_call's contract.
// ===========================================================================

describe('lowerLlmEmitMessages', () => {
  it('appends the messages row to a seeded text-mode contract (runs AFTER lowerNodeOutputs)', () => {
    const [lowered] = lowerLlmEmitMessages(
      lowerNodeOutputs([node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'p', emitMessages: true })]),
    );
    expect(lowered!.config['outputs']).toEqual([
      { name: 'text', type: 'string' },
      { name: 'stopReason', type: 'string' },
      { name: 'messages', type: 'json' },
    ]);
  });

  it('appends to an author-declared contract without touching the existing rows', () => {
    const [lowered] = lowerLlmEmitMessages([
      node('a', LLM_CALL_ACTIVITY_TYPE, {
        prompt: 'p',
        emitMessages: true,
        outputs: [{ name: 'text', type: 'string' }],
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'text', type: 'string' },
      { name: 'messages', type: 'json' },
    ]);
  });

  it('appends to an explicit empty contract (the opt-in IS the author intent)', () => {
    const [lowered] = lowerLlmEmitMessages([
      node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'p', emitMessages: true, outputs: [] }),
    ]);
    expect(lowered!.config['outputs']).toEqual([{ name: 'messages', type: 'json' }]);
  });

  it('leaves a node with an existing `messages` row untouched (whatever its type — save-time reports a conflict)', () => {
    const declared = [{ name: 'messages', type: 'string' }];
    const [lowered] = lowerLlmEmitMessages([
      node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'p', emitMessages: true, outputs: declared }),
    ]);
    expect(lowered!.config['outputs']).toBe(declared);
  });

  it('is a no-op without the flag, with emitMessages:false, and for non-llm nodes', () => {
    const noFlag = node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'p', outputs: [] });
    const offFlag = node('b', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      emitMessages: false,
      outputs: [],
    });
    const other = node('c', 'http_request', { emitMessages: true, outputs: [] });
    const lowered = lowerLlmEmitMessages([noFlag, offFlag, other]);
    expect(lowered[0]).toBe(noFlag);
    expect(lowered[1]).toBe(offFlag);
    expect(lowered[2]).toBe(other);
  });

  it('is a no-op for a structured node (emitMessages+structured is a save-time refusal, never a lowered row)', () => {
    const n = node('a', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      emitMessages: true,
      outputMode: 'structured',
      outputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    const [lowered] = lowerLlmEmitMessages([n]);
    expect(lowered).toBe(n);
  });

  it('is a no-op for a call node and a corrupt (non-array) outputs value', () => {
    const call = {
      ...node('a', LLM_CALL_ACTIVITY_TYPE, { prompt: 'p', emitMessages: true }),
      call: { pipelineVersionId: 'pv', params: {} },
    } as Node;
    const corrupt = node('b', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      emitMessages: true,
      outputs: 'garbage',
    });
    const lowered = lowerLlmEmitMessages([call, corrupt]);
    expect(lowered[0]).toBe(call);
    expect(lowered[1]).toBe(corrupt);
  });
});

describe('lowerLlmEmitMessages — toggle-off heal (#2 L12)', () => {
  it('strips the EXACT machine-lowered row when the flag is turned off (round-trip heal)', () => {
    const [lowered] = lowerLlmEmitMessages([
      node('a', LLM_CALL_ACTIVITY_TYPE, {
        prompt: 'p',
        emitMessages: false,
        outputs: [
          { name: 'text', type: 'string' },
          { name: 'stopReason', type: 'string' },
          { name: 'messages', type: 'json' },
        ],
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([
      { name: 'text', type: 'string' },
      { name: 'stopReason', type: 'string' },
    ]);
  });

  it('strips when the flag key is DELETED too (absent = off)', () => {
    const [lowered] = lowerLlmEmitMessages([
      node('a', LLM_CALL_ACTIVITY_TYPE, {
        prompt: 'p',
        outputs: [{ name: 'messages', type: 'json' }],
      }),
    ]);
    expect(lowered!.config['outputs']).toEqual([]);
  });

  it('does NOT strip an author-DECORATED row (extra keys = hand-written; validator reports it)', () => {
    const decorated = node('a', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      outputs: [{ name: 'messages', type: 'json', optional: true }],
    });
    const [lowered] = lowerLlmEmitMessages([decorated]);
    expect(lowered).toBe(decorated);
  });

  it('does NOT strip a non-json messages row (hand-written; validator reports it)', () => {
    const handWritten = node('a', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      outputs: [{ name: 'messages', type: 'string' }],
    });
    const [lowered] = lowerLlmEmitMessages([handWritten]);
    expect(lowered).toBe(handWritten);
  });

  it('never touches a structured node in either direction (derived rows may legitimately be named messages)', () => {
    const structured = node('a', LLM_CALL_ACTIVITY_TYPE, {
      prompt: 'p',
      outputMode: 'structured',
      outputSchema: { type: 'object', properties: { messages: { type: 'array' } } },
      outputs: [{ name: 'messages', type: 'json' }],
    });
    const [lowered] = lowerLlmEmitMessages([structured]);
    expect(lowered).toBe(structured);
  });
});
