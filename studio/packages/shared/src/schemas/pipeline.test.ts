import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION } from './version.js';
import {
  CallConfigSchema,
  ContainerSchema,
  EdgeOnSchema,
  EdgeSchema,
  NewPipelineSchema,
  NewPipelineVersionSchema,
  NodeSchema,
  OutputSchema,
  OutputTypeSchema,
  ParamSchema,
  ParamTypeSchema,
  PipelineSchema,
  PipelineVersionSchema,
  PositionSchema,
} from './pipeline.js';

describe('ParamTypeSchema', () => {
  it.each(['string', 'number', 'boolean', 'json', 'secret'])('accepts %s', (t) => {
    expect(ParamTypeSchema.parse(t)).toBe(t);
  });

  it('rejects an unknown type', () => {
    expect(() => ParamTypeSchema.parse('date')).toThrow();
  });
});

describe('ParamSchema', () => {
  it('round-trips a required param with no default', () => {
    const param = { name: 'topic', type: 'string', required: true };
    expect(ParamSchema.parse(param)).toEqual(param);
  });

  it('round-trips an optional param with a default', () => {
    const param = { name: 'retries', type: 'number', required: false, default: 3 };
    expect(ParamSchema.parse(param)).toEqual(param);
  });

  it('rejects an empty name', () => {
    expect(() => ParamSchema.parse({ name: '', type: 'string', required: true })).toThrow();
  });
});

describe('OutputTypeSchema', () => {
  it.each(['string', 'number', 'boolean', 'json'])('accepts %s', (t) => {
    expect(OutputTypeSchema.parse(t)).toBe(t);
  });

  it('rejects secret (an output is never secret-typed — no leak channel)', () => {
    expect(() => OutputTypeSchema.parse('secret')).toThrow();
  });
});

describe('OutputSchema', () => {
  it('round-trips a valid output', () => {
    const output = { name: 'summary', type: 'string' };
    expect(OutputSchema.parse(output)).toEqual(output);
  });

  it.each(['number', 'boolean', 'json'])('round-trips a %s-typed output', (type) => {
    const output = { name: 'x', type };
    expect(OutputSchema.parse(output)).toEqual(output);
  });

  it('rejects a secret-typed output (outputs are never stripped downstream)', () => {
    expect(() => OutputSchema.parse({ name: 'summary', type: 'secret' })).toThrow();
  });
});

describe('PositionSchema', () => {
  it('round-trips x/y', () => {
    expect(PositionSchema.parse({ x: 10, y: -5.5 })).toEqual({ x: 10, y: -5.5 });
  });

  it('rejects a non-numeric coordinate', () => {
    expect(() => PositionSchema.parse({ x: '10', y: 0 })).toThrow();
  });
});

describe('NodeSchema', () => {
  const node = {
    id: 'node_1',
    type: 'llm_call',
    config: { prompt: 'hi' },
    connectionId: 'conn_1',
    position: { x: 0, y: 0 },
  };

  it('round-trips a node with a connectionId', () => {
    expect(NodeSchema.parse(node)).toEqual(node);
  });

  it('accepts a node without a connectionId', () => {
    const { connectionId, ...rest } = node;
    void connectionId;
    expect(NodeSchema.parse(rest)).toEqual(rest);
  });

  it('rejects a missing position', () => {
    const { position, ...rest } = node;
    void position;
    expect(() => NodeSchema.parse(rest)).toThrow();
  });
});

describe('EdgeOnSchema', () => {
  it.each(['success', 'failure', 'completion'])('accepts %s', (on) => {
    expect(EdgeOnSchema.parse(on)).toBe(on);
  });

  it('rejects an unknown edge condition', () => {
    expect(() => EdgeOnSchema.parse('retry')).toThrow();
  });
});

