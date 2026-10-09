import { useId, type ReactNode } from 'react';
import { ConfigFieldControl, type FieldChoices, type FieldPicker } from './ConfigFieldControl';
import { emptyControlValue, fieldSpan } from './configForm';
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
  rows,
  advisory,
  choicesFor,
  picker,
  emptyHint = 'This kind has no settings.',
  fieldModeExtra,
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
  rows: number;
  advisory: string | null;
  choicesFor?: (fieldName: string) => FieldChoices | undefined;
  /** The canvas's expression picker (U8a) — a resource form has no graph to pick from. */
  picker?: FieldPicker;
  /** Shown when the kind declares no fields at all. */
  emptyHint?: string;
  /** Rendered only with the controls, before the carried advisory. */
  fieldModeExtra?: ReactNode;
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
                rows={rows}
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
            // #1477 OR29 — one box per field, so the property dock's grid can
            // pack or span it. `display: contents` everywhere else, which
            // leaves a resource form's column exactly as it was.
            return (
              <FieldCell key={field.name} span={fieldSpan(field)}>
                <ConfigFieldControl
                  field={field}
                  value={editor.inputs[field.name] ?? emptyControlValue(field)}
                  onChange={(next) => editor.setInput(field.name, next)}
                  {...(choices === undefined ? {} : { choices })}
                  {...(picker === undefined ? {} : { picker })}
                  {...(errorFor === undefined
                    ? {}
                    : {
                        validation: {
                          key: `config.${field.name}`,
                          error: errorFor(`config.${field.name}`),
                        },
                      })}
                />
              </FieldCell>
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
