import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getActivity, type ConnectionKind } from '@autonomy-studio/shared';
import { BASE_NODES, benchFile, benchPath, openBench, type Bench } from '../bench.js';
import { dynamicFields } from '../dynamic-fields.js';

/**
 * #1574 OR39 — the ACTIVITY × DYNAMIC FIELD matrix.
 *
 * For every field the derivation calls dynamic (`dynamic-fields.ts`), one real
 * run with that field set to `${params.v}` and `v` given at Run. The cell reads
 * the input the node was DISPATCHED with (`node.dispatched.input`, what the run
 * monitor shows as the activity's Input) and proves the field arrived resolved:
 * the value, not the template.
 *
 * `DYNAMIC_VALUES` names the value each field is run with. It is keyed by the
 * derived set and the guard compares the two, so a field that becomes dynamic
 * needs a deliberate value here before the suite goes green.
 *
 * Cell ids are `dynamic/<activity>.<field>`; `adf-parity.ts` links to them.
 */

type Value = string | ((b: Bench) => string);

interface FieldCell {
  /** What `v` resolves to: a value the field accepts. */
  readonly value: Value;
  /** Config the field needs beside it to save (a field that applies only with another). */
  readonly with?: (b: Bench) => Record<string, unknown>;
}

const AT = '2020-01-02T03:04:05Z';

/**
 * An `llm_call` records its dispatched input only under `capture: 'full'`: its
 * input IS the prompt, and the default promises no prompt text (`executor.ts`).
 */
const fullCapture = (): Record<string, unknown> => ({ capture: 'full' });
const folder = (b: Bench): string => benchPath(b, 'd');

export const DYNAMIC_VALUES: Record<string, FieldCell> = {
  'agent_task.cwd': { value: (b) => b.fsRoot },
  'agent_task.task': { value: 'do the dynamic thing' },
  'copy.load': { value: 'full' },
  'copy.logFolder': { value: folder },
  'copy.logLevel': { value: 'warning' },
  'copy.logMode': { value: 'reliable' },
  'copy.logTo': { value: 'run' },
  'copy.mode': { value: 'overwrite' },
  'copy.partitionOption': { value: 'none' },
  'copy.tableOption': { value: 'none' },
  'copy.watermarkFrom': { value: 'automatic' },
  'copy.watermarkOld': { value: '2020-01-01' },
  'copy_files.afterCopy': { value: 'keep' },
  'copy_files.copyBehavior': { value: 'flatten' },
  'copy_files.fileListPath': { value: (b) => benchFile(b, '') },
  'copy_files.ifExists': { value: 'skip' },
  'copy_files.logFolder': { value: folder },
  'copy_files.logLevel': { value: 'warning' },
  'copy_files.logMode': { value: 'reliable' },
  'copy_files.logTo': { value: 'run' },
  'copy_files.modifiedEnd': { value: AT },
  'copy_files.modifiedStart': { value: AT },
  'copy_files.moveTo': { value: folder },
  'copy_files.pathType': { value: 'file' },
  'copy_files.sinkFileName': { value: 'renamed.txt' },
  'copy_files.sinkFolder': { value: folder },
  'copy_files.sourcePath': { value: (b) => benchFile(b) },
  'copy_files.wildcard': { value: '*.txt' },
  'delete.logFolder': { value: folder },
  'delete.logLevel': { value: 'warning' },
  'delete.logTo': { value: 'run' },
  'delete.modifiedEnd': { value: AT },
  'delete.modifiedStart': { value: AT },
  'delete.path': { value: (b) => benchFile(b) },
  'delete.pathType': { value: 'file' },
  'delete.wildcard': { value: '*.txt' },
  'file_copy.dest': { value: (b) => benchPath(b) },
  'file_copy.source': { value: (b) => benchFile(b) },
  'file_delete.path': { value: (b) => benchFile(b) },
  'file_list.path': { value: (b) => b.fsRoot },
  'file_move.dest': { value: (b) => benchPath(b) },
  'file_move.source': { value: (b) => benchFile(b) },
  'file_read.overLimit': { value: 'fail' },
  'file_read.path': { value: (b) => benchFile(b, 'dynamic') },
  'file_write.content': { value: 'dynamic content' },
  'file_write.path': { value: (b) => benchPath(b) },
  'get_metadata.childFilter': { value: '*.txt' },
  'get_metadata.childType': { value: 'files' },
  'get_metadata.modifiedEnd': { value: AT },
  'get_metadata.modifiedStart': { value: AT },
  'get_metadata.path': { value: (b) => b.fsRoot },
  'get_metadata.waitUntil': { value: 'exists' },
  'http_request.body': { value: 'dynamic body' },
  'http_request.method': { value: 'PUT' },
  'http_request.url': { value: (b) => `${b.server.url}/dynamic` },
  'llm_call.capture': { value: 'full' },
  'llm_call.model': { value: 'dynamic-model', with: fullCapture },
  'llm_call.prompt': { value: 'dynamic prompt', with: fullCapture },
  'llm_call.reasoningEffort': { value: 'low', with: fullCapture },
  'llm_call.system': { value: 'dynamic system', with: fullCapture },
  'lookup.overLimit': { value: 'fail' },
  'script.captureResultSets': { value: 'firstRows' },
  'web.body': { value: 'dynamic body' },
  'web.method': { value: 'PUT' },
  'web.parseAs': { value: 'text' },
  'web.url': { value: (b) => `${b.server.url}/dynamic` },
  'web.whenOverLimit': { value: 'truncate' },
};

