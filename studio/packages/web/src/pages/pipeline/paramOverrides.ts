import {
  connectionConfigSchema,
  datasetConfigSchema,
  firstParamOverrideViolation,
  isNonOverridableConnectionConfigKey,
  isNonOverridableDatasetConfigKey,
  type ConnectionKind,
  type ConnectionPublic,
  type Dataset,
  type DatasetKind,
  type ParamOverrideViolation,
  type ParamType,
} from '@autonomy-studio/shared';
import { deriveConfigFields, type ConfigField, type ConfigFieldKind } from './configForm';
import { isExpressionText } from './callRules';
import { coerceDefaultInput } from './paramRules';

/**
 * #1304 — the rules behind a node's per-dispatch parameter overrides
 * (`Node.connectionParams`, `Node.datasetParams.{source,sink}`), kept pure so the
 * editor only renders them.
 *
 * **Why the editor has to know the gate.** The save gate never reads a
 * resource's `parameters` allowlist. `validateDoc` checks only the shape and the
 * binding, and `validateRefs` checks the `${}` refs. The allowlist, the
 * non-overridable keys and the secret-marker refusal are applied at DISPATCH
 * (`executor.ts`, through `firstParamOverrideViolation`). A refused override
 * therefore saves cleanly and fails only when the pipeline runs. The editor calls
 * that same shared function per row, so the refusal shows up while the operator
 * is still writing the override.
 */

/** One overridable resource, as the editor needs it: the gate's inputs plus the kind's controls. */
export type OverrideResource = {
  noun: 'connection' | 'dataset';
  name: string;
  kind: string;
  allowlist: readonly string[];
  /** The resource's stored config — a new row starts from its value for the key. */
  config: Readonly<Record<string, unknown>>;
  /** The kind's schema-derived keys, which say what type each override must be. */
  fields: readonly ConfigField[];
  isNonOverridable: (key: string) => boolean;
};

/** What a KIND alone decides about overrides: its schema's keys and its security-boundary keys. */
export type KindOverrideRules = Pick<OverrideResource, 'fields' | 'isNonOverridable'>;

/**
 * The kind half of an override resource, shared with the resource pages'
 * allowlist editor (#1305) so both read one derivation. It is the KIND's own
 * schema, never a form's field list, which also carries keys left from another
 * kind (`deriveFieldsWithCarried`).
 */
export function connectionKindOverrideRules(kind: ConnectionKind): KindOverrideRules {
  return {
    fields: deriveConfigFields(connectionConfigSchema(kind)) ?? [],
    isNonOverridable: (key) => isNonOverridableConnectionConfigKey(kind, key),
  };
}

export function datasetKindOverrideRules(kind: DatasetKind): KindOverrideRules {
  return {
    fields: deriveConfigFields(datasetConfigSchema(kind)) ?? [],
    isNonOverridable: (key) => isNonOverridableDatasetConfigKey(kind, key),
  };
}

export function connectionOverrideResource(c: ConnectionPublic): OverrideResource {
  return {
    noun: 'connection',
    name: c.name,
    kind: c.kind,
    allowlist: c.parameters,
    config: c.config,
    ...connectionKindOverrideRules(c.kind),
  };
}

export function datasetOverrideResource(d: Dataset): OverrideResource {
  return {
    noun: 'dataset',
    name: d.name,
    kind: d.kind,
    allowlist: d.parameters,
    config: d.config,
    ...datasetKindOverrideRules(d.kind),
  };
}

/**
 * Keys a kind has that no dispatch refuses by construction: its schema-derived
 * fields minus its security-boundary keys. The ONE rule behind both the canvas
 * Add control and the resource pages' allowlist editor (#1305), so the pages can
 * never offer a key the canvas would then refuse to add.
 */
export function overridableKeys(
  fields: readonly ConfigField[],
  isNonOverridable: (key: string) => boolean,
): string[] {
  return fields.map((f) => f.name).filter((k) => !isNonOverridable(k));
}

function usableKeys(r: OverrideResource): string[] {
  return overridableKeys(r.fields, r.isNonOverridable);
}

/** The note for a KIND with no overridable settings at all — which no allowlist edit can change. */
export function noOverridableSettingsNote(kind: string, noun: OverrideResource['noun']): string {
  return `A ${kind} ${noun} has no settings a node can override.`;
}

/**
 * The keys the Add control may offer: declared by the owner, present in the
 * kind's schema, not a security-boundary key, and not already overridden.
 *
 * Filtering by the SCHEMA as well as the allowlist is what keeps Add from
 * offering a key the executor's merged-config re-validation refuses. An
 * allowlist is a plain list of names and can hold a key the kind does not have.
 */
export function addableKeys(
  r: OverrideResource,
  current: Readonly<Record<string, unknown>>,
): string[] {
  const usable = new Set(usableKeys(r));
  return r.allowlist.filter((k) => usable.has(k) && !Object.hasOwn(current, k));
}

