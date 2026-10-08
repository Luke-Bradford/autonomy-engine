import { useEffect, useRef, useState } from 'react';
import { Combobox, Option, OptionGroup } from '@fluentui/react-components';
import type { ConnectionProbeResult, ConnectionPublic } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { testSavedConnection } from '../../api/connections';
import { ConnectionKindGlyph } from '../../lib/KindName';
import { LabelledControl } from '../../lib/LabelledControl';
import type { ConnectionKindDisabledReason } from '../../lib/connectionKindGroups';
import { connectionOptionLabel } from '../../lib/resourceOptionLabel';
import { ProbeVerdict } from '../connections/ProbeVerdict';
import { connectionPickerGroups, filterConnectionPickerGroups } from './bindingPickers';

/**
 * The listbox's two entries that are not connections. A NUL prefix, because a
 * connection id is server-minted text that never holds one, so neither can be
 * mistaken for a connection whatever the workspace holds.
 */
const NONE = '\u0000none';
const NEW = '\u0000new';

/** The closed picker's widest text, in `ch`, before it stops growing (≈ 320px). */
const MAX_WIDTH_CH = 40;

/**
 * #1477 OR29 slice 5 — one connection binding on an activity: the picker, then
 * Test, Edit and New beside it, as ADF's linked-service picker has them.
 *
 * Every connection is listed, grouped by kind; a kind this side refuses is
 * listed disabled with the reason (`connectionPickerGroups`). The option text
 * keeps the kind (`connectionOptionLabel`) because the CLOSED picker shows only
 * the option, and the group heading is not visible there.
 *
 * Test probes the SAVED connection (`testSavedConnection`), so it answers for
 * what a run would use. The verdict is tagged with the id it was taken for and
 * stops rendering once the selection moves, as the form's verdict does with its
 * draft (#1191). It is also tagged with the row's `updatedAt` (#1477 5c): once
 * the connection is edited, "Connected." is a reading of what it used to be.
 *
 * Edit (5c) and ＋ New are offered only when the host can open the connection
 * column (`onEdit`, `onNew`); the editor hosts it, so a selection change cannot
 * unmount a draft. Edit needs a bound connection that still exists: a dangling
 * id has nothing to open.
 *
 * Slice 5c also made the list searchable, as the spec asks: a Fluent
 * `Combobox`, so the listbox is portalled (the dock scrolls, and an in-flow
 * list would be clipped by it) and keyboard handling is Fluent's. Each option
 * is the kind's icon, the name, and where it points (`connectionLocation`).
 * Typing filters on name, kind and location; a refused match stays listed,
 * disabled. ＋ New is also the list's last entry, as in ADF's linked-service
 * dropdown, which makes it the empty picker's one live entry: with nothing this
 * slot can use, opening the list leads to the kind gallery rather than a dead
 * "none".
 *
 * A bound id with no row behind it (deleted, or not yet loaded) is SHOWN, as
 * the id: a blank picker reads as "nothing is bound" while the doc says
 * otherwise (`eligibleForBinding`'s reason).
 */