describe('EdgeSchema', () => {
  it('round-trips a plain forward edge', () => {
    const edge = { id: 'e1', from: 'node_1', to: 'node_2', on: 'success' };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('round-trips a back-edge with a bounce cap', () => {
    const edge = {
      id: 'e2',
      from: 'node_2',
      to: 'node_1',
      on: 'completion',
      back: true,
      maxBounces: 5,
    };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects a negative maxBounces', () => {
    expect(() =>
      EdgeSchema.parse({ id: 'e1', from: 'a', to: 'b', on: 'success', maxBounces: -1 }),
    ).toThrow();
  });
});

describe('ContainerSchema', () => {
  it('round-trips a stage container', () => {
    const c = { id: 'stg', kind: 'stage', children: ['a', 'b'] };
    expect(ContainerSchema.parse(c)).toEqual(c);
  });

  it('round-trips a loop container with exitWhen/maxRounds/join', () => {
    const c = {
      id: 'lp',
      kind: 'loop',
      children: ['w', 'check'],
      exitWhen: '${nodes.check.output.done}',
      maxRounds: 5,
      join: 'all',
    };
    expect(ContainerSchema.parse(c)).toEqual(c);
  });

  it('rejects an unknown kind', () => {
    expect(() => ContainerSchema.parse({ id: 'x', kind: 'fan', children: [] })).toThrow();
  });

  it('rejects a non-positive maxRounds', () => {
    expect(() =>
      ContainerSchema.parse({ id: 'x', kind: 'loop', children: [], maxRounds: 0 }),
    ).toThrow();
  });
});

describe('CallConfigSchema', () => {
  it('round-trips an empty-params call', () => {
    const c = { pipelineVersionId: 'pv_2', params: {} };
    expect(CallConfigSchema.parse(c)).toEqual(c);
  });

  it('round-trips params + wait', () => {
    const c = { pipelineVersionId: '${params.child}', params: { topic: 'x' }, wait: true };
    expect(CallConfigSchema.parse(c)).toEqual(c);
  });

  it('requires params (no implicit default)', () => {
    expect(() => CallConfigSchema.parse({ pipelineVersionId: 'pv_2' })).toThrow();
  });
});

describe('NodeSchema call variant', () => {
  it('round-trips a call_pipeline node with a call config', () => {
    const n = {
      id: 'caller',
      type: 'call_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_2', params: {} },
    };
    expect(NodeSchema.parse(n)).toEqual(n);
  });

  it('a plain node (no call) still parses unchanged (backward-tolerant)', () => {
    const n = { id: 'plain', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };
    expect(NodeSchema.parse(n)).toEqual(n);
    expect(NodeSchema.parse(n)).not.toHaveProperty('call');
  });
});

const pipeline = {
  id: 'pipe_1',
  ownerId: null,
  name: 'My pipeline',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('PipelineSchema', () => {
  it('round-trips a valid pipeline', () => {
    expect(PipelineSchema.parse(pipeline)).toEqual(pipeline);
  });

  it('rejects an empty name', () => {
    expect(() => PipelineSchema.parse({ ...pipeline, name: '' })).toThrow();
  });
});

describe('NewPipelineSchema', () => {
  it('accepts a payload without server-set fields', () => {
    const { id, createdAt, updatedAt, ...insert } = pipeline;
    void id;
    void createdAt;
    void updatedAt;
    expect(NewPipelineSchema.parse(insert)).toEqual(insert);
  });
});

const pipelineVersion = {
  id: 'pv_1',
  pipelineId: 'pipe_1',
  version: 1,
  params: [{ name: 'topic', type: 'string', required: true }],
  outputs: [{ name: 'summary', type: 'string' }],
  nodes: [
    {
      id: 'node_1',
      type: 'llm_call',
      config: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  containers: [],
  catalogVersion: CATALOG_VERSION,
  createdAt: 1700000000000,
};

describe('PipelineVersionSchema', () => {
  it('round-trips a valid pipeline version', () => {
    expect(PipelineVersionSchema.parse(pipelineVersion)).toEqual(pipelineVersion);
  });

  it('rejects version 0 (must be positive)', () => {
    expect(() => PipelineVersionSchema.parse({ ...pipelineVersion, version: 0 })).toThrow();
  });

  it('rejects a malformed node inside nodes[]', () => {
    expect(() =>
      PipelineVersionSchema.parse({
        ...pipelineVersion,
        nodes: [{ id: 'bad' }],
      }),
    ).toThrow();
  });

  it('defaults containers to [] when the key is absent (backward-tolerant)', () => {
    const { containers, ...withoutContainers } = pipelineVersion;
    void containers;
    const parsed = PipelineVersionSchema.parse(withoutContainers);
    expect(parsed.containers).toEqual([]);
  });
});

describe('NewPipelineVersionSchema', () => {
  it('accepts a payload without id/version/createdAt and defaults catalogVersion', () => {
    const { id, version, createdAt, ...rest } = pipelineVersion;
    void id;
    void version;
    void createdAt;
    const { catalogVersion, ...withoutCatalogVersion } = rest;
    void catalogVersion;
    const parsed = NewPipelineVersionSchema.parse(withoutCatalogVersion);
    expect(parsed.catalogVersion).toBe(CATALOG_VERSION);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('version');
  });
});
