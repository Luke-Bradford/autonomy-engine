import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import {
  DEFAULT_RETRY_INTERVAL_SECONDS,
  MAX_RETRY_INTERVAL_SECONDS,
  type NodePolicy,
} from '@autonomy-studio/shared';
import { LabelledControl } from '../../lib/LabelledControl';
import { parseWholeNumber } from '../triggers/formFields';
import { enclosingContainers, nodePolicyIssues, policyIssues, validateCanvas } from './canvasDoc';
import type { createCanvasStore } from './canvasStore';
import { readableIssue } from './containerRules';

/**
 * #1312 — a node's run `policy` in the canvas: retries, the interval between
 * them, and F4's secure input/output flags. Until this, `policy` could be set
 * only through the API or an import.
 *
 * Writes straight to the store (no Apply): policy is not part of the config
 * draft `Apply config` commits, and each control here is a single value.
 *
 * `timeoutSeconds` is deliberately NOT offered: nothing reads it until F3 (#1
 * spec's ticket table, under #432) ships, and a control for a setting the engine
 * ignores would be a promise the run does not keep. A stored one — from an
 * import or the API — is kept on every edit, said plainly to be unenforced, and
 * can be removed, because the write schema's typo ceiling can block a save on it
 * and a save-blocking value must be repairable where it is shown.
 *
 * Self-contained over the store (nodes/edges/containers/params), so it mounts
 * unchanged in both of `NodePanel`'s branches, the call panel included: a secure
 * flag on a call is refused, and that refusal is explained here like any other.
 */
export function PolicyEditor({
  store,
  nodeId,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
}) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);
  const policy = nodes.find((n) => n.id === nodeId)?.policy;

  // Filtered BEFORE `readableIssue`: the filter reads the validators' quoted ids,
  // which the rewrite replaces with names. Memoised because it re-runs the whole
  // doc validator, as `ContainerPanel`'s `blocked` does.
  const issues = useMemo(
    () =>
      nodePolicyIssues(
        [...validateCanvas(nodes, edges, containers, params), ...policyIssues(nodes)],
        nodeId,
        enclosingContainers(nodeId, containers),
      ).map((issue) => readableIssue(issue, nodes, edges, containers)),
    [nodes, edges, containers, params, nodeId],
  );

  function set(patch: Partial<NodePolicy>) {
    store.getState().setNodePolicy(nodeId, { ...policy, ...patch });
  }

  return (
    <fieldset className="contract-section">
      <legend>Run policy</legend>
      <PolicyNumber
        label="Retries"
        stored={policy?.retry}
        placeholder="no retry"
        hint="Times a transient failure is retried after the first attempt. 0 never retries; blank leaves it unset."
        onCommit={(retry) => set({ retry })}
      />
      <PolicyNumber
        label="Retry interval (seconds)"
        stored={policy?.retryIntervalSeconds}
        placeholder={String(DEFAULT_RETRY_INTERVAL_SECONDS)}
        hint={
          `Wait between attempts, ${DEFAULT_RETRY_INTERVAL_SECONDS}–${MAX_RETRY_INTERVAL_SECONDS}. ` +
          `Blank waits ${DEFAULT_RETRY_INTERVAL_SECONDS}s. A provider's Retry-After, when it ` +
          `sends one, is used instead (never less than ${DEFAULT_RETRY_INTERVAL_SECONDS}s).`
        }
        onCommit={(retryIntervalSeconds) => set({ retryIntervalSeconds })}
      />
      <label>
        <input
          type="checkbox"
          checked={policy?.secureInput === true}
          onChange={(e) => set({ secureInput: e.target.checked || undefined })}
        />
        Secure input
      </label>
      <p className="page-hint">
        Keep this node&rsquo;s resolved input out of the run log — failure text and warnings that
        would repeat it are withheld.
      </p>
      <label>
        <input
          type="checkbox"
          checked={policy?.secureOutput === true}
          onChange={(e) => set({ secureOutput: e.target.checked || undefined })}
        />
        Secure output
      </label>
      <p className="page-hint">
        Redact this node&rsquo;s outputs before they reach the run log. Nothing downstream can
        reference them.
      </p>
      {policy?.timeoutSeconds !== undefined && (
        <p className="contract-advisory">
          This node stores a timeout of {policy.timeoutSeconds}s, which is not enforced yet —
          nothing reads it.{' '}
          <button type="button" onClick={() => set({ timeoutSeconds: undefined })}>
            Remove the timeout
          </button>
        </p>
      )}
      {/* Plain visible text, not a live region: recomputed state that changes as
          the author edits, and the canvas's own badge list already announces the
          save being blocked (#1249's one-announcer concern). */}
      {issues.length > 0 && (
        <ul className="contract-advisory">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/**
 * One whole-number policy field. A TEXT input for `ConfigFieldControl`'s reason:
 * a `type="number"` input reports text it rejects as `''`, which this field reads
 * as "unset", so a typo would silently delete the setting. Commits on blur, and
 * re-seeds when the stored value changes underneath it (an undo) — the bounce
 * cap editor's pattern, render-phase derived state rather than an effect.
 *
 * Range is NOT checked here: `parseWholeNumber` leaves it to the write schema,
 * whose refusal comes back through `policyIssues` as a badge naming the field.
 */
function PolicyNumber({
  label,
  stored,
  placeholder,
  hint,
  onCommit,
}: {
  label: string;
  stored: number | undefined;
  placeholder: string;
  hint: string;
  onCommit: (value: number | undefined) => void;
}) {
  const text = stored === undefined ? '' : String(stored);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(text);
  if (synced !== text) {
    setSynced(text);
    setDraft(text);
    setError(null);
  }

  function commit(raw: string) {
    const parsed = parseWholeNumber(raw);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    // A blur that changed nothing must not write, or tabbing through the field
    // would dirty an untouched doc. It still cleared the error above.
    if (parsed.value === stored) return;
    onCommit(parsed.value);
  }

  return (
    <>
      <LabelledControl label={label}>
        {(id) => (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            spellCheck={false}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
          />
        )}
      </LabelledControl>
      {error !== null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="page-hint">{hint}</p>
      )}
    </>
  );
}