/**
 * Why there is nothing to add, when that needs saying. The three causes need
 * different fixes, so the note names the actual one:
 *  - the KIND has no overridable settings at all (`table`, `sqlite`), which no
 *    allowlist edit can change;
 *  - the owner declared nothing;
 *  - the owner declared only keys this kind cannot take.
 * `null` when Add has something to offer, or when every usable declared key is
 * already overridden (the rows are the explanation).
 */
export function overrideNote(
  r: OverrideResource,
  current: Readonly<Record<string, unknown>>,
): string | null {
  if (addableKeys(r, current).length > 0) return null;
  const usable = usableKeys(r);
  if (usable.length === 0) {
    return noOverridableSettingsNote(r.kind, r.noun);
  }
  if (r.allowlist.length === 0) {
    return `${r.name} declares no overridable settings, so there is nothing to override here.`;
  }
  if (r.allowlist.some((k) => usable.includes(k))) return null;
  return `${r.name}'s declared parameters name no setting a ${r.kind} ${r.noun} can override.`;
}

/**
 * The type a row's TEXT is read as, from the control kind the config form
 * already derives for that key. Structured kinds are authored as JSON text,
 * which is also how a query dataset's bind `parameters` record is entered.
 */
function paramTypeFor(kind: ConfigFieldKind): ParamType {
  switch (kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
    case 'stringList':
    case 'objectList':
    case 'keyValue':
      return 'json';
    case 'text':
    case 'enum':
      return 'string';
  }
}

/** Whether a row's text must be ONE value — a whole `${}` or a literal, never a splice. */
export function takesWholeValue(field: ConfigField | undefined): boolean {
  return field !== undefined && paramTypeFor(field.kind) !== 'string';
}

/**
 * A row's text → the value stored in the node.
 *
 * Reuses `coerceDefaultInput`, the coercion the call editor and the params
 * editor already share. A whole `${}` is stored verbatim, as `buildParams` does,
 * because its value takes its type at dispatch.
 *
 * Text that does not parse is stored AS TYPED rather than dropped. The row stays
 * on screen with its flag (`overrideRowProblem`) and the operator's draft is not
 * lost. The value can never reach a run, because dispatch re-validates the
 * merged config against the kind's schema.
 */
export function coerceOverride(field: ConfigField | undefined, text: string): unknown {
  if (isExpressionText(text)) return text.trim();
  if (field === undefined) return text;
  const type = paramTypeFor(field.kind);
  if (type === 'string') return text;
  const parsed = coerceDefaultInput(type, text);
  return parsed.ok && parsed.has ? parsed.value : text;
}

function violationMessage(r: OverrideResource, v: ParamOverrideViolation): string {
  switch (v.reason) {
    case 'non_overridable':
      return `A ${r.kind} ${r.noun}'s \`${v.key}\` can never be overridden. Remove this row.`;
    case 'undeclared':
      return `${r.name} does not declare \`${v.key}\` as overridable, so a run will refuse it.`;
    case 'secret_marker':
      return `\`${v.key}\` holds a secret reference, which an override may not carry, so a run will refuse it.`;
  }
}

function typeProblem(field: ConfigField, value: unknown): string | null {
  if (typeof value === 'string' && isExpressionText(value)) return null;
  switch (paramTypeFor(field.kind)) {
    case 'number':
      return typeof value === 'number' ? null : 'must be a number or a whole ${…} expression';
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : "must be 'true', 'false' or a whole ${…} expression";
    case 'json':
      return typeof value === 'string' ? 'must be valid JSON or a whole ${…} expression' : null;
    default:
      if (typeof value !== 'string') return 'must be text';
      if (field.kind === 'enum' && !(field.enumOptions ?? []).includes(value) && value !== '') {
        return `must be one of: ${(field.enumOptions ?? []).join(', ')}`;
      }
      return null;
  }
}

/**
 * What a run would refuse about this one row, or `null`. Checks the dispatch
 * gate first (in its own order), then whether the kind has the key at all (the
 * executor's merged-config re-validation), then the value's type.
 *
 * An EMPTY text value is flagged too, although nothing refuses it. It REPLACES
 * the resource's setting with `''`, which is not the same as leaving the setting
 * alone, and a blank row looks like leaving it alone.
 */
export function overrideRowProblem(
  r: OverrideResource,
  key: string,
  value: unknown,
): string | null {
  const violation = firstParamOverrideViolation({ [key]: value }, r);
  if (violation !== null) return violationMessage(r, violation);
  const field = r.fields.find((f) => f.name === key);
  if (field === undefined) {
    // Both dispatch gates refuse a key the kind lacks (#1306).
    return `A ${r.kind} ${r.noun} has no \`${key}\` setting, so a run will refuse it.`;
  }
  const typed = typeProblem(field, value);
  if (typed !== null) return `\`${key}\` ${typed}.`;
  // Reached only by a text/enum key: `typeProblem` has already refused `''` for
  // every other kind, with the more specific message.
  if (value === '') {
    return `An empty value replaces the ${r.noun}'s \`${key}\` with nothing. Remove the row to keep the ${r.noun}'s own setting.`;
  }
  return null;
}
