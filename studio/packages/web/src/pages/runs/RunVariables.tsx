import type { RunState, VariableDef } from '@autonomy-studio/shared';
import { CappedValue } from './CappedValue';
import { jsonText, MAX_INLINE_OUTPUT_CHARS } from './format';

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
 * Omitted entirely when there is nothing it could say: no version doc (the page
 * already states that above the graph) or a pipeline that declares no
 * variables. Unlike the cost section, "no variables" is a fact about the
 * pipeline, not about the run, and saying it on every run would be noise.
 */
export function RunVariables({
  declared,
  overlay,
  settled,
}: {
  /** `doc?.variables` — `undefined` while the version doc is unavailable. */
  declared: readonly VariableDef[] | undefined;
  overlay: { ready: true; state: Pick<RunState, 'variables'> } | { ready: false; reason: string };
  settled: boolean;
}) {
  if (declared === undefined || declared.length === 0) return null;
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
                    <td>{v.type}</td>
                    <td>
                      {value === undefined ? (
                        <span className="page-hint">no value</span>
                      ) : (
                        <VariableValue id={`run-variable-value-${i}`} value={value} />
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

/**
 * One value as JSON, so a string is shown QUOTED: an empty string would
 * otherwise be a blank cell, and a string could pass for the "no value" marker.
 * A short value stays inline; a longer one (an array an `append` has grown,
 * typically) gets the drill-in's bounded block, whose disclosure and copy reach
 * the whole value, because this table is the only place the run's array is
 * shown.
 */
function VariableValue({ id, value }: { id: string; value: unknown }) {
  const text = jsonText(value);
  return text.length <= MAX_INLINE_OUTPUT_CHARS ? (
    <code>{text}</code>
  ) : (
    <CappedValue id={id} text={text} />
  );
}
