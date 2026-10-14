import { useId, type ReactNode } from 'react';
import { AboutHelp } from '../HelpDisclosure';

/**
 * #1694 OR42 — a tick box with what it does behind a `?` beside it, not a
 * paragraph under it (labels, not prose). The `?` is a SIBLING of the label in
 * a `help-row`: inside it, the `?`'s name would join the box's, and a
 * `<details>` may not sit in a label. The note stays the box's description, so
 * a screen reader hears it on reaching the box whether or not it is open.
 *
 * `ConfigFieldControl`'s checkbox still draws its hint as a line; it moves here
 * when the config fields' prose does (OR42's later slices).
 */
export function CheckboxField({
  label,
  checked,
  onChange,
  about,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  about: ReactNode;
}) {
  const noteId = useId();
  return (
    <div className="checkbox-field help-row">
      <label className="contract-check">
        <input
          type="checkbox"
          checked={checked}
          aria-describedby={noteId}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      <AboutHelp name={label} noteId={noteId}>
        {about}
      </AboutHelp>
    </div>
  );
}
