import { useMemo, useState } from 'react';
import {
  CONTAINER_CONFIG_FIELDS,
  CONTAINER_CONFIG_FIELD_NAMES,
  ContainerSchema,
  type Container,
  type ContainerConfigField,
  type Edge,
  type Node,
  type Param,
} from '@autonomy-studio/shared';
import { ConfigFieldControl } from './ConfigFieldControl';
import {
  assembleConfig,
  deriveConfigFields,
  seedFieldInputs,
  unrepresentableFields,
  type ConfigField,
} from './configForm';
import { validateCanvas } from './canvasDoc';
import { containersWithUpdated } from './canvasStore';
import { confirmContainerEdit, containerLabels } from './containerRules';

/**
 * U23 (#839) — the container config form.
 *
 * The half of a container's authoring that U6d left write-once. Creating a loop
 * captured only the fields a VALID doc requires (`exitWhen`, optionally
 * `maxRounds`), and nothing could be changed afterwards, so a typo'd exit
 * condition cost the whole container: `deleteContainer` and start again. That
 * was the only escape route, and it is a blunt one — deleting also takes the
 * container's incident edges with it.
 *
 * ## Reached by a BUTTON, not by selecting the box
 *
 * A container node is `selectable: false` and must stay so: React Flow writes
 * `pointer-events: all` on a selectable node's wrapper, and a container's
 * wrapper spans a REGION of the canvas, so the box would swallow every pane
 * click aimed between its children (mutation-proved by
 * `e2e/container-rendering.spec.ts`). The ⚙ on the box writes the selection
 * directly instead — the same opt-back-in the ✕ and the edge handles use.
 *
 * ## The fields are DERIVED, twice over
 *
 * The controls come from `deriveConfigFields(ContainerSchema)` — the same
 * schema→form engine `NodePanel` uses (U7) — so this panel restates neither the
 * field list nor their types, and inherits `assembleConfig`'s proven
 * preserve-every-unowned-key rule along with it.
 *
 * WHICH of those fields a given container may carry comes from
 * `CONTAINER_CONFIG_FIELDS`, exported from `engine/params.ts` beside the
 * refusals that are its authority. `ContainerSchema` is flat and has no opinion
 * on kind-legality — a `stage` with a `timeout` parses cleanly and is refused
 * only by `validateDoc` — so offering the schema's fields unfiltered would let
 * the panel author a doc the save gate then rejects.
 */
