import type { z } from 'zod';
import { SecretRefSchema, llmMessagesSchema } from '@autonomy-studio/shared';

/**
 * The pure rules behind the per-activity node config form (U7).
 *
 * The form is DERIVED from each activity's Zod `configSchema` rather than from
 * hand-written field metadata on `ActivityCatalogEntry`. That schema is already
 * the single source of truth for an activity's authored shape — `agent-config.ts`
 * says so explicitly, and `httpSecretHeadersSchema` exists precisely to stop the
 * catalog and its adapter desyncing on one. A parallel `fields: [...]` list would
 * be a third copy of the same shape, free to drift the moment an activity gains a
 * setting. So this module is the ONE place that reads Zod's internals, kept pure
 * and exhaustively tested, where a Zod-major change fails loudly in unit tests
 * instead of silently rendering the wrong control.
 *
 * The division of labour with the SERVER matters and is deliberately narrow:
 * this form is a UX affordance, NOT a gate. Several activities' `configSchema` is
 * palette metadata whose real constraints live in `validateDoc` (`wait.seconds`
 * is a `z.string()` so it can hold a `${}` expression; `validateWaitConfig` is
 * what actually judges it). The panel's local `safeParse` only spares the author a
 * round-trip to a 400 they were going to get anyway. It must never present itself
 * as the authority, and it must never refuse to save something the server accepts.
 *
 * Two properties here are load-bearing against SILENT DATA LOSS:
 *
 *  - `assembleConfig` merges the form's keys over the ORIGINAL config and never
 *    stores a `safeParse` output. A plain `z.object` STRIPS unknown keys (verified
 *    against zod 4.4.3), so storing the parse result would drop `config.outputs`
 *    — the F13 contract `catalog/lower.ts` owns — along with any other key an
 *    API-authored or git-imported doc carries. Preserving every key the form does
 *    not own generalises the old `outputs` special case into one rule.
 *  - `formatFieldValue` REFUSES a stored value whose runtime type disagrees with
 *    its schema-derived control, rather than rendering it lossily. The kind comes
 *    from the schema; the value comes from the doc, and the two can legitimately
 *    disagree. Rendering `{a:1}` into a text box would apply back as the string
 *    "[object Object]" — a corruption caused by opening the panel, not by editing.
 */

/** The controls this form can render. Anything else authors as JSON. */
export type ConfigFieldKind =
  'text' | 'number' | 'boolean' | 'enum' | 'stringList' | 'json' | 'objectList' | 'keyValue';

/**
 * One row of an `objectList` control: the same cell-input map the top-level
 * form already holds, keyed by COLUMN name instead of by field name.
 *
 * Reusing that shape is what lets every cell run through `formatFieldValue` and
 * `parseFieldInput` unchanged — a row control is the existing form, repeated,
 * and none of the per-kind rules below had to be restated for a cell.
 */
export type ObjectListRow = Readonly<Record<string, string | boolean>>;

/** What one control holds. `objectList` and `keyValue` are the kinds that hold rows. */
export type FieldInput = string | boolean | readonly ObjectListRow[];

/**
 * Narrow a control value to a row list.
 *
 * `Array.isArray` is typed `(arg: any) => arg is any[]`, which does NOT remove a
 * `readonly T[]` member from the FALSE branch of a union — so the scalar paths
 * below would still see a possible array. This guard is what makes them total.
 */
export function isRowList(value: FieldInput | undefined): value is readonly ObjectListRow[] {
  return Array.isArray(value);
}

/** The kinds whose control holds a list of rows rather than one scalar. */
export function isRowKind(kind: ConfigFieldKind): kind is 'objectList' | 'keyValue' {
  return kind === 'objectList' || kind === 'keyValue';
}

/** A `keyValue` row's key cell, the same for both value shapes. */
const KEY_CELL = 'key';

/**
 * The two cells of a `keyValue` row. Both required: a row without a key has
 * nowhere to go in a record, and a secret row without a name is not a marker.
 * The second cell is called `secret name` rather than `secret` on purpose: a
 * box labelled "secret" invites pasting the credential itself, which would save
 * cleanly (the gate checks the marker's SHAPE only) and then sit in immutable
 * version history and git export.
 */
function keyValueCells(recordValue: 'text' | 'secret'): ConfigField[] {
  return [
    { name: KEY_CELL, kind: 'text', optional: false, literal: true },
    recordValue === 'secret'
      ? { name: 'secret name', kind: 'text', optional: false, literal: true }
      : { name: 'value', kind: 'text', optional: false },
  ];
}

/** The name of a `keyValue` row's value cell. */
function valueCell(field: ConfigField): string {
  return field.elementFields?.[1]?.name ?? 'value';
}

/**
 * A `keyValue` field's rows as the record they stand for.
 *
 * STRICT (an apply) refuses a row with no key, a duplicate key — which would
 * otherwise silently overwrite the earlier row's value — and a secret row with
 * no name. LENIENT is the expression flyout's candidate placement: a draft row
 * is routinely half-filled, so nothing is refused, but the row being PROBED
 * (`keep`) is always placed and wins a duplicate. Skipping it would hand the
 * validator a candidate without the cell under test, and every reference would
 * then be offered — including ones the save gate refuses.
 *
 * Built with `Object.fromEntries`, which defines each key as an OWN property, so
 * a `__proto__` key is data rather than a prototype assignment.
 */
