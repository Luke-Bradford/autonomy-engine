# UI patterns — resource forms

How every create/edit form in studio looks and behaves (#1396, OR5). Written once here; the shared
pieces live in `packages/web/src/lib/form/`. Connections follows it. Datasets, Triggers, Secrets,
Global parameters and the node property panel move onto it in the slices that follow #1396.

## The drawer

- **Create and edit open in a drawer beside the list** (`FormDrawer`). It is a column of the page,
  not an overlay. The list stays readable, and its row actions stay clickable while a form is open.
  On narrow screens the drawer stacks under the list.
- The drawer has a header (title and a close button), a body, and a **footer that sticks to the
  bottom of the window**. However long the form is, Save stays in view.
- **Footer actions are right-aligned, with the primary action last**: `Cancel` · secondary actions
  such as `Test connection` · `Save` (class `primary`).
- When the drawer opens, the first field gets focus. When it closes, focus goes back to the button
  that opened it.

## Sections

- The form is grouped into titled sections (`FormSection`, a `fieldset` and `legend`). For a
  connection these are *Basics* (name, kind), *Connection* (the kind's settings), *Authentication*
  (the secret) and *Advanced*.
- **Advanced is collapsed by default**, and opens by default when the record already uses it, so
  stored state is never hidden.

## Labels, hints and required fields

- **Human labels come from the schema**, not from a list in the web package. Tag a field with
  `presented(schema, { title, description?, unit? })` from `shared/schemas/field-presentation.ts`,
  and `ConfigFieldControl` renders:
  - the title, with the unit in brackets ("Timeout (ms)");
  - the description, with the stored key in code type, as a hint under the control (linked with
    `aria-describedby`).

  Keep the key visible: server errors, advisories and `${}` expressions all cite it.
- `unit` names what the stored value is in. It never converts the value.
- Kinds and other enum identifiers show a display name (`CONNECTION_KIND_LABELS`). The stored value
  stays the identifier.
- **Required fields get an asterisk and `aria-required`** (native `required` on a plain input).
  Optional fields are unmarked; there is no "(optional)" suffix. The asterisk is `RequiredMark`.
  CSS draws it, and it is `aria-hidden`, so it never becomes part of a field's name. A row list is a
  `group` and cannot take `aria-required`, so it gets the asterisk alone.
- A secret input has a **Show/Hide** toggle (`aria-pressed`). The toggle sits beside the label, not
  inside it.

## Leaving a form with unsaved changes

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

## Still to come under #1396

- Inline validation on blur in a reserved slot, plus an error summary on submit that focuses the
  first invalid field.
- Typed number controls (min/max). Number fields stay text inputs today, for the reason given in
  `ConfigFieldControl`: a native number input reports a typo as empty, which would silently delete
  the setting.
- A JSON code editor, kind icons, and a two-column grid on wide screens.
- Axe gates on every form (shared with OR24, #1415).
