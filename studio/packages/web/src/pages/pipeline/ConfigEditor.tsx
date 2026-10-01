import { useId, type ReactNode } from 'react';
import { ConfigFieldControl, type FieldChoices, type FieldPicker } from './ConfigFieldControl';
import { emptyControlValue } from './configForm';
import type { ConfigEditorState } from './useConfigEditor';
import { LabelledControl } from '../../lib/LabelledControl';
import { FieldError } from '../../lib/form/FieldError';
import { fieldAttrs } from '../../lib/form/fieldValidation';

/**
 * The Config group a resource form or a canvas node embeds (#1146, #1088) — the
 * view half of `useConfigEditor`. The mode toggle, the unrenderable advisory, the textarea or
 * the controls, the carried advisory, and the page's own incomplete-config
 * advisory (each resource judges completeness differently, so it arrives as a
 * string).
 */
export function ConfigEditor<K extends string>({
  editor,
  className,
  rows,
  advisory,
  choicesFor,
  picker,
  emptyHint = 'This kind has no settings.',
  fieldModeExtra,
  errorFor,
  children,
}: {
  editor: ConfigEditorState<K>;
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
  /** Rendered last inside the group, in both modes. */
  children?: ReactNode;
}) {
  const { kind, jsonMode, unrenderable, fields, carried } = editor;
  const jsonErrorId = useId();
  const jsonError = errorFor?.('config');
  return (
    <div className={className} role="group" aria-label="Config">
      <div>
        <span>Config</span>
        {editor.canToggle && (
          <button type="button" onClick={editor.toggleMode}>
            {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
          </button>
        )}
      </div>

      {unrenderable.length > 0 && (
        <p className="contract-advisory">
          {`Saved settings this form cannot show (${unrenderable.join(', ')}) — editing as JSON.`}
        </p>
      )}

      {jsonMode ? (
        <LabelledControl label="Config (JSON)">
          {(id) => (
            <>
              <textarea
                id={id}
                value={editor.jsonText}
                onChange={(e) => editor.setJsonText(e.target.value)}
                rows={rows}
                spellCheck={false}
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
            return (
              <ConfigFieldControl
                key={field.name}
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
            );
          })}
          {fieldModeExtra}
          {carried.length > 0 && (
            <p className="contract-advisory">
              {`Carried from another kind (${carried.join(', ')}) — ${kind} ignores these; blank a control to drop the key.`}
            </p>
          )}
        </>
      )}

      {/* Outside the mode branch on purpose: the Kind select is reachable in
          BOTH modes, and the JSON draft is exactly where a kind change can
          leave a config shaped for the previous one. */}
      {advisory !== null && (
        <p className="contract-advisory">{`This ${kind} config is incomplete: ${advisory}`}</p>
      )}

      {children}
    </div>
  );
}