export function rowsToRecord(
  field: ConfigField,
  rows: readonly ObjectListRow[],
  mode: { strict: true } | { strict: false; keep: number },
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const secret = field.recordValue === 'secret';
  const second = valueCell(field);
  const entries: [string, unknown][] = [];
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const key = typeof row[KEY_CELL] === 'string' ? row[KEY_CELL] : '';
    const held = typeof row[second] === 'string' ? row[second] : '';
    const keep = !mode.strict && index === mode.keep;
    if (mode.strict) {
      if (key === '') return { ok: false, message: `row ${index + 1} key: required` };
      if (seen.has(key)) return { ok: false, message: `row ${index + 1}: duplicate key '${key}'` };
      if (secret && held === '') {
        return { ok: false, message: `row ${index + 1} ${second}: required` };
      }
    } else if (key === '' && !keep) {
      continue;
    }
    // Lenient mode can build `{ $secret: '' }` for a half-filled secret row. It is
    // a flyout candidate only, and no secret-row cell is offered the flyout (both
    // are `literal`), so it never reaches the validator; the apply is strict.
    const value = secret ? { $secret: held } : held;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      // Lenient only — strict returned above. The probed row wins its key.
      if (keep) entries[earlier] = [key, value];
      continue;
    }
    seen.set(key, entries.length);
    entries.push([key, value]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

/**
 * The config value a row field would hold with one cell replaced — the
 * expression flyout's CANDIDATE for that cell (#1178). A row list is read by
 * `parseRowCells`, keeping the cells that parse; a `keyValue` field stores a
 * RECORD, so its candidate is one too, read leniently with the probed row
 * always placed (`rowsToRecord`).
 */
export function placeRowCandidate(
  field: ConfigField,
  rows: readonly ObjectListRow[],
  index: number,
  cell: string,
  value: string,
): unknown {
  const probed = rows.map((row, i) => (i === index ? { ...row, [cell]: value } : row));
  if (field.kind === 'keyValue') {
    // Lenient mode never refuses; the `ok` check only narrows the type.
    const record = rowsToRecord(field, probed, { strict: false, keep: index });
    return record.ok ? record.value : {};
  }
  const cells = field.elementFields ?? [];
  return probed.map((row) => parseRowCells(cells, row).value);
}

/** One derived control: a config key, and how to author it. */
export interface ConfigField {
  readonly name: string;
  readonly kind: ConfigFieldKind;
  /** Whether the key may be ABSENT (optional / defaulted), not whether it may be empty. */
  readonly optional: boolean;
  /** The permitted values, for `kind: 'enum'` only. */
  readonly enumOptions?: readonly string[];
  /** A defaulted key's default, offered as a placeholder — never written in. */
  readonly defaultText?: string;
  /** The per-column controls, for `kind: 'objectList'` and `kind: 'keyValue'`. */
  readonly elementFields?: readonly ConfigField[];
  /**
   * What a `keyValue` row's second cell holds (#852 item 2): a plain string, or
   * the NAME of a secret, which is written back as the inert `{$secret:name}`
   * marker (`shared/schemas/secret-ref.ts`).
   */
  readonly recordValue?: 'text' | 'secret';
  /**
   * A cell whose text is never substituted, so the expression flyout must not
   * be offered on it. A record KEY is copied verbatim by `substitute`, and a
   * `$secret` name may not hold a `${}` at all — the whole-doc validator cannot
   * see the first (it never scans keys), so offering there would be the false
   * offer the flyout exists to avoid.
   */
  readonly literal?: true;
}

/**
 * The value an EMPTY control holds, per kind.
 *
 * One exported rule rather than the `field.kind === 'boolean' ? false : ''`
 * written longhand at every seed, fallback and render site: `objectList` made
 * that ternary wrong in six places at once, and a single one of them missed
 * would hand a row control the string `''` and render nothing.
 */
export function emptyControlValue(field: ConfigField): FieldInput {
  if (isRowKind(field.kind)) return [];
  return field.kind === 'boolean' ? false : '';
}

/**
 * Whether two control values are the same value.
 *
 * `===` was total while every control held a `string` or a `boolean`. A row
 * list is an ARRAY, so identity comparison says "different" on every render —
 * which would defeat `assembleConfig`'s clearing-gesture rule (a stored empty
 * list would be deleted by an apply that touched a different field) and would
 * spin `ContainerPanel`'s set-state-during-render seed compare.
 */
export function sameControlValue(a: FieldInput | undefined, b: FieldInput | undefined): boolean {
  if (isRowList(a) && isRowList(b)) {
    return (
      a.length === b.length &&
      a.every((row, i) => {
        const other = b[i] as ObjectListRow;
        const keys = Object.keys(row);
        return keys.length === Object.keys(other).length && keys.every((k) => row[k] === other[k]);
      })
    );
  }
  return a === b;
}

/** A stored value rendered into its control, or a refusal to render it at all. */
export type FieldRender = { ok: true; value: FieldInput } | { ok: false; reason: string };

/** A control's input read back out: a value, an instruction to drop the key, or a refusal. */
export type FieldParse =
  | { ok: true; omit: true }
  | { ok: true; omit: false; value: unknown }
  | { ok: false; message: string };

/** The assembled config, plus the schema-declared subset to validate on its own. */
export type AssembleResult =
  | { ok: true; config: Record<string, unknown>; owned: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * The shape of a Zod v4 internal definition, as far as this module reads it.
 *
 * Declared structurally and read through `defOf` so that EVERY access to Zod's
 * internals is funnelled through one cast in one file. `z.ZodType` erases the
 * concrete subclass, so there is no public API that answers "what construct is
 * this" for an arbitrary schema — but the discriminants below are stable v4
 * surface (`.def.type`, `.shape`, `.options`, `.element`).
 */
interface ZodDefLike {
  readonly type?: string;
  readonly innerType?: unknown;
  readonly defaultValue?: unknown;
}

function defOf(schema: unknown): ZodDefLike | null {
  const def = (schema as { def?: unknown } | null | undefined)?.def;
  return typeof def === 'object' && def !== null ? (def as ZodDefLike) : null;
}

/**
 * Wrappers that make a key ABSENT-able. `nullable` is deliberately NOT here: it
 * permits the VALUE `null`, which is not the same as omitting the key, and
 * labelling such a field "optional" would be a lie the author acts on.
 */
const ABSENTABLE_WRAPPERS = new Set(['optional', 'default', 'prefault', 'nullish']);
/** Wrappers to see through without changing whether the key may be absent. */
const TRANSPARENT_WRAPPERS = new Set(['nullable', 'readonly', 'catch', 'lazy', 'pipe']);

interface Unwrapped {
  readonly inner: unknown;
  readonly optional: boolean;
  readonly defaultText?: string;
}

/** Peel the wrappers off a field schema, recording whether the key may be absent. */
function unwrap(schema: unknown): Unwrapped {
  let inner = schema;
  let optional = false;
  let defaultText: string | undefined;

  // Bounded: each step consumes one wrapper, and a schema nests finitely many.
  for (let depth = 0; depth < 16; depth += 1) {
    const def = defOf(inner);
    const type = def?.type;
    if (type === undefined) break;
    if (!ABSENTABLE_WRAPPERS.has(type) && !TRANSPARENT_WRAPPERS.has(type)) break;
    if (ABSENTABLE_WRAPPERS.has(type)) optional = true;
    if (defaultText === undefined && def?.defaultValue !== undefined) {
      // Zod has carried this as both a value and a thunk across releases.
      const raw = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      defaultText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    if (def?.innerType === undefined) break;
    inner = def.innerType;
  }

  return { inner, optional, defaultText };
}

/**
 * The per-column controls for an `objectList`'s element, or `null` when the
 * element is not one this control may render.
 *
 * The gate is STRICTNESS, and it is derived rather than listed. A row control
 * renders exactly the columns the element declares, so an OPEN element permits
 * keys it would not show — and a control that silently drops what it cannot see
 * is the loss `formatFieldValue`'s refusals exist to prevent. Reading
 * `def.catchall` is one more discriminant through the same `defOf` funnel. There
 * is exactly ONE exception, keyed on a shared schema's identity rather than on a
 * field name (`messages`, below); it is not the start of a per-activity list, and
 * a second one should be argued as hard as the first was.
 *
 * It is also what keeps `llm_call.history` off this control, correctly. It is
 * typed `z.array(...)` but `validateDoc` refuses any non-string value — "history
 * must be a whole-value ${...} expression" (`engine/params.ts`) — so in every
 * valid doc it holds a STRING. Classified as a row list it would be
 * unrenderable, and ONE unrenderable field puts the whole node in the JSON
 * editor: this ticket's own defect, on the most-used activity in the catalog.
 *
 * `messages` shares that open element but NOT that rule, so it is admitted by
 * IDENTITY with `llmMessagesSchema` (`waived`), the same way `SecretRefSchema`
 * is recognised below (#852 item 3). Making the shared element `.strict()`
 * instead would change what dispatch accepts for `history`, a runtime change a
 * form has no business making. Waiving the gate leaves the VALUE guard in
 * `formatFieldValue`, which refuses any stored row holding an undeclared key —
 * so a message carrying one still opens in the JSON editor, unaltered.
 */
function deriveElementFields(element: unknown, waived = false): ConfigField[] | null {
  const def = defOf(element);
  if (def?.type !== 'object') return null;
  // `.strict()` and nothing else: a `z.object` with no catchall carries
  // `undefined` here, `.catchall(z.string())` a string schema, `.strict()` a
  // `never` one. Verified against the built catalog (zod 4.4.3).
  if (!waived && defOf((def as { catchall?: unknown }).catchall)?.type !== 'never') return null;
  const shape = (element as { shape?: unknown }).shape;
  if (typeof shape !== 'object' || shape === null) return null;

  const cells: ConfigField[] = [];
  for (const [name, cellSchema] of Object.entries(shape as Record<string, unknown>)) {
    const { inner, optional, defaultText } = unwrap(cellSchema);
    // Classified WITHOUT recursion: a cell that is itself a row list or a
    // one-per-line list degrades the whole field to JSON rather than nesting.
    // Neither has a designed shape inside a row card, and `stringList`'s
    // newlines are structural, so a row of them cannot be read back honestly.
    //
    // The `nestable: false` argument is ALSO what bounds the recursion, and it
    // is the only thing that does: `classify(inner, false)` cannot re-enter this
    // function, whatever the schema's shape. (An earlier version of this comment
    // credited `unwrap` seeing through `lazy` instead. It does not — zod v4's
    // `ZodLazy` holds its target under `def.getter`, not `def.innerType`, so
    // `unwrap` breaks on it and a lazy field simply classifies `json`. Right
    // conclusion, wrong reason, and the wrong reason is the dangerous half:
    // acting on it, someone could teach `unwrap` to follow `getter` believing
    // recursion was already handled elsewhere.)
    const { kind, enumOptions } = classify(inner, false);
    if (isRowKind(kind) || kind === 'stringList') return null;
    cells.push({
      name,
      kind,
      optional,
      ...(enumOptions && { enumOptions }),
      ...(defaultText !== undefined && { defaultText }),
    });
  }
  // An element declaring no columns has no control to render.
  return cells.length > 0 ? cells : null;
}

/** Which control an unwrapped field schema gets. Unknown constructs author as JSON. */
function classify(
  schema: unknown,
  nestable: boolean,
): Pick<ConfigField, 'kind' | 'enumOptions' | 'elementFields' | 'recordValue'> {
  switch (defOf(schema)?.type) {
    case 'record': {
      // A record inside a row stays a JSON cell: rows do not nest.
      if (!nestable) return { kind: 'json' };
      const def = defOf(schema) as { keyType?: unknown; valueType?: unknown };
      // Only a free STRING key can be typed into a key cell. An enum key (and
      // `partialRecord`, which is a record over one) constrains the key set,
      // which a free-text cell would not honour.
      if (defOf(unwrap(def.keyType).inner)?.type !== 'string') return { kind: 'json' };
      const value = unwrap(def.valueType).inner;
      // IDENTITY with the shared marker schema, not a structural guess: a
      // lookalike falls to JSON, which is the safe direction — a secret row
      // writing the wrong shape would be a marker the gate refuses at best.
      const recordValue =
        value === SecretRefSchema ? 'secret' : defOf(value)?.type === 'string' ? 'text' : null;
      return recordValue === null
        ? { kind: 'json' }
        : { kind: 'keyValue', recordValue, elementFields: keyValueCells(recordValue) };
    }
    case 'string':
      return { kind: 'text' };
    case 'number':
    case 'int':
      return { kind: 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'enum': {
      const options = (schema as { options?: unknown }).options;
      // A non-string enum has no `<select>` this form can build honestly.
      return Array.isArray(options) && options.every((o) => typeof o === 'string')
        ? { kind: 'enum', enumOptions: options as string[] }
        : { kind: 'json' };
    }
    case 'array': {
      const element = unwrap((schema as { element?: unknown }).element).inner;
      if (defOf(element)?.type === 'string') return { kind: 'stringList' };
      if (!nestable) {
        // Depth-1: the CALLER only needs to know this would be a row list, so
        // that it can degrade. Deriving its columns would be the recursion the
        // one-level rule refuses.
        return { kind: defOf(element)?.type === 'object' ? 'objectList' : 'json' };
      }
      const elementFields = deriveElementFields(element, schema === llmMessagesSchema);
      return elementFields ? { kind: 'objectList', elementFields } : { kind: 'json' };
    }
    default:
      return { kind: 'json' };
  }
}

/**
 * The controls for one activity's config, or `null` when the schema is not
 * object-rooted.
 *
 * `null` is FAIL-SAFE, and the distinction matters: an unrecognised FIELD
 * degrades to a JSON control (the key is still authorable), but an unrecognised
 * ROOT yields no form at all, so the caller falls back to the whole-config JSON
 * editor. A partial form built from a root this module misread would silently
 * drop the keys it failed to see.
 */
export function deriveConfigFields(schema: z.ZodType): ConfigField[] | null {
  if (defOf(schema)?.type !== 'object') return null;
  const shape = (schema as unknown as { shape?: unknown }).shape;
  if (typeof shape !== 'object' || shape === null) return null;

  return Object.entries(shape as Record<string, unknown>).map(([name, fieldSchema]) => {
    const { inner, optional, defaultText } = unwrap(fieldSchema);
    const { kind, enumOptions, elementFields, recordValue } = classify(inner, true);
    return {
      name,
      kind,
      optional,
      ...(enumOptions && { enumOptions }),
      ...(defaultText !== undefined && { defaultText }),
      ...(elementFields && { elementFields }),
      ...(recordValue && { recordValue }),
    };
  });
}

/** Render a stored config value into its control, refusing what it cannot represent. */
export function formatFieldValue(field: ConfigField, value: unknown): FieldRender {
  if (value === undefined) return { ok: true, value: emptyControlValue(field) };

  switch (field.kind) {
    case 'keyValue': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, reason: 'not a record' };
      }
      const second = valueCell(field);
      const rows: ObjectListRow[] = [];
      for (const [key, held] of Object.entries(value)) {
        // A deliberate exception to "never refuse what the server accepts":
        // `z.record(z.string(), …)` admits a `''` key, but a row cannot be read
        // back without one, and no header or env var is named ''. Refusing here
        // routes the node to the JSON editor, where it round-trips.
        if (key === '') return { ok: false, reason: 'holds an empty key' };
        if (field.recordValue === 'secret') {
          // A malformed marker stays visible in JSON rather than being
          // "repaired" into a valid one by an apply that touched another field.
          const marker = SecretRefSchema.safeParse(held);
          if (!marker.success) return { ok: false, reason: `'${key}' is not a secret reference` };
          rows.push({ [KEY_CELL]: key, [second]: marker.data.$secret });
        } else {
          if (typeof held !== 'string') return { ok: false, reason: `'${key}' is not a string` };
          rows.push({ [KEY_CELL]: key, [second]: held });
        }
      }
      return { ok: true, value: rows };
    }
    case 'objectList': {
      if (!Array.isArray(value)) return { ok: false, reason: 'not a list of rows' };
      const cells = field.elementFields ?? [];
      const declared = new Set(cells.map((c) => c.name));
      const rows: ObjectListRow[] = [];
      for (const [index, row] of value.entries()) {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          return { ok: false, reason: `row ${index + 1} is not a row` };
        }
        const stored = row as Record<string, unknown>;
        for (const key of Object.keys(stored)) {
          // A column no control renders would be DROPPED by the next apply —
          // silently, on an edit the author believes touched a different row.
          // The whole-config JSON editor is where such a doc gets repaired.
          if (!declared.has(key)) {
            return { ok: false, reason: `row ${index + 1} holds an unknown column '${key}'` };
          }
        }
        const cellValues: Record<string, string | boolean> = {};
        for (const cell of cells) {
          const rendered = formatFieldValue(cell, stored[cell.name]);
          if (!rendered.ok) {
            return { ok: false, reason: `row ${index + 1} ${cell.name}: ${rendered.reason}` };
          }
          if (typeof rendered.value !== 'string' && typeof rendered.value !== 'boolean') {
            // Unreachable by construction — `deriveElementFields` refuses a cell
            // that is itself a list — but asserted rather than cast, so a future
            // widening of the cell kinds fails here instead of rendering `[object
            // Object]` into a text box.
            return { ok: false, reason: `row ${index + 1} ${cell.name}: not a cell value` };
          }
          // The CELL-level counterpart of `assembleConfig`'s clearing-gesture
          // rule, and it has to be a refusal rather than a preservation.
          //
          // Reading a row back OMITS an optional cell that is empty — the same
          // rule every optional control follows. At field level `assembleConfig`
          // can tell "the author cleared this" from "this was already empty" by
          // comparing against the stored config. A cell has no such anchor:
          // rows carry no identity, so after a removal control row `i` is not
          // stored row `i`, and there is nothing to compare against. Without
          // this, an explicitly-stored `false` or `''` in an optional cell would
          // vanish on an apply that touched a different row entirely.
          //
          // Reachable today on `copy.mapping`: `expression` is
          // `z.string().optional()` with no `.min()`, so `''` is storable, and
          // dropping it leaves a row satisfying neither `source` nor
          // `expression` — a refusal citing a row the author never touched.
          if (
            cell.optional &&
            stored[cell.name] !== undefined &&
            sameControlValue(rendered.value, emptyControlValue(cell))
          ) {
            return {
              ok: false,
              reason: `row ${index + 1} ${cell.name}: an empty optional value a row would drop`,
            };
          }
          cellValues[cell.name] = rendered.value;
        }
        rows.push(cellValues);
      }
      return { ok: true, value: rows };
    }
    case 'text':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: 'not a string' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value: String(value) }
        : { ok: false, reason: 'not a number' };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, reason: 'not a boolean' };
    case 'enum':
      return typeof value === 'string' && (field.enumOptions ?? []).includes(value)
        ? { ok: true, value }
        : { ok: false, reason: 'not one of the permitted values' };
    case 'stringList':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return { ok: false, reason: 'not a list of strings' };
      }
      // A one-per-line control cannot round-trip every string array, and saying
      // it can is worse than admitting it cannot. Reading back splits on newlines
      // and trims, so an element holding a newline SPLITS IN TWO, one with
      // significant leading/trailing space is silently trimmed, and an empty one
      // disappears — on an apply that only touched a different field. These are
      // not hypothetical shapes: an `llm_call.stop` sequence of `"Human: "` turns
      // into `"Human:"`, which stops matching. Refusing here routes the node to
      // the JSON editor, which is exactly what this module's contract says to do
      // with a value its control cannot represent.
      return value.every((v) => v === v.trim() && v !== '' && !v.includes('\n'))
        ? { ok: true, value: value.join('\n') }
        : { ok: false, reason: 'holds an entry a one-per-line control would alter' };
    case 'json': {
      const text = JSON.stringify(value, null, 2);
      // `undefined` back from stringify means the value has no JSON form at all.
      return typeof text === 'string'
        ? { ok: true, value: text }
        : { ok: false, reason: 'not JSON' };
    }
  }
}

