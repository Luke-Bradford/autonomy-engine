import type { ActiveVersionLabel } from '../pipeline/versionHistory';
import type { PublishState } from '../pipeline/publishState';

/**
 * #981 — what a trigger's binding control is currently set to.
 *
 * A discriminated union rather than the string field it replaced. The form used
 * to hold `pipelineVersionId: string` with `''` meaning unbound, and the obvious
 * way to add bind-to-active was a third sentinel like `active:<pipelineId>`.
 * That fails for a concrete reason, not a stylistic one: three other readers
 * treat that field as an id (the row label, the `'' -> null` coercion, and the
 * edit-form seed), ids are opaque by contract (`repo/ids.ts`: "callers must
 * never parse it back out"), and an IMPORTED pipeline's id is validated only as
 * a non-empty string — so nothing rules out a real id beginning `active:`.
 */
export type BindingSelection =
  | { kind: 'unbound' }
  | { kind: 'concrete'; pipelineVersionId: string }
  | { kind: 'active'; pipelineId: string };

/** The create-body fields a selection contributes. */
export interface BindingCreateFields {
  pipelineVersionId?: string | null;
  bindToActive?: { pipelineId: string };
}

/**
 * The ONE place a selection becomes wire fields, because the XOR that governs
 * them keys on PRESENCE rather than truthiness (`TriggerCreateBodySchema`).
 *
 * `bindToActive` therefore omits the `pipelineVersionId` KEY. Writing it as
 * `null` would look like the unbound case but reach the server as "both
 * supplied" — `JSON.stringify` drops `undefined` and keeps `null` — and 400.
 */
export function bindingCreateFields(selection: BindingSelection): BindingCreateFields {
  switch (selection.kind) {
    case 'unbound':
      return { pipelineVersionId: null };
    case 'concrete':
      return { pipelineVersionId: selection.pipelineVersionId };
    case 'active':
      return { bindToActive: { pipelineId: selection.pipelineId } };
  }
}

/**
 * The client mirror of the server's `assertBindableIfEnabled` ("an unbound
 * trigger never fires").
 *
 * Bind-to-active counts as BOUND even though the client holds no concrete id:
 * the route resolves the binding BEFORE it runs that assertion, so an enabled
 * bind-to-active create is legal. A mirror that keyed on "is there an id here"
 * would refuse a create the server accepts — which is how a courtesy check
 * turns into a bug.
 */
export function bindingIsBound(selection: BindingSelection): boolean {
  return selection.kind !== 'unbound';
}

/**
 * How the publish pair reads right now. `'loading'` and `'unread'` are kept
 * apart from a successful read for the #979 reason: collapsing either into
 * `{active: null}` would assert "this pipeline has never been published" on no
 * evidence.
 */
export type PublishReading = PublishState | 'loading' | 'unread';

export interface ActiveBindingAdvice {
  /** Prose shown beside the control. */
  text: string;
  /** Non-null = do not send the create; the reason names the act that clears it. */
  refusal: string | null;
}

/** Resolve-once is the whole semantic; every branch that binds says so. */
const SNAPSHOT = 'Resolved once, when the trigger is created — it does not follow later changes.';

/**
 * #981 — what to tell an operator who has chosen "the active published version",
 * and whether the create should be sent at all.
 *
 * The ticket asked whether the option should be DISABLED with a reason or
 * offered with a warning. It cannot be disabled honestly: knowing which
 * pipelines are bindable means one `/active` read per pipeline, up front, which
 * is the N+1 `listAllPipelineVersions` already documents on this page's other
 * load. So the option stays selectable and the SUBMIT carries the refusal —
 * the same end state as a disabled button whose reason names the act, reached
 * with one read instead of N.
 *
 * The refusal deliberately does not echo the server's message, which names an
 * internal DB id (the rule `describePublishRefusal` already follows).
 */
export function activeBindingAdvice(args: {
  pipelineName: string;
  reading: PublishReading;
  activeVersion: ActiveVersionLabel;
}): ActiveBindingAdvice {
  const { pipelineName, reading, activeVersion } = args;

  if (reading === 'loading') {
    return { text: 'Checking what this will bind to…', refusal: null };
  }
  if (reading === 'unread') {
    return {
      text:
        'Could not check what this will bind to. Creating the trigger is still allowed — ' +
        'the server resolves the binding and refuses if there is nothing to bind to.',
      refusal: null,
    };
  }

  if (!reading.gitConnected) {
    return {
      text:
        `No repository is connected to this workspace, so this binds to the latest saved ` +
        `version of "${pipelineName}". ${SNAPSHOT}`,
      refusal: null,
    };
  }

  if (reading.active === null) {
    /*
     * The prose stops at the alternative it can offer in place ("pick a version
     * directly"); the way to the OTHER remedy is a link the form renders after
     * this text, and only for this state. Naming the panel here too said it
     * twice — and this same string is also the SUBMIT refusal, where there is no
     * link, so it has to stand alone without repeating what one would say.
     */
    const reason =
      `"${pipelineName}" has no published version. This workspace is connected to a ` +
      `repository, so a trigger can only bind to a version you have published — publish ` +
      `one, or pick a version directly.`;
    return { text: reason, refusal: reason };
  }

  const named =
    activeVersion === 'unnamed' || activeVersion === null || activeVersion === undefined
      ? 'the version published most recently (minted after this page loaded, so it is not in the list above)'
      : `v${String(activeVersion)}`;
  return {
    text: `This binds to ${named}, the published version of "${pipelineName}". ${SNAPSHOT}`,
    refusal: null,
  };
}
