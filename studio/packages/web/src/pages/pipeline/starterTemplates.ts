import {
  COPY_ACTIVITY_TYPE,
  FAIL_ACTIVITY_TYPE,
  FILE_LIST_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  FILTER_ACTIVITY_TYPE,
  HTTP_REQUEST_ACTIVITY_TYPE,
  IF_ACTIVITY_TYPE,
  LLM_CALL_ACTIVITY_TYPE,
  type Container,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';

/**
 * #1413 OR22 / #1420 part 4 — the starter templates an EMPTY canvas offers.
 *
 * A template is a skeleton, not a finished pipeline. It carries the shape and
 * the `${}` wiring between the steps, which is the part a newcomer cannot guess,
 * and leaves out everything that belongs to the operator's own workspace:
 * connections, datasets, folder paths, URLs and the column mapping. The editor's
 * required fields and the Problems list then say what is still to be bound.
 *
 * The CSV one is a SAVE-blocked skeleton until a dataset is bound, and that is
 * deliberate: its Copy carries the per-item `datasetParams.source.path`, which
 * the save gate refuses without `datasetIds` ("bind a dataset or remove them").
 * That message is exactly the next step, and dropping the override to make the
 * template save would drop the one line of the recipe that does the work.
 *
 * Inserted through `insertTemplate`, which lowers the nodes (seeding the
 * declared output contracts the reference checks need) and gives every node
 * and container a fresh id, remapping the `${nodes.<id>}` references to match.
 * The readable ids below therefore never reach a saved document; they exist so
 * the wiring reads plainly here, and so `e2e/foreach-copy-folder.spec.ts` can
 * bind the CSV template by id and prove it runs.
 *
 * No positions worth the name: `insertTemplate` lays a template out with
 * Arrange itself (`arrangeMoves`), so a ForEach box can never overlap the step
 * before it and Arrange is a no-op on a fresh template. This module is pure data
 * over `@autonomy-studio/shared` for the same reason — the e2e imports it into
 * Node, where the canvas's layout code (React Flow) has no business loading.
 */
export interface StarterTemplate {
  id: string;
  title: string;
  /** One sentence: what the pipeline does, and what the operator still binds. */
  description: string;
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
}

/**
 * The `List directory → Filter` head two templates share. The filter drops the
 * folder's sub-directories, and whatever `keep` adds on top: a directory handed
 * to a read or a copy fails the run rather than being skipped.
 */
function listFilesHead(keep = "equals(item.type, 'file')"): Node[] {
  return [
    { id: 'list', type: FILE_LIST_ACTIVITY_TYPE, position: { x: 0, y: 0 }, config: {} },
    {
      id: 'files',
      type: FILTER_ACTIVITY_TYPE,
      position: { x: 0, y: 0 },
      config: { items: '${nodes.list.output.entries}', predicate: `\${${keep}}` },
    },
  ];
}

const PER_ITEM_PATH = "${concat(nodes.list.output.path, '/', item.name)}";

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'csv-folder-to-table',
    title: 'Load every CSV in a folder into a table',
    description:
      'List a folder, keep its CSV files, and copy each into a table through a CSV dataset that declares path as a parameter.',
    nodes: [
      ...listFilesHead("and(equals(item.type, 'file'), endsWith(item.name, '.csv'))"),
      {
        id: 'load',
        type: COPY_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        datasetParams: { source: { path: PER_ITEM_PATH } },
        config: { mode: 'append' },
      },
    ],
    edges: [
      { id: 'e1', from: 'list', to: 'files', on: 'success' },
      { id: 'e2', from: 'files', to: 'each', on: 'success' },
    ],
    containers: [
      { id: 'each', kind: 'foreach', children: ['load'], items: '${nodes.files.output.result}' },
    ],
  },
  {
    id: 'summarise-folder',
    title: 'Summarise every document in a folder',
    description:
      'List a folder, keep the files, then read each one as text and ask a language model to summarise it.',
    nodes: [
      ...listFilesHead(),
      {
        id: 'read',
        type: FILE_READ_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        config: { path: PER_ITEM_PATH },
      },
      {
        id: 'summarise',
        type: LLM_CALL_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        config: {
          prompt: 'Summarise this document in three sentences.\n\n${nodes.read.output.content}',
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'list', to: 'files', on: 'success' },
      { id: 'e2', from: 'files', to: 'each', on: 'success' },
      { id: 'e3', from: 'read', to: 'summarise', on: 'success' },
    ],
    containers: [
      {
        id: 'each',
        kind: 'foreach',
        children: ['read', 'summarise'],
        items: '${nodes.files.output.result}',
      },
    ],
  },
  {
    id: 'call-api-check',
    title: 'Call an API and stop on an error response',
    description:
      'Send an HTTP request and fail the run with the status when the answer is an error (400 or above).',
    nodes: [
      {
        id: 'call',
        type: HTTP_REQUEST_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        config: { method: 'GET' },
      },
      {
        id: 'check',
        type: IF_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        config: { condition: '${greaterOrEquals(nodes.call.output.status, 400)}' },
      },
      {
        id: 'stop',
        type: FAIL_ACTIVITY_TYPE,
        position: { x: 0, y: 0 },
        config: { message: 'The API answered with status ${nodes.call.output.status}.' },
      },
    ],
    edges: [
      { id: 'e1', from: 'call', to: 'check', on: 'success' },
      { id: 'e2', from: 'check', to: 'stop', on: 'branch', branch: 'true' },
    ],
    containers: [],
  },
];