/**
 * Seed one control value per field from a stored config.
 *
 * A field whose value cannot be rendered seeds EMPTY rather than throwing — the
 * caller is expected to have consulted `unrepresentableFields` and put the whole
 * node in the JSON editor, so these seeds are never the surface being edited. The
 * empty fallback exists so a partially-unrenderable config cannot crash the
 * panel, leaving the author with no way to repair it at all.
 */
export function seedFieldInputs(
  fields: readonly ConfigField[] | null,
  config: Record<string, unknown>,
): Record<string, FieldInput> {
  const seeded: Record<string, FieldInput> = {};
  for (const field of fields ?? []) {
    const rendered = formatFieldValue(field, config[field.name]);
    seeded[field.name] = rendered.ok ? rendered.value : emptyControlValue(field);
  }
  return seeded;
}

/**
 * The names of every field whose STORED value its control cannot represent.
 *
 * Non-empty means the panel must fall back to the whole-config JSON editor for
 * this node: showing a form that cannot round-trip what is already saved would
 * corrupt the doc on an apply the author believes changed one other field.
 */
export function unrepresentableFields(
  fields: readonly ConfigField[],
  config: Record<string, unknown>,
): string[] {
  return fields.filter((f) => !formatFieldValue(f, config[f.name]).ok).map((f) => f.name);
}

