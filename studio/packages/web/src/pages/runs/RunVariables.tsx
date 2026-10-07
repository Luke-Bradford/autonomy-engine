import { VALUE_TYPE_TITLES } from '@autonomy-studio/shared';
import type { ReactNode } from 'react';
import type { RunState, VariableDef } from '@autonomy-studio/shared';
import { InlineJsonValue } from './CappedValue';

/**
 * #844 V7 (spec V-D9) — the run's pipeline variables, as the ENGINE holds them.
 *
 * Read from the page's one projection (`useRunProjection`), never re-derived
 * from the log here. The reducer's `state.variables` is the only place a write
 * is judged: it drops a stale `variable.*` event (an abandoned attempt), starts
 * from the bound version's defaults, and applies a rerun's copied writes, and a
 * second fold on this page would have to repeat all three to agree with it. The
 * projection re-folds on every event, so on a live run these are the values so
 * far and on a settled one they are final.
 *
 * Only the TYPE comes from the declaration, and the ORDER: rows follow the
 * Variables tab rather than the object's key order.
 *
 * When there is nothing it could say — no version doc, or a pipeline that
 * declares no variables — it renders `empty` instead, which the run page's
 * Variables tab uses to say which: a tab the reader opened must not be blank.
 */
export function RunVariables({
  declared,
  overlay,
  settled,
  empty = null,
}: {
  /** `doc?.variables` — `undefined` while the version doc is unavailable. */
  declared: readonly VariableDef[] | undefined;
  overlay: { ready: true; state: Pick<RunState, 'variables'> } | { ready: false; reason: string };
  settled: boolean;
  /** Shown in place of the section when there are no variables to show. */
  empty?: ReactNode;
}) {
  if (declared === undefined || declared.length === 0) return empty;
  return (
    <section aria-labelledby="run-variables-heading">
      <h3 id="run-variables-heading">Variables</h3>
      {!overlay.ready ? (
        /* The overlay's reason names NODE state, so it is prefixed rather than
           shown bare under a Variables heading. */
        <p className="page-hint">Variable values are unavailable. {overlay.reason}</p>
      ) : (
        <>
          <p className="page-hint">
            {settled ? 'Final values.' : 'Current values, updated as the run writes them.'}
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Type</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {declared.map((v, i) => {
                const value = overlay.state.variables[v.name];
                return (
                  <tr key={v.name}>
                    <th scope="row">
                      <code>{v.name}</code>
                    </th>
                    <td>{VALUE_TYPE_TITLES[v.type]}</td>
                    <td>
                      {value === undefined ? (
                        <span className="page-hint">no value</span>
                      ) : (
                        <InlineJsonValue id={`run-variable-value-${i}`} value={value} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
