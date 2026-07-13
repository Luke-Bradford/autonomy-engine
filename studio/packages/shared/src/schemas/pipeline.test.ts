import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION } from './version.js';
import {
  EdgeOnSchema,
  EdgeSchema,
  NewPipelineSchema,
  NewPipelineVersionSchema,
  NodeSchema,
  OutputSchema,
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

describe('OutputSchema', () => {
  it('round-trips a valid output', () => {
    const output = { name: 'summary', type: 'string' };
    expect(OutputSchema.parse(output)).toEqual(output);
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
