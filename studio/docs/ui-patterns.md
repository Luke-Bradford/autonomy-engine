# UI patterns — resource forms

How every create/edit form in studio looks and behaves (#1396, OR5). Written once here; the shared
pieces live in `packages/web/src/lib/form/`. Connections, Datasets, Secrets, Global parameters and
Triggers follow it. The node property panel (and the container panel) share its labels, hints,
required marks and display names; its layout is its own, below.

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
- **A number field says what it admits.** Its hint leads with the rule the schema states, read by
  `configForm.ts` (`numberRule`, `describeNumberRule`): "Whole number from 1 to 65535.",
  "Number greater than 0.". So the label is the title alone, with no " — number". A row cell has no
  hint, and keeps the suffix.
  - The control stays a TEXT input, for the reason in `ConfigFieldControl`: a native number input
    reports a typo as empty, which would silently delete the setting. Its keypad follows the rule:
    numeric for a whole number, decimal otherwise, the full keyboard if it admits a negative.
  - The rule describes and never refuses. The save does not parse a kind's config schema (dispatch
    and Test connection do), so in a drawer a value out of range stays the kind's advisory. On the
    canvas, Apply already refuses it through the activity's schema.
- **An enum's values are named too.** Add `options: optionTitles(enumSchema, { value: 'Name' })`
  to the same `presented(...)` call. The select shows the name and stores the value; a value left
  unnamed is a type error, and each catalog's "every enum value has a display name" test catches an
  enum field with no names at all. Descriptions use the names ("Append adds the rows"), not the
  values.
- **The gate walks into rows.** A row list's enum cell (a message's Role, a mapping's Type and On
  error) is a select of its own, so tag the element's enum the same way. The gate reports it as
  `messages[].role.user`, `outputSchema.properties.*.type.integer`.
- **Value types use one table, `VALUE_TYPE_TITLES`** ("String", "Integer", "JSON"), in pickers and
  read-only text alike: `optionTitles(typeEnum, VALUE_TYPE_TITLES)`. They are capitalised rather than
  reworded, because messages cite the stored value (`expected number`).
- Kinds and other enum identifiers show a display name (`CONNECTION_KIND_LABELS`,
  `DATASET_KIND_LABELS`, `TRIGGER_MODE_LABELS`,
  `CONCURRENCY_POLICY_LABELS`, `CONTAINER_KIND_LABELS`). The stored value stays the identifier.
