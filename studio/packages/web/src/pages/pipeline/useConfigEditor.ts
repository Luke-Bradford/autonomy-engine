import { useMemo } from 'react';
import {
  changeConfigKind,
  configEditorView,
  configToFields,
  configToJson,
  type ConfigDraft,
  type ConfigField,
  type FieldInput,
  type FieldsFor,
  type ForcedJson,
} from './configForm';

/**
 * The fields↔JSON config editor a resource form or a canvas node embeds
 * (#1146, #1088).
 *
 * `ConnectionForm` and `DatasetForm` each carried their own copy of this — the
 * derived mode, three handlers and ~35 lines of JSX — and the copies had already
 * diverged: only the dataset's kind change carried a JSON draft or committed a
 * field draft before a forced switch. `NodePanel` had a third, whose toggle
 * committed nothing at all (#1088). The RULES live in `configForm.ts`
 * (`changeConfigKind`, `configToJson`, `configToFields`); this hook and
 * `ConfigEditor` are the thin React half all three share.
 *
 * `fieldsFor` and `forcedJson` must be STABLE (module-level, or memoised on
 * what they close over) — they sit in the memo's dependencies.
 */
export interface ConfigEditorState<K extends string> {
  kind: K;
  fields: ConfigField[];
  carried: string[];
  unrenderable: string[];
  /** The mode ON SCREEN — the operator's flag or a forcing fact. */
  jsonMode: boolean;
  /** False when the page forces this kind into JSON: a toggle that can only refuse is furniture. */
  canToggle: boolean;
  jsonText: string;
  inputs: Readonly<Record<string, FieldInput>>;
  onKindChange: (kind: K) => void;
  toggleMode: () => void;
  setJsonText: (text: string) => void;
  setInput: (name: string, value: FieldInput) => void;
}

export function useConfigEditor<K extends string, F extends ConfigDraft<K>>({
  form,
  onChange,
  setError,
  fieldsFor,
  forcedJson,
}: {
  form: F;
  onChange: (next: F) => void;
  setError: (message: string | null) => void;
  fieldsFor: FieldsFor<K>;
  forcedJson?: ForcedJson<K>;
}): ConfigEditorState<K> {
  // Keyed on `kind`/`config`/`jsonMode` only: `form` is a new object on every
  // keystroke, and re-deriving fields while the operator types a NAME is waste.
  // The two drafts are stubbed because `configEditorView` reads neither — what
  // is on screen is decided by the stored config, never by a half-typed draft.
  const { kind, config, jsonMode: askedForJson } = form;
  const view = useMemo(
    () =>
      configEditorView<K>(
        { kind, config, jsonMode: askedForJson, inputs: {}, jsonText: '' },
        fieldsFor,
        forcedJson,
      ),
    [kind, config, askedForJson, fieldsFor, forcedJson],
  );

  function toggleMode() {
    const result = view.jsonMode
      ? configToFields<K, F>(form, fieldsFor)
      : configToJson<K, F>(form, view.fields);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onChange(result.form);
  }

  return {
    ...view,
    kind,
    canToggle: forcedJson === undefined || !forcedJson(kind),
    jsonText: form.jsonText,
    inputs: form.inputs,
    onKindChange(next: K) {
      const result = changeConfigKind<K, F>(form, next, fieldsFor, forcedJson);
      // Written on success too: an error from the previous kind is not this one's.
      setError(result.error);
      onChange(result.form);
    },
    toggleMode,
    setJsonText: (text) => onChange({ ...form, jsonText: text }),
    setInput: (name, value) => onChange({ ...form, inputs: { ...form.inputs, [name]: value } }),
  };
}
