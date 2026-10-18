import { isVariableWriterType, variableWriteOp, type VariableDef } from '@autonomy-studio/shared';

/** What a variable writer's `variable` chooser offers (#844 V6, spec V-D9). */
export interface VariableWriteChoices {
  readonly values: readonly string[];
  readonly describe: (name: string) => string;
  /** Only read when `values` is empty; says which of the two empty cases it is. */
  readonly emptyHint: string;
}

/**
 * The declared variables a variable writer may write, or `undefined` for any
 * other activity. #1600 C12a — a Set variable follows its `operation` as the dock
 * draft holds it: empty is the schema default, Set, and a value the save refuses
 * is read as Set too, since the node's own issue says what is wrong with it.
 *
 * An append is offered only the `array` variables, because the save gate
 * refuses any other (`validateVariableWriteConfig`), and a chooser offering a
 * name the save then refuses is a false offer. Declaration order, which is the
 * order of the Variables tab the author declared them in.
 *
 * Each is described with its type: for a `set`, the type decides how a literal
 * `value` is read (`5` is a number only for a `number` variable, V-D4).
 */
export function variableWriteChoices(
  nodeType: string,
  operation: unknown,
  variables: readonly VariableDef[],
): VariableWriteChoices | undefined {
  if (!isVariableWriterType(nodeType)) return undefined;
  const config = operation === undefined || operation === '' ? {} : { operation };
  const isAppend = variableWriteOp({ type: nodeType, config }) === 'append';
  const eligible = isAppend ? variables.filter((v) => v.type === 'array') : variables;
  const types = new Map(eligible.map((v) => [v.name, v.type]));
  return {
    values: eligible.map((v) => v.name),
    describe: (name) => `${name} (${types.get(name) ?? 'undeclared'})`,
    // Two different states, so two different lines: telling an author with
    // three string variables "no variables" would send them to a tab that
    // already has what they think the chooser wants. #1694 OR42 item 4 — a
    // state, not a paragraph; where to declare one is the field's `?`.
    emptyHint: variables.length === 0 ? 'No variables declared' : 'No array variables',
  };
}