- **A connection kind, a dataset kind and a trigger mode also show an icon** (`lib/kindIcons.ts`, drawn by `lib/KindName.tsx`):
  `ConnectionKindName`, `DatasetKindName` and `TriggerModeName` in the lists and on the dataset
  page, and the chosen kind's `KindGlyph` beside the form's Kind or Mode picker, since a native
  option cannot hold one. Icons go by family, not vendor (every LLM kind is the sparkle), and
  reuse the shape `activityIcon.ts` draws for the same act (a test pins the pairs). The glyphs are
  the unsized variants, so they take the text's size, and muted, so the name stays what is read;
  the icon is `aria-hidden`. A picker uses `KindSelect`. Kinds named in prose or in a native option
  (a store picker's "Warehouse (PostgreSQL)") stay text.
- **Under the Kind or Mode picker, one line says what the chosen kind is** (#1413):
  `CONNECTION_KIND_DESCRIPTIONS`, `DATASET_KIND_DESCRIPTIONS` and `TRIGGER_MODE_DESCRIPTIONS`
  in shared, beside the label maps. `LabelledControl`'s `hint` draws it as a `.field-hint` and hands
  its id to the picker's `aria-describedby`. `kind-descriptions.test.ts` holds them to the house
  rule activities follow: one sentence, not the name, no two the same. A description says what the
  kind is, not its build status; a limit such as "continuous is not dispatched yet" is the form's
  own note.
- A field's title must not contain another label on the same form ("Name", "Kind", "Store"):
  label lookups by substring, in tests and in assistive tech, would then find two controls.
- **Required fields get an asterisk and `aria-required`** (native `required` on a plain input).
  Optional fields are unmarked: no label carries an "(optional)" suffix. The asterisk is
  `RequiredMark`.
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

The prompt itself is `UnsavedChangesPrompt` (`lib/form/UnsavedChangesPrompt.tsx`), so the wording
and the buttons are one copy wherever it appears.

**The pipeline editor** holds its unsaved draft with the same guard, called as
`useUnsavedChangesGuard(dirty, { holdRoute: leavesPath })`:

- The draft lives in the editor's own store, so leaving the editor's path throws it away. That
  covers Back to pipelines, another pipeline in the Factory Resources tree, and Open run.
  `leavesPath` holds only those navigations. A same-path change keeps the editor mounted, and the
  draft with it.
- The prompt shows over the canvas (`.editor-leave-prompt`, fixed), so asking does not move the
  editor (#1393). It takes focus, and Keep or Escape gives focus back to where it was.
- While it asks, the editor's keyboard shortcuts (Delete, undo, copy and paste) do nothing. The
  prompt is not modal, so this is checked in the shortcut handler rather than at the prompt.

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
- **A list whose rows are each a group of controls keys every control, not the list.** The trigger
  form's run windows do this: each row's Start, End and Days are fields keyed by their write path
  (`runWindows.1.end`, labelled "Window 2 end"). A refusal then sits beside the faulty row's control,
  and Save focuses that control, not the list's first one. The list keeps its own key
  (`runWindows`) for an issue no row control owns. Keys go by row INDEX because they must match the
  payload path that a server refusal carries. So when a row is removed, the editor calls
  `validation.rekey`. That drops the removed row's state and moves each later row's state up a
  place with its row. Otherwise a refusal held for window 3 would stay at index 2, beside whichever
  row now holds it.
- **A field that is read-only on an edit is not a field to fix.** `labelOf` stops naming it (a
  replaced secret's or a stored global's Name), so nothing is checked or filed there.
- **A conflict on the name is the Name's error.** A 409 from a create, where the name is the only
  thing that can collide, goes beside the Name (`showRefusedFields`), not into the footer's message.
- **Under `noValidate`, `FormDrawer` refuses bad input itself.** A native `type="number"` holding
  `1e`, or a half-typed `datetime-local`, reports `value === ''` and sets `validity.badInput`. The
  browser refused such a submit; with its check off, a page reading the value would see a blank and
  quietly drop the bound or cap. So when `validation` is passed, `FormDrawer` looks for such a
  control (`firstBadInput`) before calling the page's submit, and refuses in its place
  (`refuseBadInput`). Every failing check is raised, as on a Save. On a field of the form the
  message goes beside it; on any other control (a trigger mode editor's date) it is the alert's
  `notice`. Focus goes to the first invalid field, or to the control when nothing else is invalid.
  No page needs to remember to do this.
- **Hand-written controls join with `validation.attrsFor(key, errorId)`** and a `FieldError` under
  them with that id. `fieldAttrs` stays for a control that must say more (a hint, a row list).
- **The trigger form checks its own fields only**: Name, the binding (an enabled trigger must be
  bound), Max parallel runs and Params. Max is read as Save reads it (`Number`), so `1e2` passes;
  empty, `0`, `-1` and `1.5` do not. Its mode editors (recurrence, tumbling window, event, run
  windows) still refuse with the footer's one message on Save, from their converters. Moving them
  onto field keys is a later slice.
- The canvas's `DraftNumberField` uses the same `FieldError` with `role="alert"`, because there is no
  summary on the canvas to announce it.

## The node property panel

- **Under the node's name, one line says what the activity does and names its type**
  (`Copy rows from a source dataset … \`copy\``, #1413). The sentence is the catalog entry's
  required `description`, which also titles the item in the Activities palette, so the hover and the
  panel cannot disagree. `registry.test.ts` holds every description to one sentence: not blank, not
  the title, ending in a full stop, at most 120 characters, and no two the same. A type the catalog
  does not know gets no line. A container's panel does the same with its palette description and
  its kind (`foreach`, `loop`, `stage`).
- **Activity config fields are titled like any other form's** (#1396 slice 7). Every field of every
  activity the generic form renders, and every container setting, carries `presented(...)`, pinned
  by `catalog/__tests__/activity-labels.test.ts`. A structural call (`execute_pipeline`) is authored
  by `CallPanel` and is not part of that gate.
- **No title may contain another label on the panel, or sit inside one.** The panel adds its own
  labels around the activity's fields (Connection, Source/Sink dataset, Declared variable, container
  membership, the General tab's policy), so the check runs on the RENDERED panel:
  `NodePanelLabels.test.tsx`, with one row in every row list and an override row for every setting of
  the bound connection. This is why `prompt` is "User prompt" beside "System prompt", `variable` is
  "Variable name" beside "Declared variable", `url` is "Request URL" beside a "Base URL" override,
  `model` is "Model for this step" beside "Default model", `tools` is "Tool definitions" beside its
  `tools row 1 …` cells, and the connection's own `headers` is "Default headers". Buttons are not
  checked: the ones named by key (below) would always match a title that spells the key.
- A field that must be a whole `${}` expression says so in its hint. The duration fields (`wait`,
  `webhook`) also give an example the save gate accepts ("e.g. ${30}"), pinned by a test, because a
  bare number there is refused.
- Connection and dataset pickers read `Name (Display kind)`, from `lib/resourceOptionLabel.ts`; an
  override row and its "Add … override" option use the setting's title, falling back to its key.
- What still names the KEY: the expression picker's buttons ("Insert reference into url"), a row
  list's buttons and its cells ("tools row 1 name"). The key is what a `${}` reference and a server
  message cite.
- **The Settings tab is in three sections** (`FormSection`, not collapsible), in this order:
  - *Bindings*: the connection or the source and sink pickers, their datasets and their overrides.
    An activity that binds nothing has no Bindings section.
  - *Container*: which container the activity is in (Container membership), and the New container
    form. `ContainerSection` draws this section itself.
  - *Activity settings*: the activity's own fields, Fields or JSON.

  Apply config, Duplicate node and Delete node act on the whole node and sit after every section.
  A section after the first is ruled off on its heading, not on its fieldset: a legend sits across
  the fieldset's top border and would break the line.
  A call node's settings stay as `CallPanel` heads them ("Call target", "Parameters"), followed by
  the Container section.
- **It is not a drawer.** The panel already sits beside the canvas it edits, and it applies each
  change to the editor's draft rather than saving a record, so there is no per-record Save or Cancel
  to put in a drawer footer. The editor's Save writes the draft, and its dirty dot says it is unsaved.

## Typing JSON

Every box for typing JSON uses `JsonEditor` (`lib/form/JsonEditor.tsx`). That covers Config
(JSON), a node setting of kind JSON, dataset Columns, trigger Params, call Parameters, a JSON run
parameter and a callback body. Two one-line inputs stay inputs: Global params' Value and a
pipeline parameter's default. Their refusals still say where the mistake is (below).

- **It is a native `<textarea>`.** The label pairs by `htmlFor`, and `aria-invalid` and `FieldError`
  attach as on any field. Tab leaves the box, and undo is the browser's.
- **It has a code face:** monospace, unwrapped (long lines scroll), left-to-right, with spelling and
  autocorrect off.
- **Format JSON** lays the text out as `JSON.stringify(value, null, 2)` would.
  - It moves only whitespace (`formatJsonText`), so a value is never changed: an integer past 2^53,
    `1E+2`, an escape and a duplicate key all stay as typed.
  - A form seeded with that layout stays unedited when Format is pressed.
  - The new text goes in through `insertText`, so Undo brings the old text back.
  - On text that is not JSON, Format changes nothing. It selects the mistake and shows "Not JSON
    at line 2, column 7: expected ':'" beside the button. The slot is always there and one line
    tall, so nothing moves. It is a polite live region and part of the box's description, and it
    clears as soon as the text changes.
  - Text a trimming form would accept (a no-break space or BOM around pasted JSON) is laid out as
    that form reads it.
  - The button is named "Format JSON" everywhere, so no field's `getByLabel` matches it.
    `aria-description` says which field it formats.
- **A refusal says where the mistake is:** `not valid JSON (line 2, column 7: expected ':')`. The
  forms use `notValidJson` or `describeJsonProblem` from `lib/json/jsonText.ts`, not `JSON.parse`'s
  message, because that message gives a position in some browsers and not in others.
  - Columns count characters, not UTF-16 units.
  - Where a form trims before parsing, the place is given in the text as shown.
- **Why not CodeMirror or Monaco.** Either would be a third-party dependency, with no version-check
  home until #1418 (OR25). Either would also replace the native box that the labels, the form
  validation and the e2e suite rely on. There is no line-number gutter: a textarea cannot align one
  reliably under zoom or with a horizontal scrollbar. Format selecting the mistake does that job.

## Width, and why there is no two-column grid

#1396 first asked for a two-column grid on wide screens, single column on narrow ones, with a maximum
field width. Since then the drawer has settled the layout, and a grid would have nothing to fill.

- **The form is a column at every width.** Beside the list, the drawer is 340–460px wide
  (`--drawer-width`). Two columns there would make controls about 200px wide, which is too narrow for
  a URL, a JSON box or a time zone. The node property panel is a narrow side column too.
- **The maximum field width holds when stacked too.** Under 960px the drawer stacks below the list
  and takes the content column's width. With the nav beside it, Playwright measured 543px in a
  900px window, so it is about 600px at most at the breakpoint. No form runs full-bleed, and no cap
  is needed. (A 40rem cap was tried and dropped, because it could never apply.)

A form wider than the drawer, such as a full-page editor, should revisit this rather than inherit
it.

Axe gates on every form (0 violations) belong to OR24 (#1415), which brings axe into the e2e suite.
