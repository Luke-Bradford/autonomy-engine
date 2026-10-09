import {
  APPEND_VARIABLE_ACTIVITY_TYPE,
  SET_VARIABLE_ACTIVITY_TYPE,
  type VariableDef,
} from '@autonomy-studio/shared';

/** What a variable writer's `variable` chooser offers (#844 V6, spec V-D9). */
export interface VariableWriteChoices {
  readonly values: readonly string[];
  readonly describe: (name: string) => string;
  /** Only read when `values` is empty; says which of the two empty cases it is. */
  readonly emptyHint: string;
}

/**
 * The declared variables a `set_variable`/`append_variable` node may write, or
 * `undefined` for any other activity.
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
  variables: readonly VariableDef[],
): VariableWriteChoices | undefined {
  const isAppend = nodeType === APPEND_VARIABLE_ACTIVITY_TYPE;
  if (!isAppend && nodeType !== SET_VARIABLE_ACTIVITY_TYPE) return undefined;
  const eligible = isAppend ? variables.filter((v) => v.type === 'array') : variables;
  const types = new Map(eligible.map((v) => [v.name, v.type]));
  return {
    values: eligible.map((v) => v.name),
    describe: (name) => `${name} (${types.get(name) ?? 'undeclared'})`,
    // Two different repairs, so two different sentences: telling an author with
    // three string variables to "declare one" would send them to a tab that
    // already has what they think the chooser wants. Each fits one line of the
    // dock's control column (#1477 OR29: a second line pushed Value off a
    // 1280×720 screen).
    emptyHint:
      variables.length === 0
        ? 'No variables are declared. Add one on the Variables tab.'
        : 'No array variables. Add one on the Variables tab.',
  };
}
