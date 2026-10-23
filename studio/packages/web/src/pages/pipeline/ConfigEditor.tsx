import { Fragment, useId, type ReactNode } from 'react';
import { ConfigFieldControl, type FieldChoices, type FieldPicker } from './ConfigFieldControl';
import { emptyControlValue, fieldSpan, type ConfigField, type FieldInput } from './configForm';
import type { ConfigEditorState } from './useConfigEditor';
import { LabelledControl } from '../../lib/LabelledControl';
import { FieldError } from '../../lib/form/FieldError';
import { JsonEditor } from '../../lib/form/JsonEditor';
import { fieldAttrs } from '../../lib/form/fieldValidation';
import { FieldCell, FieldGrid } from '../../lib/form/FieldGrid';

/**
 * The Config group a resource form or a canvas node embeds (#1146, #1088) — the
 * view half of `useConfigEditor`. The mode toggle, the unrenderable advisory, the textarea or
 * the controls, the carried advisory, and the page's own incomplete-config
 * advisory (each resource judges completeness differently, so it arrives as a
 * string).
 */
export function ConfigEditor<K extends string>({
  editor,
  kindLabel,
  className,
  maxRows,
  advisory,
  choicesFor,
  optionsFor,
  picker,
  emptyHint = 'This kind has no settings.',
  fieldModeExtra,
  fieldActions,
  fieldBefore,
  fieldControl,
  errorFor,
  fieldNames,
  toolbar = true,
  children,
}: {
  editor: ConfigEditorState<K>;
  /**
   * #1436 — what the page CALLS `editor.kind` ("Database table", an activity's
   * title), for the sentences below. The identifier is not display copy.
   */
  kindLabel: string;
  className: string;
  /** The most lines the JSON view shows; below that it is as tall as its config. */
  maxRows: number;
  advisory: string | null;
  choicesFor?: (fieldName: string) => FieldChoices | undefined;
  /**
   * #1600 OR41 C8c — the choices to DRAW for an enum-set field, when fewer than
   * its schema's (Get metadata's field list on the bound connection's kind).
   * Display only: the editor still parses and writes against every choice.
   */
  optionsFor?: (field: ConfigField) => readonly string[] | undefined;
  /** The canvas's expression picker (U8a) — a resource form has no graph to pick from. */
  picker?: FieldPicker;
  /** Shown when the kind declares no fields at all. */
  emptyHint?: string;
  /** Rendered only with the controls, before the carried advisory. */
  fieldModeExtra?: ReactNode;
  /** #1694 OR42 — a field's extra acts, in its row list's toolbar (`ConfigFieldControl`'s `actions`). */
  fieldActions?: (fieldName: string) => ReactNode;
  /**
   * #1600 OR41 C6c-1a — a control drawn just before a field, in its own cell,
   * and only while that field is: Copy's log connection, before *Log folder*.
   */
  fieldBefore?: (fieldName: string) => ReactNode;
  /**
   * #1600 OR41 C10c — a field's own editor in place of its generic control,
   * or `undefined` for the generic one: a Script's blocks. It edits the same
   * control value, so Apply and the JSON view are unchanged. It takes no
   * `errorFor` validation: only the canvas passes it, and the canvas has none.
   */
  fieldControl?: (
    field: ConfigField,
    value: FieldInput,
    onChange: (next: FieldInput) => void,
  ) => ReactNode;
  /**
   * #1396 — a resource form's inline validation: each control is keyed
   * `config.<name>` and the JSON textarea `config`, and shows its error. The
   * canvas passes none.
   */
  errorFor?: (key: string) => string | undefined;
  /**
   * #1477 OR29 — show only these fields, in this order (a node's tab). Display
   * only: the editor still READS every field, so Apply writes what the other
   * tabs hold too. Omitted: every field, in the schema's order.
   */
  fieldNames?: readonly string[];
  /**
   * #1477 — the "Config" title and the fields/JSON toggle. A canvas node draws
   * the toggle in its panel header instead, once for all its tabs.
   */
  toolbar?: boolean;
  /** Rendered last inside the group, in both modes. */
  children?: ReactNode;
}) {
  const { jsonMode, unrenderable, carried } = editor;
  const fields =
    fieldNames === undefined
      ? editor.fields
      : fieldNames.flatMap((name) => editor.fields.filter((f) => f.name === name));
  const jsonErrorId = useId();
  const jsonError = errorFor?.('config');
  return (
    <FieldGrid className={className} label="Config">
      {toolbar && (
        <div>
          <span>Config</span>
          {editor.canToggle && (
            <button type="button" onClick={editor.toggleMode}>
              {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
            </button>
          )}
        </div>
      )}

      {unrenderable.length > 0 && (
        <p className="contract-advisory">
          {`Saved settings this form cannot show (${unrenderable.join(', ')}) — editing as JSON.`}
        </p>
      )}

      {jsonMode ? (
        <LabelledControl label="Config (JSON)">
          {(id) => (
            <>
              <JsonEditor
                id={id}
                label="Config (JSON)"
                value={editor.jsonText}
                onValueChange={editor.setJsonText}
                // #1694 OR42 F10 — as tall as its text, never more than `maxRows`:
                // the whole config is the view, so it is not collapsed at rest.
                maxRows={maxRows}
                {...(errorFor === undefined
                  ? {}
                  : fieldAttrs({ key: 'config', error: jsonError, errorId: jsonErrorId }))}
              />
              {errorFor !== undefined && <FieldError id={jsonErrorId} message={jsonError} />}
            </>
          )}
        </LabelledControl>
      ) : (
        <>
          {fields.length === 0 && <p className="page-hint">{emptyHint}</p>}
          {fields.map((field) => {
            const choices = choicesFor?.(field.name);
            const offered = optionsFor?.(field);
            const before = fieldBefore?.(field.name);
            // #1477 OR29 — one box per field, so the property dock's grid can
            // pack or span it. `display: contents` everywhere else, which
            // leaves a resource form's column exactly as it was.
            return (
              <Fragment key={field.name}>
                {before !== undefined && before !== null && (
                  <FieldCell span="long">{before}</FieldCell>
                )}
                <FieldCell span={fieldSpan(field)}>
                  {fieldControl?.(
                    field,
                    editor.inputs[field.name] ?? emptyControlValue(field),
                    (next) => editor.setInput(field.name, next),
                  ) ?? (
                    <ConfigFieldControl
                      field={
                        offered === undefined ? field : { ...field, enumOptions: [...offered] }
                      }
                      value={editor.inputs[field.name] ?? emptyControlValue(field)}
                      onChange={(next) => editor.setInput(field.name, next)}
                      {...(choices === undefined ? {} : { choices })}
                      {...(picker === undefined ? {} : { picker })}
                      actions={fieldActions?.(field.name)}
                      {...(errorFor === undefined
                        ? {}
                        : {
                            validation: {
                              key: `config.${field.name}`,
                              error: errorFor(`config.${field.name}`),
                            },
                          })}
                    />
                  )}
                </FieldCell>
              </Fragment>
            );
          })}
          {fieldModeExtra}
          {carried.length > 0 && (
            <p className="contract-advisory">
              {`Carried from another kind (${carried.join(', ')}) — ${kindLabel} does not use these; blank a control to drop the key.`}
            </p>
          )}
        </>
      )}

      {/* Outside the mode branch on purpose: the Kind select is reachable in
          BOTH modes, and the JSON draft is exactly where a kind change can
          leave a config shaped for the previous one. */}
      {advisory !== null && (
        <p className="contract-advisory">{`This ${kindLabel} config is incomplete: ${advisory}`}</p>
      )}

      {children}
    </FieldGrid>
  );
}
