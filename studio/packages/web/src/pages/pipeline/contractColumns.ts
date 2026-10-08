import type { RowTableColumn } from '../../lib/form/RowTable';

/**
 * #1477 OR29 — each declaration kind's table columns, in `ContractRow`'s cell
 * order. Here rather than beside the rows only so the component file exports
 * components alone (fast refresh).
 *
 * Name and Type lead and Description ends every kind; its own columns sit between.
 */
function contractColumns(own: readonly RowTableColumn[]): readonly RowTableColumn[] {
  return [
    { key: 'name', header: 'Name' },
    { key: 'type', header: 'Type', width: 'short' },
    ...own,
    { key: 'description', header: 'Description' },
  ];
}

export const PARAM_COLUMNS = contractColumns([
  { key: 'required', header: 'Required', width: 'check' },
  { key: 'default', header: 'Default' },
]);
export const VARIABLE_COLUMNS = contractColumns([{ key: 'default', header: 'Default' }]);
export const OUTPUT_COLUMNS = contractColumns([
  { key: 'optional', header: 'Optional', width: 'check' },
]);
