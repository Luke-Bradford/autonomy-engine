import {
  connectionNotReadyReason,
  deriveSecretStatus,
  type ConnectionKind,
  type ConnectionPublic,
} from '@autonomy-studio/shared';
import { formatNameList, type DependencyCheck } from './dependencyCheck';

/**
 * #1211 — which enabled TRIGGERS a connection edit would switch off, said at the
 * point of the edit.
 *
 * THE DEFECT, and it is a state change rather than a diagnostic. `routes/
 * connections.ts` runs `regateTriggersForConnection` on two paths: a `kind`
 * PATCH that leaves the connection `needs_secret`, and a DELETE (dependents fold
 * to `missing`). Both DISABLE every dependent enabled trigger, in the same
 * transaction, so an `enabled` flag can never outlive the connection's
 * readiness. That is correct (#3 G8b-2) and it is entirely silent — an operator
 * can change a connection's kind and stop a nightly schedule without ever
 * seeing a word about it, before or after.
 *
 * This is the trigger half of #1174's "say what this edit breaks, at the point
 * of the edit". The dataset half (`strandedDatasets.ts`) is ADVISORY about a
 * future dispatch failure; this one describes a write the server performs
 * immediately, which is the stronger claim on the operator's attention and is
 * why it is worded as a consequence rather than a risk.
 *
 * STILL ADVISORY, NEVER A GATE, and that polarity is deliberate rather than
 * inherited. #1145/#1158/#1174 all set it for the same stated reason — the
 * server accepts these writes and a form must not refuse what the server
 * accepts. Save gains no confirmation dialog either: Delete already has one
 * because it destroys a row, whereas a kind change is RECOVERABLE — but note
 * "recoverable" is not "reversible", which is the whole reason the sentence
 * NAMES the triggers. `regateTriggersForConnection` is documented ENABLED-ONLY
 * and "never re-enabled": supplying the secret afterwards makes the CONNECTION
 * ready again and leaves every disabled trigger off until the operator turns
 * each back on by hand. If the note only counted them, the information needed to
 * do that would be gone the moment the form closed.
 *
 * NOT COMPUTABLE CLIENT-SIDE, unlike the dataset half — see
 * `api/connections.ts`'s `listConnectionDependents` and the shared
 * `ConnectionDependentsResponseSchema` for why the reverse edge needs a route.
 *
 * WHAT THIS SLICE DOES NOT COVER, stated so its silence is not read as "nothing
 * breaks": a pipeline NODE bound to this connection whose KIND stops matching
 * fails at dispatch with `CONNECTION_KIND_INVALID`, and kind-validity is
 * deliberately outside readiness (`run/connection-readiness.ts`), so the reverse
 * gate never fires for it and no trigger is disabled — the schedule stays
 * enabled and fails forever instead. That is the worse silence, and #1252 says
 * it in its own note (`dependentNodes.ts`) over M9's candidate versions. The
 * sentences below therefore speak only about triggers being DISABLED, and
 * claim nothing wider.
 */

/**
 * The completed read carries TWO lists, and the second is what stops an empty
 * first one from being rendered as silence: a trigger whose bound version
 * reaches connections through a `${}` expression may well address this one, but
 * only dispatch can say. The readiness scan skips such a reference (correct — it
 * cannot be resolved statically, so the reverse gate never disables it); a
 * SURFACE that inherited that skip would answer "nothing would be disabled"
 * confidently and wrongly.
 */
export type TriggerCheck = DependencyCheck<{
  readonly names: readonly string[];
  readonly dynamicNames: readonly string[];
}>;

