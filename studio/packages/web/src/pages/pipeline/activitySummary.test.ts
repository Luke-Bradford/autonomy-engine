import { describe, expect, it } from 'vitest';
import {
  AGENT_TASK_ACTIVITY_TYPE,
  APPEND_VARIABLE_ACTIVITY_TYPE,
  catalog,
  COPY_ACTIVITY_TYPE,
  EXECUTE_PIPELINE_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_COPY_ACTIVITY_TYPE,
  FILE_DELETE_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_MOVE_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILE_WRITE_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  SET_VARIABLE_ACTIVITY_TYPE,
  SWITCH_ACTIVITY_TYPE,
  WAIT_ACTIVITY_TYPE,
  WEBHOOK_ACTIVITY_TYPE,
  type Node,
} from '@autonomy-studio/shared';
import { activityBadges, activitySummary } from './activitySummary';

function node(type: string, fields: Partial<Node> = {}): Node {
  return { id: 'n', type, config: {}, position: { x: 0, y: 0 }, ...fields };
}

const NAMES = new Map([
  ['ds_src', 'orders.csv'],
  ['ds_sink', 'orders table'],
]);

/**
 * One configured node per catalog type, and the line its card shows. Keyed by
 * type so the test below can hold this list to the catalog: a new activity type
 * with no summary fails here rather than drawing a blank card.
 */
const CASES: Record<string, [Node, string]> = {
  http_request: [
    node('http_request', {
      config: { url: 'https://api.example.com/v1/orders?token=abc#top', method: 'post' },
    }),
    'POST api.example.com/v1/orders',
  ],
  [LLM_CALL_ACTIVITY_TYPE]: [
    node(LLM_CALL_ACTIVITY_TYPE, {
      config: { prompt: 'hi', model: 'claude-opus-5-5', outputMode: 'structured' },
    }),
    'claude-opus-5-5 · structured',
  ],
  [AGENT_TASK_ACTIVITY_TYPE]: [
    node(AGENT_TASK_ACTIVITY_TYPE, { config: { task: 'Fix the build\nthen push' } }),
    'Fix the build',
  ],
  [IF_ACTIVITY_TYPE]: [
    node(IF_ACTIVITY_TYPE, { config: { condition: '${equals(params.env, "prod")}' } }),
    'if ${equals(params.env, "prod")}',
  ],
  [SWITCH_ACTIVITY_TYPE]: [
    node(SWITCH_ACTIVITY_TYPE, { config: { on: '${params.region}', cases: ['eu', 'us'] } }),
    'on ${params.region} · 2 cases',
  ],
  [FAIL_ACTIVITY_TYPE]: [node(FAIL_ACTIVITY_TYPE, { config: { message: 'no rows' } }), 'no rows'],
  [SET_VARIABLE_ACTIVITY_TYPE]: [
    node(SET_VARIABLE_ACTIVITY_TYPE, { config: { variable: 'count', value: 3 } }),
    'count = 3',
  ],
  [APPEND_VARIABLE_ACTIVITY_TYPE]: [
    node(APPEND_VARIABLE_ACTIVITY_TYPE, { config: { variable: 'seen', value: '${item}' } }),
    'seen += ${item}',
  ],
  [FILTER_ACTIVITY_TYPE]: [
    node(FILTER_ACTIVITY_TYPE, {
      config: { items: '${nodes.list.output.entries}', predicate: "${equals(item.type, 'file')}" },
    }),
    "${nodes.list.output.entries} where ${equals(item.type, 'file')}",
  ],
  [WAIT_ACTIVITY_TYPE]: [node(WAIT_ACTIVITY_TYPE, { config: { seconds: '${30}' } }), 'wait 30s'],
  [WEBHOOK_ACTIVITY_TYPE]: [
    node(WEBHOOK_ACTIVITY_TYPE, { config: { timeoutSeconds: '${3600}' } }),
    'callback · timeout 1h 00m',
  ],
  [EXECUTE_PIPELINE_ACTIVITY_TYPE]: [
    node(EXECUTE_PIPELINE_ACTIVITY_TYPE, {
      call: { pipelineVersionId: 'v1', params: {}, wait: false },
    }),
    'starts a pipeline',
  ],
  [FILE_READ_ACTIVITY_TYPE]: [
    node(FILE_READ_ACTIVITY_TYPE, { config: { path: 'in/a.csv' } }),
    'in/a.csv',
  ],
  [FILE_WRITE_ACTIVITY_TYPE]: [
    node(FILE_WRITE_ACTIVITY_TYPE, { config: { path: 'out/b.txt', content: 'x' } }),
    '→ out/b.txt',
  ],
  [FILE_COPY_ACTIVITY_TYPE]: [
    node(FILE_COPY_ACTIVITY_TYPE, { config: { source: 'in/a.csv', dest: 'archive/a.csv' } }),
    'in/a.csv → archive/a.csv',
  ],
  [FILE_MOVE_ACTIVITY_TYPE]: [
    node(FILE_MOVE_ACTIVITY_TYPE, { config: { source: 'in/a.csv', dest: 'done/a.csv' } }),
    'in/a.csv → done/a.csv',
  ],
  [FILE_DELETE_ACTIVITY_TYPE]: [
    node(FILE_DELETE_ACTIVITY_TYPE, { config: { path: 'tmp/x' } }),
    'delete tmp/x',
  ],
  [FILE_LIST_ACTIVITY_TYPE]: [node(FILE_LIST_ACTIVITY_TYPE, { config: { path: 'in' } }), 'in'],
  [COPY_ACTIVITY_TYPE]: [
    node(COPY_ACTIVITY_TYPE, {
      config: { mode: 'overwrite' },
      datasetIds: { source: 'ds_src', sink: 'ds_sink' },
    }),
    'orders.csv → orders table · overwrite',
  ],
  [LOOKUP_ACTIVITY_TYPE]: [
    node(LOOKUP_ACTIVITY_TYPE, { datasetIds: { source: 'ds_src' } }),
    'from orders.csv',
  ],
};