export function ConnectionPicker({
  label,
  value,
  connections,
  disabledReason,
  onPick,
  onEdit,
  onNew,
}: {
  label: string;
  value: string | undefined;
  connections: readonly ConnectionPublic[];
  disabledReason: ConnectionKindDisabledReason;
  onPick: (id: string | undefined) => void;
  /** Open the bound connection in the connection column. */
  onEdit?: (id: string, opener: HTMLElement) => void;
  /** Open the New connection column; the button is the opener focus returns to. */
  onNew?: (opener: HTMLElement) => void;
}) {
  const groups = connectionPickerGroups(connections, disabledReason, value);
  const bound = value === undefined ? undefined : connections.find((c) => c.id === value);
  /** What the author has typed since the list opened; `null` when not searching. */
  const [query, setQuery] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const shown = query === null ? groups : filterConnectionPickerGroups(groups, query);
  const pickable = groups.some((g) => g.options.some((o) => o.disabledReason === undefined));
  const selectedText =
    value === undefined
      ? ''
      : bound !== undefined
        ? connectionOptionLabel(bound)
        : `${value} (not found)`;
  const widest = Math.max(
    selectedText.length,
    ...groups.flatMap((g) => g.options.map((o) => o.label.length)),
    8,
  );
  const [verdict, setVerdict] = useState<{
    id: string;
    updatedAt: number | undefined;
    result: ConnectionProbeResult;
  } | null>(null);
  const [probing, setProbing] = useState(false);
  // A probe outlives a node switch (the panel remounts per node); its answer
  // must not be written into a panel that is gone.
  const mounted = useRef(true);
  useEffect(() => {
    // Set here as well as initially: StrictMode runs the cleanup once on mount.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * Which probe may still report. A pick moves it on, so a probe that was in
   * flight across a re-pick — even back to the same connection — is dropped
   * rather than shown as a reading of the new choice.
   */
  const probeSeq = useRef(0);
  const noun = label.charAt(0).toLowerCase() + label.slice(1);

  async function onTest(id: string, updatedAt: number | undefined) {
    const seq = ++probeSeq.current;
    setVerdict(null);
    setProbing(true);
    let result: ConnectionProbeResult;
    try {
      result = await testSavedConnection(id);
    } catch (err) {
      // A failed request is reported where the answer would have been: the
      // question was asked and got no "Connected." back.
      result = { ok: false, error: messageOf(err) };
    }
    if (!mounted.current || seq !== probeSeq.current) return;
    setProbing(false);
    setVerdict({ id, updatedAt, result });
  }

  return (
    <>
      <LabelledControl label={label}>
        {(id) => (
          <div className="connection-picker">
            <Combobox
              id={id}
              ref={input}
              className="connection-picker__combobox"
              style={{ width: `calc(${Math.min(widest, MAX_WIDTH_CH)}ch + 40px)` }}
              listbox={{ className: 'connection-picker__listbox' }}
              placeholder={pickable || value !== undefined ? 'None' : 'No connection yet'}
              value={query ?? selectedText}
              selectedOptions={value === undefined ? [] : [value]}
              onChange={(e) => setQuery(e.target.value)}
              onOpenChange={(_e, data) => {
                if (!data.open) setQuery(null);
              }}
              onOptionSelect={(_e, data) => {
                const picked = data.optionValue;
                // Typing clears Fluent's selection (`optionValue` undefined); a
                // search is not an unbind, and must not end itself. None is the
                // one way to unbind.
                if (picked === undefined) return;
                setQuery(null);
                if (picked === NEW) {
                  if (onNew !== undefined && input.current !== null) onNew(input.current);
                  return;
                }
                const next = picked === NONE ? undefined : picked;
                if (next === value) return;
                // A verdict is a reading from one moment; a re-pick starts afresh.
                probeSeq.current += 1;
                setProbing(false);
                setVerdict(null);
                onPick(next);
              }}
            >
              <Option value={NONE} text="None">
                None
              </Option>
              {shown.map((group) => (
                <OptionGroup key={group.kind} label={group.label}>
                  {group.options.map((o) => (
                    <Option
                      key={o.id}
                      value={o.id}
                      text={o.label}
                      disabled={o.disabledReason !== undefined}
                    >
                      <span className="connection-option" title={o.location}>
                        <span className="connection-option__name">
                          <ConnectionKindGlyph kind={group.kind} />
                          {o.name}
                        </span>
                        {o.location !== undefined && (
                          <span className="connection-option__line">{o.location}</span>
                        )}
                        {o.disabledReason !== undefined && (
                          <span className="connection-option__line">{o.disabledReason}</span>
                        )}
                      </span>
                    </Option>
                  ))}
                </OptionGroup>
              ))}
              {query !== null && query.trim() !== '' && shown.length === 0 && (
                <Option value={'\u0000nomatch'} disabled>
                  No connections match
                </Option>
              )}
              {onNew !== undefined && (
                <Option value={NEW}>
                  New connection…
                </Option>
              )}
            </Combobox>
            <button
              type="button"
              aria-label={`Test selected ${noun}`}
              disabled={value === undefined || probing}
              onClick={() => {
                if (value !== undefined) void onTest(value, bound?.updatedAt);
              }}
            >
              Test
            </button>
            {onEdit !== undefined && (
              <button
                type="button"
                aria-label={`Edit selected ${noun}`}
                disabled={bound === undefined}
                onClick={(e) => {
                  if (bound !== undefined) onEdit(bound.id, e.currentTarget);
                }}
              >
                Edit
              </button>
            )}
            {onNew !== undefined && (
              <button
                type="button"
                aria-label={`New ${noun}`}
                onClick={(e) => onNew(e.currentTarget)}
              >
                New
              </button>
            )}
          </div>
        )}
      </LabelledControl>
      {verdict !== null && verdict.id === value && verdict.updatedAt === bound?.updatedAt && (
        <ProbeVerdict result={verdict.result} />
      )}
    </>
  );
}
