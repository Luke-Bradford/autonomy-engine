import { requiredConnectorCells } from './connector-cells.js';
import { copyEndpoints } from './copy-endpoints.js';
import { dynamicFields } from './dynamic-fields.js';

/**
 * #1574 OR39 — every matrix cell id, in one place, for the ADF parity doc to
 * link against. Each set is the one its suite's guard pins its own table to, so
 * an id listed here is a cell that runs.
 *
 * Kept out of the `.test.ts` files on purpose: importing a test file from
 * another re-registers its suites in the importer (`live-postgres.ts` records
 * the scar).
 */

/** `control-flow-matrix.test.ts`'s cells; its guard pins `CONTROL_CELLS` to this list. */
export const CONTROL_CELL_NAMES = [
  'if-true',
  'if-false',
  'switch',
  'switch-default',
  'foreach-sequential',
  'foreach-parallel',
  'until',
  'execute-pipeline-wait',
  'execute-pipeline-no-wait',
  'fail',
  'retry',
  'timeout',
  'skip-propagation',
  'set-variable',
  'append-variable',
  'filter',
  'wait',
  'webhook',
  'inactive',
  'foreach>if',
  'foreach-parallel>execute-pipeline',
  'if>execute-pipeline>foreach',
  'until>switch',
  'foreach>fail',
] as const;

/** The suite file each cell family lives in, from `studio/docs/`. */
export const CELL_FILES = {
  connector: '../packages/server/src/conformance/__tests__/connector-matrix.test.ts',
  copy: '../packages/server/src/conformance/__tests__/copy-matrix.test.ts',
  dynamic: '../packages/server/src/conformance/__tests__/dynamic-field-matrix.test.ts',
  control: '../packages/server/src/conformance/__tests__/control-flow-matrix.test.ts',
} as const;

export function copyCellIds(): string[] {
  const { sources, sinks } = copyEndpoints();
  return [
    ...sources.flatMap((s) => sinks.map((t) => `copy/${s}→${t}`)),
    ...sinks.map((t) => `copy/parallel→${t}`),
  ];
}

/** Every cell id, with the file it runs in. */
export function allCellIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const id of requiredConnectorCells()) ids.set(id, CELL_FILES.connector);
  for (const id of copyCellIds()) ids.set(id, CELL_FILES.copy);
  for (const f of dynamicFields()) ids.set(`dynamic/${f}`, CELL_FILES.dynamic);
  for (const name of CONTROL_CELL_NAMES) ids.set(`control/${name}`, CELL_FILES.control);
  return ids;
}