describe('activitySummary', () => {
  it('has a case for every catalog type', () => {
    expect(Object.keys(CASES).sort()).toEqual([...catalog.keys()].sort());
  });

  for (const [type, [n, expected]] of Object.entries(CASES)) {
    it(`summarises ${type}`, () => {
      expect(activitySummary(n, (id) => NAMES.get(id))).toBe(expected);
    });
  }

  it('gives no line for an unconfigured node of any catalog type', () => {
    for (const type of catalog.keys()) {
      expect(
        activitySummary(node(type), () => undefined),
        type,
      ).toBeNull();
    }
  });

  it('gives no line for a type the catalog does not know', () => {
    expect(activitySummary(node('custom_thing', { config: { path: 'x' } }), () => undefined)).toBe(
      null,
    );
  });

  it('reads a spaced literal as a duration, and a bare number as written', () => {
    const spaced = node(WAIT_ACTIVITY_TYPE, { config: { seconds: '${ 90 }' } });
    expect(activitySummary(spaced, () => undefined)).toBe('wait 1m 30s');
    // Not a `${}` expression, so the save gate refuses it — never read as 30s.
    const bare = node(WAIT_ACTIVITY_TYPE, { config: { seconds: '30' } });
    expect(activitySummary(bare, () => undefined)).toBe('wait 30');
  });

  it('shows an expression as written when a duration is not a number', () => {
    const n = node(WAIT_ACTIVITY_TYPE, { config: { seconds: '${params.delay}' } });
    expect(activitySummary(n, () => undefined)).toBe('wait ${params.delay}');
  });

  it('never shows credentials written into a URL', () => {
    const n = node('http_request', { config: { url: 'https://user:tok@api.example.com/v1?k=1' } });
    expect(activitySummary(n, () => undefined)).toBe('GET api.example.com/v1');
    // An `@` in the query is not userinfo: the host survives.
    const q = node('http_request', { config: { url: 'https://host?email=a@b' } });
    expect(activitySummary(q, () => undefined)).toBe('GET host');
  });

  it('shows a dataset reference as written, and an empty value as ""', () => {
    const copy = node(COPY_ACTIVITY_TYPE, {
      datasetIds: { source: 'ds_src', sink: '${params.sink}' },
    });
    expect(activitySummary(copy, (id) => NAMES.get(id))).toBe('orders.csv → ${params.sink}');
    const set = node(SET_VARIABLE_ACTIVITY_TYPE, { config: { variable: 'v', value: '' } });
    expect(activitySummary(set, () => undefined)).toBe('v = ""');
  });

  it('defaults an http method to GET', () => {
    const n = node('http_request', { config: { url: 'http://h/p' } });
    expect(activitySummary(n, () => undefined)).toBe('GET h/p');
  });

  it('says "a dataset" for a dataset the workspace no longer lists, never its raw id', () => {
    const n = node(COPY_ACTIVITY_TYPE, { datasetIds: { source: 'gone', sink: 'ds_sink' } });
    expect(activitySummary(n, (id) => NAMES.get(id))).toBe('a dataset → orders table');
  });

  it('names a structural call node by whether it waits', () => {
    const n = node('call_pipeline', { call: { pipelineVersionId: 'v', params: {}, wait: true } });
    expect(activitySummary(n, () => undefined)).toBe('runs a pipeline and waits');
  });
});

describe('activityBadges', () => {
  it('lists retry, timeout and secure from the policy', () => {
    const n = node('http_request', {
      policy: { retry: 2, timeoutSeconds: 300, secureOutput: true },
    });
    expect(activityBadges(n)).toEqual([
      { key: 'retry', text: '↻ 2', label: 'Retries up to 2 times' },
      { key: 'timeout', text: '⏱ 5m 00s', label: 'Times out after 5m 00s' },
      { key: 'secure', text: 'secure', label: 'Secure output' },
    ]);
  });

  it('says which side is secure when both are', () => {
    const n = node('http_request', { policy: { secureInput: true, secureOutput: true } });
    expect(activityBadges(n)).toEqual([
      { key: 'secure', text: 'secure', label: 'Secure input and output' },
    ]);
  });

  it('shows no badge for retry 0 or an absent policy', () => {
    expect(activityBadges(node('http_request', { policy: { retry: 0 } }))).toEqual([]);
    expect(activityBadges(node('http_request'))).toEqual([]);
  });
});
