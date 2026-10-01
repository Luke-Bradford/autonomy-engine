# UI patterns — resource forms

How every create/edit form in studio looks and behaves (#1396, OR5). Written once here; the shared
pieces live in `packages/web/src/lib/form/`. Connections, Datasets, Secrets, Global parameters and
Triggers follow it. The node property panel moves onto it in a slice that follows #1396.

## The drawer

- **Create and edit open in a drawer beside the list** (`FormDrawer`). It is a column of the page,
  not an overlay. The list stays readable, and its row actions stay clickable while a form is open.
  On narrow screens the drawer stacks under the list.
- While a drawer is open the page widens by the drawer's width (`.content:has(.drawer-layout-open)`),
  so the list keeps its usual width beside it. Where the window is too narrow even for that, the
  list scrolls sideways inside its own column. It never runs under the drawer.
- The drawer has a header (title and a close button), a body, and a **footer that sticks to the
  bottom of the window**. However long the form is, Save stays in view.
- **Footer actions are right-aligned, with the primary action last**: `Cancel` · secondary actions
  such as `Test connection` · `Save` (class `primary`).
- When the drawer opens, the first field that can be changed gets focus (read-only fields are
  skipped). When it closes, focus goes back to the button
  that opened it (the page passes it as `returnFocusTo`, because an open that went through the
  unsaved-changes prompt leaves focus on the prompt).
- The form's error and result messages sit in the footer above the actions, so a refused Save is
  in view where Save was pressed.
- While a save or test is in flight, Close and Escape wait for it, as Cancel does (`busy`).

## Sections

- The form is grouped into titled sections (`FormSection`, a `fieldset` and `legend`):
  - for a connection: *Basics* (name, kind), *Connection* (the kind's settings), *Authentication*
    (the secret) and *Advanced*;
  - for a dataset: *Basics* (name, store, kind), *Dataset* (the kind's settings), *Columns* (the
    declared schema) and *Advanced*;
  - for a secret: *Basics* (name) and *Value*;
  - for a global parameter: *Basics* (name, type) and *Value* (value, description);
  - for a trigger: *Basics* (name, enabled), *Pipeline* (the binding), *Firing* (the mode, its
    schedule, event or window, and the run windows), *Concurrency* and *Parameters*.
- Triggers use the drawer too, not a full page: the form is long but narrow, and the drawer's body
  scrolls with the page while its footer stays in view. It has no Advanced section, because every
  section holds settings an ordinary trigger uses.
- **Advanced is collapsed by default**, and opens by default when the record already uses it, so
  stored state is never hidden. The override allowlist lives there (`OverridableKeysSection`).

## Labels, hints and required fields

- **Human labels come from the schema**, not from a list in the web package. Tag a field with
  `presented(schema, { title, description?, unit? })` from `shared/schemas/field-presentation.ts`,
  and `ConfigFieldControl` renders:
  - the title, with the unit in brackets ("Timeout (ms)");
  - the description, with the stored key in code type, as a hint under the control (linked with
    `aria-describedby`).

  Keep the key visible: server errors, advisories and `${}` expressions all cite it.
- `unit` names what the stored value is in. It never converts the value.
- Kinds and other enum identifiers show a display name (`CONNECTION_KIND_LABELS`,
  `DATASET_KIND_LABELS`, `TRIGGER_MODE_LABELS`,
  `CONCURRENCY_POLICY_LABELS`). The stored value stays the identifier.
- A field's title must not contain another label on the same form ("Name", "Kind", "Store"):
  label lookups by substring, in tests and in assistive tech, would then find two controls.
- **Required fields get an asterisk and `aria-required`** (native `required` on a plain input).
  Optional fields are unmarked: schema-derived fields no longer carry an "(optional)" suffix (a few
  hand-written labels outside `ConfigFieldControl`, in the canvas, still do until the node panel
  moves onto this pattern). The asterisk is `RequiredMark`.
  CSS draws it, and it is `aria-hidden`, so it never becomes part of a field's name. A row list is a
  `group` and cannot take `aria-required`, so it gets the asterisk alone.
- A field that cannot change on an edit (a secret's name, a global's name and type) is
  **read-only, not disabled**, so it stays reachable by keyboard and screen reader, and it carries
  no asterisk: it asks nothing of the operator. When the drawer opens, focus skips read-only
  fields and lands on the first one that can be changed.
- A secret input has a **Show/Hide** toggle, named "Show secret" or "Hide secret" to match what it
  does next. The toggle sits beside the label, not inside it.

## Leaving a form with unsaved changes

A page holds its open form with `useDrawerForm(signatureOf)`. The hook returns the form, the
open counter the form is keyed on, the opener ref focus returns to, the guard below, and three
actions: `openFrom(button, open)` (through the guard), `requestClose()`, and `closeIfLatest(seq)`
for a save that lands after another form has opened. `signatureOf` is what Save would write as one
string: `payloadSignature([...])` over the fields Save sends, with the config read through
`saveableConfigOf` (both in `pages/pipeline/configForm.ts`).

`useUnsavedChangesGuard(dirty)` holds every way out of a dirty form at one prompt in the drawer's
footer ("You have unsaved changes. Discard them?" with **Keep editing** and **Discard changes**):

- Cancel, Close, Escape, and opening another record's form all go through `guard.request(action)`.
- A route change is held by `guard.routeHold`, which the page renders. It is mounted only while
  the form is dirty, because React Router warns about any registered blocker on a navigation it
  did not create.
- Closing or reloading the tab is held by the browser's own `beforeunload` prompt.

"Dirty" compares what Save would write against the value when the form opened. Switching between
the fields view and the JSON view is not an edit.

The prompt is an inline `alertdialog`, not `window.confirm`. OR6 (#1397) owns the app's confirm
dialogs.

## Validation

Connections, Datasets, Secrets, Global parameters and Triggers check their own fields
(`useFieldValidation`, `lib/form/fieldValidation.ts`). Passing `validation` to `FormDrawer` turns
the browser's own check off (`noValidate`), so the browser's bubble no longer pre-empts the inline
message.

- **The page computes `checks`**, a memo over what they read: what is wrong with the draft now, by
  field key, in the form's order (`name`, `connectionId`, `config.<field>`, `columns`). A required
  name or store must be non-empty (`nameCheck`). That is the write schema's `min(1)`, so there is no
  trim. Config fields report only what `readConfigDraft` would refuse (`configDraftErrors`): a
  number that is not one, JSON that does not parse. A kind's own schema rules stay advisory,
  because the form must never refuse what the server accepts.
- **The page names its fields** with `labelOf(key)`, which returns `undefined` for a key the form
  does not show now. This changes with the kind and the JSON view; `configKeyLabel` names the config
  keys. The summary uses these names, and a refusal's issue is filed under a field only if
  `labelOf` names it.
- **What is shown is narrower.** A check is shown once the field is left *after an edit*, or after
  Save is pressed. Tabbing past an untouched field shows nothing, and typing never raises an error.
  A fix shows at once: the error goes the moment the value is fine, and a new problem in the same
  field waits for the next blur. A field that leaves the form takes its error with it.
- **The error sits in a reserved slot under the field** (`FieldError`, `.field-error-slot`), so it
  does not push the fields below down. `fieldAttrs` gives the control:
  - its key (`data-field`);
  - an invalid mark (`data-invalid`, plus `aria-invalid`, except on a row list's `group`, where ARIA
    does not allow it);
  - `aria-describedby` with the error first, then the hint.

  The line has no live role.
- **A refused Save shows a summary and focuses the first invalid field**, after the errors are on
  screen. The summary lists every invalid field as a button ("Timeout (ms): must be a number") that
  takes focus to the field, opening a collapsed section on the way. It lives in the **footer**, not
  at the top as #1396 first sketched: the body scrolls, and the footer is where Save was pressed.
  Together with any plain message it is the form's **one** `role="alert"` (`FormErrors`). It updates
  as fields are fixed, and goes when the last one is. Its height is capped, so it never squeezes the
  body.
- **A refusal from elsewhere lands on fields too.** The write schema's issues before sending
  (`schemaRefusal`) and a 400's `issues` from the server (`saveRefusal`) are filed under the field
  their path names. That is the longest prefix that is a field key, so a row cell's issue marks its
  row list and keeps the rest of its path ("2.key: duplicate key"). Two issues on one field are both
  shown. Whatever names no field is worded as before, in the footer. Such an error stays until that
  field is edited, the next Save, or the field leaving the form, because the client cannot judge it
  again.
- **Test connection checks the config only** (`attempt` with a scope). It shows the summary for
  those fields, and leaves the rest of the form as it was: it does not arm an untouched Name, nor
  clear a refusal on it.
- **Fields join by carrying `data-field="<key>"`**, a row list on its group. The form's own change
  and blur handlers find the key, so a field needs no wiring of its own. Moving between the cells of
  one row list is not leaving it. `ConfigFieldControl` takes a `validation` prop and `ConfigEditor`
  an `errorFor`; the canvas passes neither and renders as before.
- **A field that is read-only on an edit is not a field to fix.** `labelOf` stops naming it (a
  replaced secret's or a stored global's Name), so nothing is checked or filed there.
- **A conflict on the name is the Name's error.** A 409 from a create, where the name is the only
  thing that can collide, goes beside the Name (`showRefusedFields`), not into the footer's message.
- **Under `noValidate` the form must refuse bad input itself.** A native `type="number"` holding `1e`,
  or a half-typed `datetime-local`, reports `value === ''` and sets `validity.badInput`. The browser
  refused such a submit, but with its check off a form reading the value sees a blank, and quietly
  drops the bound or cap. A form with native number or date controls calls `firstBadInput` at the
  top of its submit and refuses with `badInputMessage`, focusing the control. Today that is the
  trigger form, whose mode editors use them.
- **The trigger form checks its own fields only**: Name, the binding (an enabled trigger must be
  bound), Max parallel runs and Params. Its mode editors (recurrence, tumbling window, event, run
  windows) still refuse with the footer's one message on Save, from their converters. Moving them
  onto field keys is a later slice.
- The canvas's `DraftNumberField` uses the same `FieldError` with `role="alert"`, because there is no
  summary on the canvas to announce it.

## Still to come under #1396

- Typed number controls (min/max). Number fields stay text inputs today, for the reason given in
  `ConfigFieldControl`: a native number input reports a typo as empty, which would silently delete
  the setting.
- A JSON code editor, kind icons, and a two-column grid on wide screens.
- Axe gates on every form (shared with OR24, #1415).