/**
 * Numeric text this form accepts. Decimal or exponent, so `1e` and `0x10` are
 * REFUSED rather than coerced (`Number('0x10')` is 16, which no author typing
 * into a `maxTokens` box meant).
 *
 * Deliberately NOT shared with `paramRules.ts`'s `NUMERIC_TEXT`, which is
 * stricter (no exponent), even though both judge numeric text in this same panel.
 * They answer different questions and have different owners: that one MIRRORS
 * `engine/params.ts`'s run-time `coerce`, so widening it would start accepting
 * param defaults the engine then rejects at run — the mirror is the whole point.
 * This one feeds a `z.number()` config field, where any JS number literal is
 * valid. Merging them would silently re-point one rule at the other's authority.
 */
const NUMERIC_INPUT = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * One row of a row list read back as config values, cell by cell.
 *
 * The ONE reader of a row, shared by the apply (`parseFieldInput`, which refuses
 * the list on `failure`) and the expression picker's candidate placement
 * (`ObjectListControl`, which keeps `value` and ignores it — a draft row is
 * routinely incomplete while the author is still filling it in). A cell that
 * fails is OMITTED from `value`, the same as a cleared optional cell, so the
 * shape a validator reads keeps "not set" meaning absent.
 */
export function parseRowCells(
  cells: readonly ConfigField[],
  row: ObjectListRow,
): { value: Record<string, unknown>; failure: { cell: string; message: string } | null } {
  const value: Record<string, unknown> = {};
  let failure: { cell: string; message: string } | null = null;
  for (const cell of cells) {
    const parsed = parseFieldInput(cell, row[cell.name] ?? emptyControlValue(cell));
    if (!parsed.ok) {
      failure ??= { cell: cell.name, message: parsed.message };
      continue;
    }
    // A cleared OPTIONAL cell omits its key from the row, exactly as a
    // cleared optional field omits its key from the config.
    if (!parsed.omit) value[cell.name] = parsed.value;
  }
  return { value, failure };
}

