import { useMemo } from 'react';
import { useStore } from 'zustand';
import {
  DEFAULT_RETRY_INTERVAL_SECONDS,
  MAX_RETRY_INTERVAL_SECONDS,
  timeoutApplies,
  type NodePolicy,
} from '@autonomy-studio/shared';
import { FieldCell, FieldGrid } from '../../lib/form/FieldGrid';
import { useFieldErrorLine } from '../../lib/form/FieldErrorLine';
import { Section } from '../../lib/Section';
import { CheckboxField } from '../../lib/form/CheckboxField';
import { Toolbar } from '../../lib/PageHeader';
import { parseTimeoutSeconds, parseWholeNumber } from '../triggers/formFields';
import { DraftNumberField } from './DraftNumberField';
import { enclosingContainers, nodePolicyIssues, policyIssues, validateCanvas } from './canvasDoc';
import type { createCanvasStore } from './canvasStore';
import { readableIssue } from './containerRules';

/** Both secure flags' shared effect, in each one's note (#1694 OR42: was a paragraph under them). */
const WITHHOLDS =
  'Either flag also withholds failure text and warnings, which could repeat a secret.';

/**
 * #1312 — a node's run `policy` in the canvas: retries, the interval between
 * them, and F4's secure input/output flags. Until this, `policy` could be set
 * only through the API or an import.
 *
 * Writes straight to the store (no Apply): policy is not part of the config
 * draft `Apply config` commits, and each control here is a single value.
 *
 * #1600 C0a — `timeoutSeconds` is offered on an EXECUTION activity only, the
 * one place the executor enforces it. Anywhere else (a call, a webhook, an
 * engine-evaluated activity) the save refuses a stored one; its refusal is
 * listed below with a Remove button, because a save-blocking value must be
 * repairable where it is shown.
 *
 * Self-contained over the store (nodes/edges/containers/params), so it mounts
 * unchanged in both of `NodePanel`'s branches, the call panel included: a secure
 * flag on a call is refused, and that refusal is explained here like any other.
 *
 * #1477 OR29 — the retry numbers and then the flags are two `FieldGrid`s, so
 * the compact dock packs each pair onto one row; one grid of four would leave
 * the fourth alone on a row once the tab is wide enough for three. #1600 C0a —
 * the timeout is a grid of its own above them, first as in ADF's General tab,
 * for the same reason: in the pair's grid it would push the interval onto a
 * row alone.
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
  const variables = useStore(store, (s) => s.variables);
  const globals = useStore(store, (s) => s.globals);
  const node = nodes.find((n) => n.id === nodeId);
  const policy = node?.policy;
  const timesOut = node !== undefined && timeoutApplies(node);

  // Filtered BEFORE `readableIssue`: the filter reads the validators' quoted ids,
  // which the rewrite replaces with names. Memoised because it re-runs the whole
  // doc validator, as `ContainerPanel`'s `blocked` does.
  const issues = useMemo(
    () =>
      nodePolicyIssues(
        [
          ...validateCanvas(nodes, edges, containers, params, variables, globals),
          ...policyIssues(nodes),
        ],
        nodeId,
        enclosingContainers(nodeId, containers),
      ).map((issue) => readableIssue(issue, nodes, edges, containers)),
    [nodes, edges, containers, params, variables, globals, nodeId],
  );

  // #1694 OR42 item 5 — the numbers' errors share one reserved line under the
  // fields, so the rows keep the dock's rhythm.
  const errors = useFieldErrorLine();

  function set(patch: Partial<NodePolicy>) {
    // Merged over the store's CURRENT policy, not this render's closure, so two
    // commits landing before a re-render cannot drop each other's key.
    const current = store.getState().nodes.find((n) => n.id === nodeId)?.policy;
    store.getState().setNodePolicy(nodeId, { ...current, ...patch });
  }

  return (
    <Section heading="Run policy" help={null}>
      {/* Three grids, not one: a wide dock packs three short cells to a row,
          which would put a flag beside the numbers. The section spaces them by the
          grid's own row gap, so the rhythm is the same either way. */}
      {timesOut && (
        <FieldGrid className="field-stack">
          <FieldCell span="short">
            <DraftNumberField
              label="Timeout"
              unit="seconds"
              stored={policy?.timeoutSeconds}
              parse={parseTimeoutSeconds}
              placeholder="none"
              about="Longest one attempt may run. On expiry the attempt is stopped and fails as a timeout, which Retries can retry, unless it may already have changed the store (a Script outside a transaction, a Copy whose rollback failed). A new activity starts with the workspace default from Settings. Blank sets no timeout."
              onCommit={(timeoutSeconds) => set({ timeoutSeconds })}
              errorLine={errors.node}
            />
          </FieldCell>
        </FieldGrid>
      )}
      <FieldGrid className="field-stack">
        <FieldCell span="short">
          <DraftNumberField
            label="Retries"
            stored={policy?.retry}
            parse={parseWholeNumber}
            placeholder="no retry"
            about="Times a transient failure, including a timeout, is retried after the first attempt. Work that may already have changed the store is never retried. 0 never retries; blank leaves it unset."
            onCommit={(retry) => set({ retry })}
            errorLine={errors.node}
          />
        </FieldCell>
        <FieldCell span="short">
          <DraftNumberField
            label="Retry interval"
            unit="seconds"
            stored={policy?.retryIntervalSeconds}
            parse={parseWholeNumber}
            placeholder={String(DEFAULT_RETRY_INTERVAL_SECONDS)}
            about={
              `Wait between attempts, ${DEFAULT_RETRY_INTERVAL_SECONDS}–${MAX_RETRY_INTERVAL_SECONDS}. ` +
              `Blank waits ${DEFAULT_RETRY_INTERVAL_SECONDS}s. A provider's Retry-After, when it ` +
              `sends one, is used instead (never less than ${DEFAULT_RETRY_INTERVAL_SECONDS}s).`
            }
            onCommit={(retryIntervalSeconds) => set({ retryIntervalSeconds })}
            errorLine={errors.node}
          />
        </FieldCell>
      </FieldGrid>
      <FieldGrid className="field-stack">
        <FieldCell span="short">
          <CheckboxField
            label="Secure input"
            name="Secure input"
            checked={policy?.secureInput === true}
            onChange={(on) => set({ secureInput: on || undefined })}
            about={`Keeps the resolved input out of the run log. ${WITHHOLDS}`}
          />
        </FieldCell>
        <FieldCell span="short">
          <CheckboxField
            label="Secure output"
            name="Secure output"
            checked={policy?.secureOutput === true}
            onChange={(on) => set({ secureOutput: on || undefined })}
            about={`Redacts the outputs before the run log; nothing downstream can reference them. ${WITHHOLDS}`}
          />
        </FieldCell>
      </FieldGrid>
      {!timesOut && policy?.timeoutSeconds !== undefined && (
        <Toolbar align="start">
          <button type="button" onClick={() => set({ timeoutSeconds: undefined })}>
            Remove the timeout
          </button>
        </Toolbar>
      )}
      {/* After the conditional button, so an empty line never sits above it. */}
      {errors.line}
      {/* Plain visible text, not a live region: recomputed state that changes as
          the author edits, and the dock header's status line already announces the
          save being blocked (#1249's one-announcer concern). */}
      {issues.length > 0 && (
        <ul className="contract-advisory">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}