/**
 * Text fields the save gate keeps LITERAL by a rule of its own rather than by
 * the `literalText` tag, so the schema derivation counts them dynamic. Each
 * cell pins the refusal and its reason; the dynamic-field ticket decides
 * whether they become dynamic (and then they move to `DYNAMIC_VALUES`).
 */
export const LITERAL_BY_RULE: Record<string, RegExp> = {
  // It decides which other fields apply, so it cannot wait for run time.
  'copy_files.load': /Load stays literal/,
  // `validateDoc`'s hand-written llm_call rules read the raw value.
  'llm_call.outputMode': /outputMode: Invalid option/,
  'llm_call.toolChoice': /toolChoice: Invalid option/,
};

/** The kind each activity's cells run on: its first, never postgres (fs/sqlite carry no secret). */
function kindFor(activity: string): ConnectionKind {
  const kinds = getActivity(activity)?.connectionKinds ?? [];
  const kind = kinds.find((k) => k !== 'postgres');
  if (kind === undefined) throw new Error(`${activity} binds no connection the bench runs`);
  return kind;
}

describe('every dynamic field has a cell', () => {
  it('names a run value (or a pinned refusal) for every derived dynamic field, and none stale', () => {
    const covered = [...Object.keys(DYNAMIC_VALUES), ...Object.keys(LITERAL_BY_RULE)];
    expect(covered.sort()).toEqual(dynamicFields());
    expect(new Set(covered).size).toBe(covered.length);
  });
});

let bench: Bench;
beforeAll(async () => {
  bench = await openBench();
});
afterAll(async () => {
  await bench?.close();
});

const nodeWithExpression = async (activity: string, field: string, extra = {}) => {
  const node = await BASE_NODES[activity]!(bench, kindFor(activity));
  return {
    ...node,
    config: { ...(node['config'] as Record<string, unknown>), ...extra, [field]: '${params.v}' },
  };
};
const V_PARAM = [{ name: 'v', type: 'string', required: true }];

describe.each(Object.keys(LITERAL_BY_RULE).sort())('dynamic/%s', (id) => {
  const [activity, field] = id.split('.') as [string, string];
  it(`dynamic/${id} — the save gate keeps it literal, saying why`, async () => {
    const save = bench.h.createPipeline({
      params: V_PARAM,
      nodes: [await nodeWithExpression(activity, field)],
    });
    await expect(save).rejects.toThrow(LITERAL_BY_RULE[id]!);
  });
});

describe.each(Object.keys(DYNAMIC_VALUES).sort())('dynamic/%s', (id) => {
  const [activity, field] = id.split('.') as [string, string];

  it(`dynamic/${id} — the resolved value reaches the adapter`, async () => {
    const cell = DYNAMIC_VALUES[id];
    if (cell === undefined) throw new Error(`no DYNAMIC_VALUES entry for ${id}`);
    const value = typeof cell.value === 'function' ? cell.value(bench) : cell.value;
    const node = await nodeWithExpression(activity, field, cell.with?.(bench));
    const result = await bench.h.runDoc({ params: V_PARAM, nodes: [node] }, { v: value });
    const dispatched = result.dispatched.get('n');
    expect(dispatched, `run ${result.runId} never dispatched n: ${result.status}`).toBeDefined();
    expect(dispatched![0]![field], JSON.stringify(dispatched![0])).toBe(value);
  });
});