/** Read one control's input back out as a config value. */
export function parseFieldInput(field: ConfigField, raw: FieldInput): FieldParse {
  // FIRST, before every scalar guard below: a row list is neither a string nor a
  // boolean, so reaching `raw.trim()` with one is a TypeError rather than a
  // refusal.
  if (field.kind === 'objectList') {
    if (!isRowList(raw)) return { ok: false, message: 'expected a row list' };
    const cells = field.elementFields ?? [];
    const rows: Record<string, unknown>[] = [];
    for (const [index, row] of raw.entries()) {
      const { value, failure } = parseRowCells(cells, row);
      if (failure !== null) {
        return { ok: false, message: `row ${index + 1} ${failure.cell}: ${failure.message}` };
      }
      rows.push(value);
    }
    // No rows on an OPTIONAL field is "not set". On a REQUIRED one it must be
    // written as `[]`, following `stringList`'s rule below: omitting it would
    // fail every apply with "expected array, received undefined" on a panel the
    // author may only have opened to change a different field.
    if (rows.length === 0 && field.optional) return { ok: true, omit: true };
    return { ok: true, omit: false, value: rows };
  }

  if (field.kind === 'keyValue') {
    if (!isRowList(raw)) return { ok: false, message: 'expected a row list' };
    const record = rowsToRecord(field, raw, { strict: true });
    if (!record.ok) return record;
    // No rows: `objectList`'s rule — "not set" when optional, `{}` when required.
    if (raw.length === 0 && field.optional) return { ok: true, omit: true };
    return { ok: true, omit: false, value: record.value };
  }

  if (isRowList(raw)) return { ok: false, message: 'expected a single value, not a row list' };

  if (field.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, message: 'expected a checkbox value' };
    // An UNCHECKED optional box omits the key rather than writing `false`: a box
    // nobody ticked is "not set", and writing `false` on every apply would make
    // every node explicit about a choice its author never made.
    //
    // A stored, explicit `false` is NOT lost to this — `assembleConfig` keeps a
    // value that was already empty when the panel opened. (An earlier version of
    // this comment justified the rule by claiming `catalog/lower.ts` distinguishes
    // absent from `false` on `emitMessages`. It does not: it tests `=== true`.
    // The rule is right, that reason was not.)
    if (!raw && field.optional) return { ok: true, omit: true };
    return { ok: true, omit: false, value: raw };
  }

  if (typeof raw === 'boolean') return { ok: false, message: 'expected a text value' };

  if (raw.trim() === '') {
    // For an OPTIONAL key, empty means "not set": writing `''` or `null` would
    // turn "the author left this alone" into an explicit value the engine then
    // has to interpret.
    if (field.optional) return { ok: true, omit: true };

    // For a REQUIRED key it must not, and this is a one-way trap if it does.
    // `file_write.content` is a bare `z.string()` — no `.min(1)` — so `''` is a
    // config the SERVER accepts and an author can legitimately want (write an
    // empty file). Omitting the key instead makes every apply fail with
    // "expected string, received undefined" until they invent content, on a node
    // they may only have opened to change the path. The form must never refuse
    // what the server accepts. So the empty text is written VERBATIM, and a
    // schema that genuinely requires content (`url`'s `.min(1)`) reports that
    // itself, in its own words — a refusal the server would also have made.
    //
    // `number`/`enum`/`json` fall through to omit below: there is no "empty
    // number", so no value could be written, and the schema reporting the key as
    // missing is the honest outcome rather than a trap.
    if (field.kind === 'text') return { ok: true, omit: false, value: raw };
    if (field.kind === 'stringList') return { ok: true, omit: false, value: [] };
    return { ok: true, omit: true };
  }

  switch (field.kind) {
    case 'text':
      // Verbatim, NOT trimmed: leading/trailing space can be meaningful in a
      // value that is interpolated into a larger string.
      return { ok: true, omit: false, value: raw };
    case 'number':
      return NUMERIC_INPUT.test(raw.trim())
        ? { ok: true, omit: false, value: Number(raw.trim()) }
        : { ok: false, message: 'must be a number' };
    case 'enum':
      return (field.enumOptions ?? []).includes(raw)
        ? { ok: true, omit: false, value: raw }
        : { ok: false, message: 'must be one of the permitted values' };
    case 'stringList': {
      const values = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return values.length === 0
        ? { ok: true, omit: true }
        : { ok: true, omit: false, value: values };
    }
    case 'json':
      try {
        return { ok: true, omit: false, value: JSON.parse(raw) };
      } catch {
        return { ok: false, message: 'is not valid JSON' };
      }
    // No `boolean`, `objectList` or `keyValue` case: the guards above return for them, and
    // the compiler proves this switch is exhaustive without them.
  }
}