export function ContainerPanel({
  container,
  nodes,
  edges,
  containers,
  params,
  onApply,
}: {
  container: Container;
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  params: Param[];
  onApply: (next: Container) => void;
}) {
  const label = containerLabels(containers).get(container.id) ?? container.kind;
  const stored = container as unknown as Record<string, unknown>;

  /**
   * The controls to render: the fields legal for this kind, PLUS any illegal
   * one the container actually carries.
   *
   * That second half is a repair path, not a courtesy. A `stage` carrying a
   * `timeout` — reachable through the API or a git import, which is the same
   * population U6c and U6d keep designing for — is refused by `validateDoc`, so
   * the badge blocks the save citing a field the panel would not be showing.
   * With `kind` (correctly) not editable here, that is a dead end: the operator
   * can read what is wrong and has no control to fix it. Rendering the field
   * makes the existing "blank an optional control to drop the key" rule the
   * repair, with no new mechanism.
   */
  const fields = useMemo<ConfigField[]>(() => {
    const derived = deriveConfigFields(ContainerSchema) ?? [];
    const legal = CONTAINER_CONFIG_FIELDS[container.kind];
    const carried = CONTAINER_CONFIG_FIELD_NAMES.filter(
      (name) => !legal.includes(name) && stored[name] !== undefined,
    );
    const show = new Set<string>([...legal, ...carried]);
    return derived.filter((f) => show.has(f.name));
  }, [container.kind, stored]);

  /** The rendered fields that are NOT valid on this kind — see `fields`. */
  const illegal = fields
    .map((f) => f.name)
    .filter(
      (name) => !CONTAINER_CONFIG_FIELDS[container.kind].includes(name as ContainerConfigField),
    );

  /**
   * A stored value its control cannot represent — `exitWhen: 42` from a hand-
   * written doc, say.
   *
   * Applying then would corrupt it: the control seeds EMPTY, and an apply the
   * author believes changed one other field would drop or rewrite this one.
   * `NodePanel` escapes to a whole-config JSON editor in this case; a container
   * has no such editor, so the honest move is to say which field cannot be shown
   * and disable Apply. Deleting and re-creating the container remains the way
   * out, as it was for every container edit before this panel existed.
   */
  const unrenderable = unrepresentableFields(fields, stored);

  /**
   * Of those, the ones the SAVE GATE actually refuses — read from the validator
   * rather than inferred from the map.
   *
   * The two are not the same set, and assuming they were made the advisory say
   * something false in the ONLY case it can currently appear. `illegal` means
   * "no kind-legality rule permits this field here"; blocked means "`validateDoc`
   * emits an issue about it". `stage` + `maxRounds` is illegal and NOT refused
   * (#859), so the advisory promised a blocked save on a screen whose Save
   * button was enabled — and since every other illegal combination is rejected
   * by the server's own write gate before a version can be minted, that one case
   * is the whole reachable population.
   *
   * Deriving it means the sentence stays true if #859 is ever closed, without
   * this panel having to know that it was.
   */
  const blocked = useMemo(() => {
    // Not computed when a stored value is unrenderable. That branch renders no
    // form at all, so the answer is unused — and `validateDoc` assumes its input
    // is schema-typed, so a doc carrying `exitWhen: 42` (exactly the population
    // `unrenderable` exists for) makes it THROW on `value.trim()` rather than
    // report an issue. Memoised because it re-runs the whole doc validator.
    if (unrenderable.length > 0 || illegal.length === 0) return new Set<string>();
    return new Set(
      validateCanvas(nodes, edges, containers, params)
        .filter((issue) => issue.includes(`container '${container.id}'`))
        .flatMap((issue) => illegal.filter((name) => issue.includes(name))),
    );
  }, [unrenderable, illegal, nodes, edges, containers, params, container.id]);

  /**
   * Seeded ONCE, per mount.
   *
   * `NodePanel` pairs its seed with a render-phase re-seed when its `config`
   * prop changes, and this panel deliberately does NOT — it was written and
   * then removed, because the two differ in what a prop change MEANS.
   * `NodePanel`'s subject is `node.config`, which changes only when that config
   * is replaced. This panel's subject is the whole `Container`, and the store's
   * copy-on-write actions replace that object for edits the operator did not
   * make here at all: `deleteNode` pruning a child out of it (#746) mints a new
   * container, and a re-seed would silently discard an `exitWhen` they were
   * half-way through typing.
   *
   * Switching to a DIFFERENT container is handled by `PropertyPanel`'s `key`,
   * which remounts — the same mechanism `EdgePanel` and `NodePanel` rely on, and
   * mutation-proved: removing the key alone leaves the draft carrying across.
   */
  const [inputs, setInputs] = useState(() => seedFieldInputs(fields, stored));
  const [error, setError] = useState<string | null>(null);

  function apply() {
    const assembled = assembleConfig(stored, fields, inputs);
    if (!assembled.ok) {
      setError(assembled.message);
      return;
    }
    const next = assembled.config as unknown as Container;
    // The dead-field control is a REPAIR, and repair means clearing. Without
    // this, typing a new value into one is accepted, warns about nothing (the
    // consequence gate diffs the validator, which has no opinion on the one
    // reachable case) and mints the dead field into an immutable version — the
    // panel inviting an edit it exists to undo.
    const written = illegal.filter(
      (name) => (next as unknown as Record<string, unknown>)[name] !== undefined,
    );
    if (written.length > 0) {
      setError(
        `${written.join(', ')} ${written.length === 1 ? 'is' : 'are'} not valid on a ` +
          `${container.kind} — clear ${written.length === 1 ? 'it' : 'them'} rather than ` +
          'giving a value.',
      );
      return;
    }
    // A UX PRE-CHECK, never the gate — `NodePanel.schemaIssues`' posture and its
    // reason. The server parses the body first, so this only spares the author a
    // round-trip to a 400 they were going to get anyway.
    const check = ContainerSchema.safeParse(next);
    if (!check.success) {
      setError(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    // The same pre-hoc gate a membership edit goes through. An `exitWhen` edit
    // can introduce a reference its own children do not satisfy, which
    // `containerEditConsequence` catches by DIFFING the validator rather than by
    // any rule written here.
    if (
      !confirmContainerEdit(
        { nodes, edges, containers, params },
        containersWithUpdated(containers, next),
        recovery(stored, next),
      )
    ) {
      return;
    }
    setError(null);
    onApply(next);
  }

  return (
    /* An `<aside className="property-panel">`, like every other top-level panel
       (`NodePanel`, `EdgePanel`, `PipelinePanel`) — NOT the bare fragment
       `ContainerSection` returns. That fragment is right for a section NESTED
       inside a panel, whose comment says so; copied to a TOP-LEVEL panel the
       premise is false, and the children would land as separate items of
       `.canvas-grid` instead of inside the panel card. Everything scoped to
       `.property-panel` — the card itself, the label/control flex column, the
       input styling — would silently stop applying, and the `Properties`
       landmark four other specs address the panel by would vanish. */
    <aside className="property-panel" aria-label="Properties">
      <h3>{label}</h3>
      <p className="page-hint">
        {container.children.length} {container.children.length === 1 ? 'activity' : 'activities'}{' '}
        inside. Which activity belongs to which container is edited on the activity itself.
      </p>

      {unrenderable.length > 0 ? (
        <p className="error" role="alert">
          {unrenderable.join(', ')} {unrenderable.length === 1 ? 'holds a value' : 'hold values'}{' '}
          this form cannot show, so editing is disabled — applying would overwrite{' '}
          {unrenderable.length === 1 ? 'it' : 'them'}. Delete and re-create this container to author
          it again.
        </p>
      ) : (
        <div className="contract-section">
          {fields.map((field) => (
            <ConfigFieldControl
              key={field.name}
              field={field}
              value={inputs[field.name] ?? (field.kind === 'boolean' ? false : '')}
              onChange={(next) => setInputs((prev) => ({ ...prev, [field.name]: next }))}
            />
          ))}
          {illegal.length > 0 && (
            <p className="contract-advisory">
              {illegal.join(', ')} {illegal.length === 1 ? 'is' : 'are'} not valid on a{' '}
              {container.kind} and {illegal.length === 1 ? 'does' : 'do'} nothing.{' '}
              {illegal.some((name) => blocked.has(name))
                ? 'Saving is blocked until cleared.'
                : 'Clearing is the only edit allowed here.'}
            </p>
          )}
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="button" onClick={apply}>
            Apply container settings
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * How to undo this edit, for the confirmation that may warn about it.
 *
 * `consequenceMessage` takes the recovery sentence as a PARAMETER because the
 * way back out differs per edit, and U6d's sharpest review finding was a
 * hard-coded one that did not recover. For a config edit the way back is the
 * previous value, so the sentence names it — and names the FIELDS that changed,
 * because an apply can carry several at once and "restore the previous values"
 * would leave the operator guessing which.
 */
function recovery(before: Record<string, unknown>, after: Container): string {
  const changed = CONTAINER_CONFIG_FIELD_NAMES.filter(
    (name) => before[name] !== (after as unknown as Record<string, unknown>)[name],
  );
  if (changed.length === 0) return 'You can undo it by re-applying the previous settings.';
  const parts = changed.map((name) => {
    const was = before[name];
    return was === undefined
      ? `clearing ${name}`
      : `setting ${name} back to ${JSON.stringify(was)}`;
  });
  return `You can undo it by ${parts.join(' and ')}.`;
}
