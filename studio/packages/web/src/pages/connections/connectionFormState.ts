import {
  CONNECTION_KINDS,
  connectionConfigSchema,
  type ConnectionKind,
  type ConnectionPublic,
} from '@autonomy-studio/shared';
import {
  deriveFieldsWithCarried,
  payloadSignature,
  saveableConfigOf,
  seedFieldInputs,
  type ConfigField,
  type FieldInput,
} from '../pipeline/configForm';

/*
 * #1477 — the connection form's draft state and the helpers that build it,
 * shared by Manage → Connections and the editor's New connection column, so a
 * connection is created through one form everywhere.
 */

const KINDS = CONNECTION_KINDS;

export type FormState = {
  id: string | null; // null = creating, otherwise editing this connection
  name: string;
  kind: ConnectionKind;
  /**
   * The AUTHORITATIVE config. The two drafts below are what the operator is
   * typing into; each mode change reads its draft back into here, so there is
   * always exactly one answer to "what would Save write".
   */
  config: Record<string, unknown>;
  /** One control value per derived field — the field-mode draft. */
  inputs: Record<string, FieldInput>;
  /** The whole-config JSON draft. */
  jsonText: string;
  /** Whether the operator ASKED for JSON. An unrenderable value forces it too. */
  jsonMode: boolean;
  secret: string;
  /** #1305 — the `parameters` override allowlist being edited. */
  parameters: string[];
  /**
   * The allowlist as the form opened on it. Save sends `parameters` only when
   * the edit differs from this (`allowlistChanged`), because an explicit list
   * REPLACES the stored one — a rename must never touch it.
   */
  parametersSeed: readonly string[];
};

/**
 * The controls for this kind's config, plus any key CARRIED over from another
 * kind. The rule itself lives in `configForm.ts` — datasets need the identical
 * one (#1115), and a second copy is how the halves drift apart. What is local
 * here is only which kind list and which schema lookup to ask it about.
 */
export function connectionFields(
  kind: ConnectionKind,
  config: Record<string, unknown>,
): { fields: ConfigField[]; carried: string[] } {
  return deriveFieldsWithCarried(KINDS, connectionConfigSchema, kind, config);
}

function formFor(
  id: string | null,
  name: string,
  kind: ConnectionKind,
  config: Record<string, unknown>,
  parameters: readonly string[],
): FormState {
  const { fields } = connectionFields(kind, config);
  return {
    id,
    name,
    kind,
    config,
    inputs: seedFieldInputs(fields, config),
    jsonText: JSON.stringify(config, null, 2),
    jsonMode: false,
    secret: '', // never prefilled — secrets are write-only, blank = keep existing
    // Deduped: the server stores the list as written, so a stored `['a', 'a']`
    // is possible, and an edit should not write the duplicate back.
    parameters: [...new Set(parameters)],
    parametersSeed: parameters,
  };
}

/** #1477 — a new connection's form opens for the kind picked in the gallery. */
export function blankForm(kind: ConnectionKind): FormState {
  return formFor(null, '', kind, {}, []);
}

export function formForEdit(conn: ConnectionPublic): FormState {
  return formFor(conn.id, conn.name, conn.kind, conn.config, conn.parameters);
}

/**
 * #1396 — what Save would write, as one comparable string: the guard's
 * "is this form dirty?" is this against the value taken when the form opened.
 * The config is the one the editor is showing (`saveableConfigOf`). A typed
 * secret always counts. The allowlist is compared as a set, because Save
 * sends it as one (`allowlistChanged`).
 */
export function savePayloadSignature(form: FormState): string {
  return payloadSignature([
    form.name,
    form.kind,
    saveableConfigOf(form, connectionFields),
    form.secret,
    [...form.parameters].sort(),
  ]);
}