/**
 * Merge the form's inputs into the node's config.
 *
 * Returns the config to STORE and, separately, the schema-declared subset to
 * validate against `configSchema` — validating the whole assembled object would
 * work too (Zod strips), but keeping the validated value to exactly the declared
 * keys preserves today's behaviour and keeps the cross-field `refine`/
 * `superRefine` rules seeing precisely what the schema author intended.
 */
export function assembleConfig(
  original: Record<string, unknown>,
  fields: readonly ConfigField[],
  inputs: Readonly<Record<string, FieldInput | undefined>>,
): AssembleResult {
  // Start from the ORIGINAL so every key no derived field owns survives —
  // `config.outputs` above all, which no `configSchema` declares.
  const config: Record<string, unknown> = { ...original };
  const owned: Record<string, unknown> = {};

  for (const field of fields) {
    const emptyControl = emptyControlValue(field);
    const raw = inputs[field.name] ?? emptyControl;
    const parsed = parseFieldInput(field, raw);
    if (!parsed.ok) return { ok: false, message: `${field.name}: ${parsed.message}` };
    if (parsed.omit) {
      // Deleting is for a CLEARING GESTURE, not for a control that was already
      // empty when the panel opened. An explicit `false`, an empty array or an
      // empty string are values an author can have meant, and every one of them
      // renders as an empty control — so a plain delete would erase them on an
      // apply that touched a completely different field. Compare against what the
      // stored value RENDERS to: if the control still shows what it was seeded
      // with, nothing was cleared, and the stored value is kept verbatim.
      //
      // This keeps the rule activity-agnostic. The alternative — arguing that
      // dropping `emitMessages: false` is harmless because `catalog/lower.ts`
      // tests `=== true` — is true today and reasons about ONE reader of ONE key;
      // it would silently stop holding for the next optional boolean whose absent
      // and false differ.
      const stored = original[field.name];
      if (stored !== undefined && sameControlValue(raw, emptyControl)) {
        const rendered = formatFieldValue(field, stored);
        if (rendered.ok && sameControlValue(rendered.value, emptyControl)) {
          config[field.name] = stored;
          owned[field.name] = stored;
          continue;
        }
      }
      delete config[field.name];
      continue;
    }
    config[field.name] = parsed.value;
    owned[field.name] = parsed.value;
  }

  return { ok: true, config, owned };
}

