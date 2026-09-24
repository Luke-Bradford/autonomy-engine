import type { ReactNode } from 'react';
import { ConfigFieldControl, type FieldChoices } from './ConfigFieldControl';
import { emptyControlValue } from './configForm';
import type { ConfigEditorState } from './useConfigEditor';

/**
 * The Config group a resource form embeds (#1146, #1088) — the view half of
 * `useConfigEditor`. The mode toggle, the unrenderable advisory, the textarea or
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
  fieldModeExtra,
  children,
}: {
  editor: ConfigEditorState<K>;
  className: string;
  rows: number;
  advisory: string | null;
  choicesFor?: (fieldName: string) => FieldChoices | undefined;
  /** Rendered only with the controls, before the carried advisory. */
  fieldModeExtra?: ReactNode;
  /** Rendered last inside the group, in both modes. */
  children?: ReactNode;
}) {
  const { kind, jsonMode, unrenderable, fields, carried } = editor;
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
        <label>
          Config (JSON)
          <textarea
            value={editor.jsonText}
            onChange={(e) => editor.setJsonText(e.target.value)}
            rows={rows}
            spellCheck={false}
          />
        </label>
      ) : (
        <>
          {fields.length === 0 && <p className="page-hint">This kind has no settings.</p>}
          {fields.map((field) => {
            const choices = choicesFor?.(field.name);
            return (
              <ConfigFieldControl
                key={field.name}
                field={field}
                value={editor.inputs[field.name] ?? emptyControlValue(field)}
                onChange={(next) => editor.setInput(field.name, next)}
                {...(choices === undefined ? {} : { choices })}
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