/**
 * Would saving this form's `kind` cross the ready→unready boundary that makes
 * the server disable dependents?
 *
 * Runs the SERVER'S OWN predicates rather than re-spelling their rule —
 * `deriveSecretStatus` and `connectionNotReadyReason` moved into
 * `@autonomy-studio/shared` in this ticket for exactly this call, so the form
 * cannot fall quiet about a disable the server still performs. Both halves
 * matter: the `enabled` axis is currently unreachable from this form, and a
 * hand-written `connectionKindRequiresSecret(next) && !hasSecret` would have
 * been accidentally right rather than right.
 *
 * ALREADY-UNREADY IS NOT A TRANSITION. The regate is idempotent and
 * enabled-only, so a connection that is already `needs_secret` has no enabled
 * dependents left to disable; warning there would describe a write that does
 * nothing.
 *
 * `typedSecret` is tested with `!== ''` and deliberately NOT trimmed, because
 * that is the exact condition the submit path uses (`ConnectionsPage.tsx` sends
 * `form.secret !== '' ? { secret: form.secret } : {}`) and the server accepts
 * (`ConnectionWriteBodySchema`'s `z.string().min(1)` does not trim either). A
 * whitespace-only secret is therefore stored as a real secret and leaves the
 * connection READY — so trimming here would predict a disable that does not
 * happen. Mirroring the write is the point; a tidier-looking rule that the save
 * path does not share is exactly the drift this module was moved to shared to
 * avoid.
 *
 * THE ONE INEXACTNESS, and it over-warns rather than under-warns.
 * `ConnectionPublicSchema` omits `secretRef`, so where the stored kind is
 * credential-less (`secretStatus: 'not_required'`) this cannot see whether a
 * stray ref survives from an earlier secret-requiring kind — `deriveSecretStatus`
 * ignores a stray ref for such a kind by design. On that one path the note
 * appears and the save then disables nothing. Speaking when it need not is the
 * safe direction for an advisory; staying silent when it should speak is the
 * failure this module exists to prevent.
 */
export function kindChangeDisablesTriggers(
  stored: ConnectionPublic,
  nextKind: ConnectionKind,
  typedSecret: string,
): boolean {
  if (connectionNotReadyReason(stored) !== null) return false;
  const secretRefAfterSave =
    typedSecret !== '' || stored.secretStatus === 'ready' ? 'present' : null;
  return (
    connectionNotReadyReason({
      enabled: stored.enabled,
      secretStatus: deriveSecretStatus(nextKind, secretRefAfterSave),
    }) !== null
  );
}

/** `1 enabled trigger (nightly)` / `2 enabled triggers (a, b)` — agreeing in number. */
function triggerPhrase(names: readonly string[]): string {
  const noun = names.length === 1 ? 'enabled trigger' : 'enabled triggers';
  return `${names.length} ${noun} (${formatNameList(names)})`;
}

/**
 * The clause naming triggers whose dependency only dispatch can settle. Empty
 * for an empty list, so both callers can append it unconditionally.
 */
function dynamicClause(dynamicNames: readonly string[], alsoNamed: boolean): string {
  if (dynamicNames.length === 0) return '';
  const verb = dynamicNames.length === 1 ? 'chooses' : 'choose';
  const noun = dynamicNames.length === 1 ? 'enabled trigger' : 'enabled triggers';
  // "other" only when a named set precedes it in the same sentence — on its own
  // it would contrast with nothing.
  const qualifier = alsoNamed ? 'other ' : '';
  return ` ${dynamicNames.length} ${qualifier}${noun} (${formatNameList(dynamicNames)}) ${verb} a connection at run time, so only a run can say whether this affects them.`;
}

/**
 * The note the edit form draws when the Kind select has moved off the stored
 * kind AND that change would cross the readiness boundary. `null` means there is
 * nothing to say — reached ONLY from a completed read with no dependents and no
 * dynamic references, never from a read that failed or is still in flight.
 */
export function triggerDisableAdvisory(check: TriggerCheck): string | null {
  switch (check.state) {
    case 'loading':
      return 'Still checking which enabled triggers this would switch off.';
    case 'unavailable':
      return `Could not check which enabled triggers depend on this connection (${check.detail}) — saving may switch some off.`;
    case 'known': {
      if (check.names.length === 0) {
        return check.dynamicNames.length === 0
          ? null
          : dynamicClause(check.dynamicNames, false).trim();
      }
      return `Saving this switches off ${triggerPhrase(check.names)} — supplying a secret later makes the connection ready again but does NOT re-enable them, so you would turn each back on by hand.${dynamicClause(check.dynamicNames, true)}`;
    }
  }
}

/**
 * The trigger clause of the delete confirm, appended to
 * `strandedDatasets.ts`'s dataset sentence. Empty string ONLY on an earned
 * empty, so the caller can concatenate without deciding anything itself.
 */
export function deleteConfirmTriggerClause(check: TriggerCheck): string {
  switch (check.state) {
    case 'loading':
      return 'Still checking which enabled triggers depend on it — any that do will be switched off.';
    case 'unavailable':
      return `Could not check which enabled triggers depend on it (${check.detail}) — any that do will be switched off.`;
    case 'known': {
      if (check.names.length === 0) {
        return check.dynamicNames.length === 0
          ? ''
          : dynamicClause(check.dynamicNames, false).trim();
      }
      return `Deleting it also switches off ${triggerPhrase(check.names)}, and they stay off until you re-enable each one.${dynamicClause(check.dynamicNames, true)}`;
    }
  }
}