/**
 * Read a whole-config JSON draft back out as a config object. Empty text is `{}`.
 *
 * Lifted out of `ConnectionsPage` (#1088 item 1) when the Datasets form (#1115)
 * would have made it a second copy of the same eight lines. `configForm.ts` is
 * the page-agnostic home #1088 names for it.
 *
 * Since #1088 it is the ONLY copy: the canvas node panel reads its JSON draft
 * through `readConfigDraft` too, so all three editors refuse a bad draft in the
 * same words.
 */
export function parseConfigText(
  text: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const raw: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'Invalid config JSON: config must be a JSON object' };
    }
    return { ok: true, config: raw as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      message: `Invalid config JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The controls for one KIND's config, plus any CARRIED key.
 *
 * A carried key is one the stored config holds that this kind does not declare
 * but a SIBLING kind does — the residue of a kind switch. Rendering it (rather
 * than only naming it) makes "blank the control to drop the key" the repair,
 * instead of a dead end reachable only through the JSON editor. A carried field
 * is always `optional`, so blanking it OMITS the key — exactly the clearing
 * gesture `assembleConfig` honours.
 *
 * A key NO kind declares is not carried: nothing can describe it, so it stays
 * untouched in `config` (`assembleConfig` preserves every key no field owns) and
 * is reachable through the JSON escape hatch.
 *
 * Fields are matched across kinds BY NAME, which assumes a name means the same
 * SHAPE everywhere it appears. A future kind that reused a name with a DIFFERENT
 * type would carry a stale draft into the wrong control, so give it a new name
 * rather than a second meaning.
 *
 * Generic over the kind because two resources now need it — connections (whose
 * shared names are `model`/`baseUrl`/`timeoutMs`) and datasets (`parameters`,
 * which `query` declares and `table` does not). It lives here rather than on
 * either page so the halves cannot drift.
 *
 * `schemaFor` may return a schema this module cannot read as an object root, in
 * which case `deriveConfigFields` yields `null` and that kind simply contributes
 * nothing — the caller's own root-level fallback to the JSON editor is what
 * covers it.
 */
export function deriveFieldsWithCarried<K extends string>(
  kinds: readonly K[],
  schemaFor: (kind: K) => z.ZodType,
  kind: K,
  config: Record<string, unknown>,
): { fields: ConfigField[]; carried: string[] } {
  const own = deriveConfigFields(schemaFor(kind)) ?? [];
  const seen = new Set(own.map((f) => f.name));
  const carried: ConfigField[] = [];
  for (const other of kinds) {
    if (other === kind) continue;
    for (const field of deriveConfigFields(schemaFor(other)) ?? []) {
      if (seen.has(field.name) || !(field.name in config)) continue;
      seen.add(field.name);
      carried.push({ ...field, optional: true });
    }
  }
  return { fields: [...own, ...carried], carried: carried.map((f) => f.name) };
}

/**
 * The config a two-mode editor would SAVE right now — read from whichever draft
 * is on screen, never the other one.
 *
 * This is the correctness core of the fields↔JSON toggle and the reason it is
 * here rather than repeated per page: there are two drafts and exactly one
 * answer to "what would Save write", and reading the wrong one silently saves
 * something the operator is not looking at. Both the submit handler and the
 * live advisory consult it, which is what keeps the advisory describing the
 * value that would actually be stored.
 *
 * Each MODE TOGGLE is expected to commit its draft into `config` before
 * switching, so the two never disagree about a key the operator has finished
 * with. A KIND change ordinarily does NOT commit — it must not rewrite an
 * operator's JSON under them — which is precisely the seam a live advisory
 * covers. The exception is a kind change that itself moves the editor — into a
 * kind the page forces into JSON (a dataset kind with no reader), or one whose
 * controls cannot show the stored value. There the kind change IS a mode toggle,
 * so it commits like one (`changeConfigKind`); an ordinary kind change must not.
 */
export function readConfigDraft(
  jsonMode: boolean,
  draft: {
    config: Record<string, unknown>;
    jsonText: string;
    inputs: Readonly<Record<string, FieldInput | undefined>>;
  },
  fields: readonly ConfigField[],
): AssembleResult {
  if (!jsonMode) return assembleConfig(draft.config, fields, draft.inputs);
  const parsed = parseConfigText(draft.jsonText);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  // In JSON mode the operator authored the WHOLE object, so it is both the
  // config to store and the subset to validate — there is no "keys the form does
  // not own" distinction to preserve, because no form was in the way.
  return { ok: true, config: parsed.config, owned: parsed.config };
}

/**
 * The state a two-mode config editor works on (#1146).
 *
 * `config` is the AUTHORITATIVE value; `inputs` and `jsonText` are the two
 * drafts the operator types into, and each mode change reads its draft back into
 * `config`. `jsonMode` records only that the operator ASKED for JSON — the mode
 * on screen is derived (`configEditorView`), because other facts force it too.
 */
export interface ConfigDraft<K extends string> {
  kind: K;
  config: Record<string, unknown>;
  inputs: Record<string, FieldInput>;
  jsonText: string;
  jsonMode: boolean;
}

/** One kind's controls plus its carried keys — `deriveFieldsWithCarried`'s shape. */
export type FieldsFor<K extends string> = (
  kind: K,
  config: Record<string, unknown>,
) => { fields: ConfigField[]; carried: string[] };

/** Whether a page shows this kind ONLY as JSON, whatever the operator asked for. */
export type ForcedJson<K extends string> = (kind: K) => boolean;

const neverForced = (): boolean => false;

/**
 * What the editor shows for a draft, and why.
 *
 * Three facts put the textarea on screen, and only these: the operator asked
 * (`jsonMode`); a STORED value its control cannot represent (a form that cannot
 * round-trip what is saved would corrupt it on a save the operator believes
 * touched one other key); or a kind the page forces (`forcedJson`).
 */
export function configEditorView<K extends string>(
  draft: ConfigDraft<K>,
  fieldsFor: FieldsFor<K>,
  forcedJson: ForcedJson<K> = neverForced,
): { fields: ConfigField[]; carried: string[]; unrenderable: string[]; jsonMode: boolean } {
  const { fields, carried } = fieldsFor(draft.kind, draft.config);
  const unrenderable = unrepresentableFields(fields, draft.config);
  return {
    fields,
    carried,
    unrenderable,
    jsonMode: draft.jsonMode || unrenderable.length > 0 || forcedJson(draft.kind),
  };
}

/** Read the field draft into `config` AND `jsonText`, so the textarea opens on what Save would write. */
function commitFieldDraft<K extends string, F extends ConfigDraft<K>>(
  form: F,
  fields: readonly ConfigField[],
): { ok: true; form: F } | { ok: false; error: string } {
  const assembled = assembleConfig(form.config, fields, form.inputs);
  if (!assembled.ok) return { ok: false, error: assembled.message };
  return {
    ok: true,
    form: {
      ...form,
      config: assembled.config,
      jsonText: JSON.stringify(assembled.config, null, 2),
    },
  };
}

/**
 * Switch kinds WITHOUT discarding anything typed or stored.
 *
 * Always returns the moved form — the operator is never trapped in a kind — and
 * an `error` naming anything that could not be carried (`null` otherwise, which
 * the caller writes too, so an error from the previous kind does not linger).
 */
export function changeConfigKind<K extends string, F extends ConfigDraft<K>>(
  form: F,
  // `NoInfer`: the kind set comes from `fieldsFor`, not from the one literal passed.
  kind: NoInfer<K>,
  fieldsFor: FieldsFor<K>,
  forcedJson: ForcedJson<K> = neverForced,
): { form: F; error: string | null } {
  const current = configEditorView(form, fieldsFor, forcedJson);

  // In JSON mode the textarea is the ONLY draft being typed into: its `onChange`
  // writes `jsonText` and never `config` or `inputs`. Seeding the new kind's
  // controls from those would seed them from BEFORE every keystroke — and
  // because a kind change can CLOSE the editor (leaving a forced kind), the
  // operator would land in a field form holding their pre-edit config, with
  // nothing on screen to say the edit was dropped. So the parsed JSON is the
  // whole seed: no `inputs` overlay, because those values predate the editor and
  // would otherwise win over the very edit being carried. The DERIVED mode, not
  // the flag: a forced kind has the textarea up with `jsonMode` false.
  if (current.jsonMode) {
    const parsed = parseConfigText(form.jsonText);
    if (parsed.ok) {
      return {
        form: {
          ...form,
          kind,
          config: parsed.config,
          // Left exactly as typed: re-stringifying would reformat the operator's
          // text under their cursor when the editor stays open, and it is
          // re-derived by `configToJson` when it reopens.
          inputs: seedFieldInputs(fieldsFor(kind, parsed.config).fields, parsed.config),
        },
        error: null,
      };
    }
    // A draft that does not parse has no committed form to carry, so the change
    // must not CLOSE the editor — a new kind that happens to render the stale
    // `config` would reopen the field form on the pre-edit value while the
    // unparseable text vanished behind it. Pin it open instead, the same rule
    // `configToFields` applies. The kind still changes; the message names what
    // has to be fixed first.
    return { form: { ...form, kind, jsonMode: true }, error: parsed.message };
  }

  // Seed the new kind's controls from the stored config, then let anything
  // already typed win. A plain re-seed would drop every in-progress edit; no
  // re-seed at all would leave a key the new kind owns showing an empty control,
  // which `assembleConfig` reads as a clearing gesture and DELETES.
  const moved: F = {
    ...form,
    kind,
    inputs: {
      ...seedFieldInputs(fieldsFor(kind, form.config).fields, form.config),
      ...form.inputs,
    },
  };

  // Ordinarily a kind change rewrites NEITHER draft, so an operator's JSON is
  // never edited under them. The exception is a switch that itself takes the
  // field form away — by EITHER forcing reason, the kind or an unrenderable
  // stored value — which is the one route into JSON that does not run through
  // `configToJson`. The textarea would otherwise open on a `jsonText` written
  // before anything was typed into the controls, and SAVE it.
  if (!configEditorView(moved, fieldsFor, forcedJson).jsonMode) return { form: moved, error: null };
  const committed = commitFieldDraft<K, F>(moved, current.fields);
  // A control that will not read back (non-numeric text in a number box) has no
  // committed form to carry; the message names it rather than letting the
  // textarea open on a draft that silently omits it.
  return committed.ok
    ? { form: committed.form, error: null }
    : { form: moved, error: committed.error };
}

/** Fields → JSON: assemble first, so the textarea opens on what Save would write. */
export function configToJson<K extends string, F extends ConfigDraft<K>>(
  form: F,
  fields: readonly ConfigField[],
): { ok: true; form: F } | { ok: false; error: string } {
  const committed = commitFieldDraft<K, F>(form, fields);
  return committed.ok ? { ok: true, form: { ...committed.form, jsonMode: true } } : committed;
}

/** JSON → fields: parse first, and refuse if the result has no form to show. */
export function configToFields<K extends string, F extends ConfigDraft<K>>(
  form: F,
  fieldsFor: FieldsFor<K>,
): { ok: true; form: F } | { ok: false; error: string } {
  const parsed = parseConfigText(form.jsonText);
  if (!parsed.ok) return { ok: false, error: parsed.message };
  const { fields } = fieldsFor(form.kind, parsed.config);
  const bad = unrepresentableFields(fields, parsed.config);
  if (bad.length > 0) {
    return { ok: false, error: `These settings have no form control: ${bad.join(', ')}.` };
  }
  return {
    ok: true,
    form: {
      ...form,
      config: parsed.config,
      inputs: seedFieldInputs(fields, parsed.config),
      jsonMode: false,
    },
  };
}
