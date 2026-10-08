import { useEffect, useRef, useState } from 'react';
import type { ConnectionProbeResult, ConnectionPublic } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { testSavedConnection } from '../../api/connections';
import { LabelledControl } from '../../lib/LabelledControl';
import type { ConnectionKindDisabledReason } from '../../lib/connectionKindGroups';
import { ProbeVerdict } from '../connections/ProbeVerdict';
import { connectionPickerGroups } from './bindingPickers';

/**
 * #1477 OR29 slice 5b — one connection binding on an activity: the select, then
 * Test and ＋ New beside it, as ADF's linked-service picker has them.
 *
 * Every connection is listed, grouped by kind; a kind this side refuses is
 * listed disabled with the reason (`connectionPickerGroups`). The option text
 * keeps the kind (`connectionOptionLabel`) because the CLOSED select shows only
 * the option, and the group heading is not visible there.
 *
 * Test probes the SAVED connection (`testSavedConnection`), so it answers for
 * what a run would use. The verdict is tagged with the id it was taken for and
 * stops rendering once the selection moves, as the form's verdict does with its
 * draft (#1191).
 *
 * ＋ New is offered only when the host can open the New connection column
 * (`onNew`); the editor hosts it, so a selection change cannot unmount a draft.
 */
export function ConnectionPicker({
  label,
  value,
  connections,
  disabledReason,
  onPick,
  onNew,
}: {
  label: string;
  value: string | undefined;
  connections: readonly ConnectionPublic[];
  disabledReason: ConnectionKindDisabledReason;
  onPick: (id: string | undefined) => void;
  /** Open the New connection column; the button is the opener focus returns to. */
  onNew?: (opener: HTMLElement) => void;
}) {
  const groups = connectionPickerGroups(connections, disabledReason, value);
  const [verdict, setVerdict] = useState<{ id: string; result: ConnectionProbeResult } | null>(
    null,
  );
  const [probing, setProbing] = useState(false);
  // A probe outlives a node switch (the panel remounts per node); its answer
  // must not be written into a panel that is gone.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const noun = label.charAt(0).toLowerCase() + label.slice(1);

  async function onTest(id: string) {
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
    if (!mounted.current) return;
    setProbing(false);
    setVerdict({ id, result });
  }

  return (
    <>
      <LabelledControl label={label}>
        {(id) => (
          <div className="connection-picker">
            <select
              id={id}
              value={value ?? ''}
              onChange={(e) => onPick(e.target.value || undefined)}
            >
              <option value="">— none —</option>
              {groups.map((group) => (
                <optgroup key={group.kind} label={group.label}>
                  {group.options.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.disabledReason !== undefined}>
                      {o.disabledReason === undefined
                        ? o.label
                        : `${o.label} — ${o.disabledReason}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Test selected ${noun}`}
              disabled={value === undefined || probing}
              onClick={() => {
                if (value !== undefined) void onTest(value);
              }}
            >
              Test
            </button>
            {onNew !== undefined && (
              <button
                type="button"
                aria-label={`New ${noun}`}
                onClick={(e) => onNew(e.currentTarget)}
              >
                ＋ New
              </button>
            )}
          </div>
        )}
      </LabelledControl>
      {verdict !== null && verdict.id === value && <ProbeVerdict result={verdict.result} />}
    </>
  );
}
