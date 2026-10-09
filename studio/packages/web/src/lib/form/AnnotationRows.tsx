import type { ReactNode } from 'react';
import { MAX_ANNOTATIONS } from '@autonomy-studio/shared';
import { RemoveRowButton, RowActions, RowList, RowNotes, type RowTableColumn } from './RowTable';

/** A resource's annotations: one text box a row. */
const ANNOTATION_COLUMNS: readonly RowTableColumn[] = [{ key: 'annotation', header: 'Annotation' }];

/** What a row's input is wired to when its form reports errors by field. */
export interface AnnotationRowField {
  attrs: Record<string, unknown>;
  /** The row's error, rendered on a notes row under it; `null` when there is none. */
  error: ReactNode;
}

/**
 * #1477 — the annotations list of any resource that carries them: a pipeline's
 * General tab and a connection's form. Controlled, so each owner keeps its own
 * state (the canvas store, the connection draft), and without its section
 * chrome: the `Section` it sits in belongs to the dock or the drawer.
 *
 * One text box per row (ADF's own editor) rather than one textarea split on
 * newlines, so an annotation is never re-cut by the editor; nothing here trims or
 * de-duplicates what was typed — refusals are the owner's to show. Add stops at
 * `MAX_ANNOTATIONS`, the write schema's own limit.
 */
export function AnnotationRows({
  annotations,
  onAdd,
  onUpdate,
  onRemove,
  field,
}: {
  annotations: readonly string[];
  onAdd: () => void;
  onUpdate: (index: number, text: string) => void;
  onRemove: (index: number) => void;
  /** Per-row validation wiring; omitted where errors are reported elsewhere. */
  field?: (index: number) => AnnotationRowField;
}) {
  return (
    <RowList
      columns={ANNOTATION_COLUMNS}
      label="Annotations"
      count={annotations.length}
      addLabel="Add annotation"
      onAdd={onAdd}
      addDisabled={annotations.length >= MAX_ANNOTATIONS}
    >
      {annotations.map((text, i) => {
        const wiring = field?.(i);
        return [
          <tr key={`row-${i}`}>
            <td>
              <input
                aria-label={`annotation ${i + 1}`}
                value={text}
                onChange={(e) => onUpdate(i, e.target.value)}
                {...wiring?.attrs}
              />
            </td>
            <RowActions>
              <RemoveRowButton label={`remove annotation ${i + 1}`} onRemove={() => onRemove(i)} />
            </RowActions>
          </tr>,
          wiring?.error ? (
            <RowNotes key={`notes-${i}`} span={ANNOTATION_COLUMNS.length + 1}>
              {wiring.error}
            </RowNotes>
          ) : null,
        ];
      })}
    </RowList>
  );
}
