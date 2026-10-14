import { useId, type ReactNode } from 'react';
import { AboutHelp } from '../HelpDisclosure';

/**
 * #1694 OR42 — a tick box with what it does behind a `?` beside it, not a
 * paragraph under it (labels, not prose). The ONE checkbox-with-help: the run
 * policy's secure flags and a config form's boolean fields both draw it.
 *
 * The `?` is a SIBLING of the label in a `help-row`: inside it, the `?`'s name
 * would join the box's, and a `<details>` may not sit in a label. The note
 * stays the box's description, so a screen reader hears it on reaching the box
 * whether or not it is open.
 *
 * `noteId` and `describedBy` are for a caller that owns the wiring (a config
 * field's note id is also its validation's); otherwise both are made here.
 */
export function CheckboxField({
  label,
  name,
  checked,
  onChange,
  about,
  noteId,
  describedBy,
}: {
  /** What the box's label shows; `name` when it is not plain text. */
  label: ReactNode;
  /** The box's name, for its `?` ("About {name}"). */
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The note behind the `?`; none draws no `?`. */
  about?: ReactNode;
  noteId?: string;
  describedBy?: string;
}) {
  const ownId = useId();
  const id = noteId ?? ownId;
  const box = (
    <label className="contract-check">
      <input
        type="checkbox"
        checked={checked}
        aria-describedby={describedBy ?? (about === undefined ? undefined : id)}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
  if (about === undefined) return box;
  return (
    <div className="help-row">
      {box}
      <AboutHelp name={name} noteId={id}>
        {about}
      </AboutHelp>
    </div>
  );
}
