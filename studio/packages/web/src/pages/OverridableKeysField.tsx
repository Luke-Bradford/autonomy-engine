import { noOverridableSettingsNote } from './pipeline/paramOverrides';
import {
  allowlistRows,
  toggleAllowlistKey,
  type AllowlistSubject,
  type StrayReason,
} from './overrideAllowlist';

const STRAY_NOTE: Record<StrayReason, string> = {
  never: 'never overridable, so a run refuses it',
  unknown: 'not a setting of this kind, so a run cannot use it',
};

/**
 * #1305 — a connection's or dataset's `parameters` allowlist: which config keys a
 * node that uses it may override per run. The canvas's override editor (#1304)
 * offers exactly the keys ticked here.
 *
 * Each checkbox is named `Overridable: <key>`, not the bare key. The config
 * fields above it are labelled by the same key, and a shared name would make
 * every "the `path` field" query on the page ambiguous — for a person with a
 * screen reader as much as for a test.
 *
 * No live-region role: both pages already claim `status` and `alert` in the
 * singular, and nothing here is an interruption.
 */
export function OverridableKeysField({
  subject,
  seed,
  value,
  onChange,
}: {
  subject: AllowlistSubject;
  /** The allowlist as the form opened on it, so a stray stays visible once unticked. */
  seed: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const rows = allowlistRows(subject, seed, value);
  return (
    <fieldset className="overridable-keys">
      <legend>Overridable per node</legend>
      {/* Keyed on what the KIND offers, not on the row count: a kind with nothing
          overridable still draws the stray rows an old allowlist left behind, so
          they can be unticked, and the note is still the true thing to say. */}
      <p className="page-hint">
        {subject.offered.length === 0
          ? noOverridableSettingsNote(subject.kind, subject.noun)
          : `A pipeline node that uses this ${subject.noun} may set the ticked settings for each run. Nothing else can be overridden.`}
      </p>
      {rows.map((row) => (
        <label key={row.key} className="checkbox">
          <input
            type="checkbox"
            checked={row.checked}
            onChange={(e) => onChange(toggleAllowlistKey(value, row.key, e.target.checked))}
          />
          <span className="visually-hidden">Overridable: </span>
          <code>{row.key}</code>
          {row.stray !== null && <span className="page-hint"> — {STRAY_NOTE[row.stray]}</span>}
        </label>
      ))}
    </fieldset>
  );
}
