# UI patterns — resource forms

How every create/edit form in studio looks and behaves (#1396, OR5). Written once here; the shared
pieces live in `packages/web/src/lib/form/`. Connections, Datasets, Secrets, Global parameters and
Triggers follow it. The node property panel (and the container panel) share its labels, hints,
required marks and display names; its layout is its own, below.

## The drawer

- **Create and edit open in a drawer beside the list** (`FormDrawer`). It is a column of the page,
  not an overlay. The list stays readable, and its row actions stay clickable while a form is open.
  On narrow screens the drawer stacks under the list.
- While a drawer is open the list takes the width beside it (the page has no reading-width cap,
  #1594 OR40 S3). Where that is too narrow for the list, the list scrolls sideways inside its own
  column. It never runs under the drawer.
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
- The chrome (header, Escape, focus in and out) is `DrawerShell`. `FormDrawer` puts a `<form>` in
  it. A drawer whose act is a pick rather than a save, such as the kind gallery below, puts its body
  and footer in the shell directly, with no form and no unsaved-changes guard.
- Its measurements (header row, body and footer padding) are in "Drawers and the confirmation
  dialog" below.

### The run page's detail drawer

- An activity run opens in a drawer on the right of the run page (`RunDrawer`), fixed under the
  command bar and held inside the window, at the operator's width (dragged on its left edge).
- **From 1280px wide it pushes the page**: the page keeps a gutter the drawer's width, so the grid
  narrows rather than running under it, and the drawer is a region named "Activity run details".
  Pushing, it takes at most half the window; dragged wider, it lies over the page instead.
- **Narrower, it lies over the page** as a non-modal dialog of the same name, and the page keeps its
  width.
- Either way it traps no focus. Escape closes it while focus is inside it, and focus goes back to
  the row or graph node that opened it. It is last in the page, so Tab past its end leaves the
  document, as it would from the page's last control.

## New connection: the kind gallery

- **"New connection" opens the kind gallery first** (`ConnectionKindDrawer`), as ADF's "New linked
  service" does. Picking a kind opens that kind's form, clean and with Name focused.
  `ConnectionKindGallery` is the one gallery for every place a connection is created: Manage →
  Connections, and every activity's connection picker (below). A new kind then appears in all of them.
- Focus goes to the search box on open. Escape or Cancel closes the gallery and hands focus back to
  the button that opened it, and pressing New again starts a fresh gallery.
- Kinds are listed in `CONNECTION_KIND_GROUPS` order (Database · File · HTTP/API · AI) as compact
  name tiles, two to a row. A kind's one-line description is its tooltip and accessible
  description, not text on the page.
- Search matches the kind's label, its id and its group's label. It does not match description
  prose, because words like "file" or "API" would then match kinds that are not that.
- **A kind that cannot be used where the gallery was opened is shown disabled, with its reason**
  (`disabledReason`). It is not hidden. The tile is `aria-disabled` rather than `disabled`, so it
  stays focusable, and it is described by the reason and then the kind's description.
- The term is **kind**, as in the Kind column and the form's Kind field. ADF says "type".

## Activity connection pickers

- **One `ConnectionPicker` for every connection slot** (an activity's Connection, or a Copy's
  Source and Sink connection): the select, then **Test**, **Edit** and **New** beside it on one row,
  as icon buttons whose `title` is their accessible name (#1694 OR42), so the select keeps its width.
- **Every connection is listed, grouped by kind.** One this slot cannot use is listed disabled,
  with its reason (`connectionSlotReason`), so the picker says what exists. The bound connection
  is never disabled, whatever its kind.
- **Test** probes the saved connection that is selected; its verdict goes when the selection moves
  or the connection is edited.
- **Edit** opens the bound connection's form in the same column as New. The column reads the
  connection again first, so the form never prefills from the editor's older copy. Save updates
  every picker in the editor; a kind change this slot refuses keeps the binding and the editor
  says so. Edit is disabled when nothing is bound or the bound connection no longer exists.
- **New** opens the kind gallery, with the same reasons disabling the same kinds, then that kind's
  form, in a column beside the editor (as the Triggers column). Nothing navigates and the canvas
  draft is untouched. Create binds the new connection to the slot that asked; a form switched to a
  kind the slot refuses is created but not bound, and the editor says so.

## Sections

- The form is grouped into titled sections (`Section`, see [Sections everywhere](#sections-everywhere)):
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
  - the title, with the unit as a suffix inside the box;
  - the description, with the stored key in code type, behind a `?` beside the label (linked with
    `aria-describedby`). Write a description only where the value is not obvious (below).

  Keep the key reachable: server errors, advisories and `${}` expressions all cite it. It ends the
  `?` note, or, for a titled field with no `?`, is the label's hover `title`.
- `unit` names what the stored value is in. It never converts the value.
- **A number field says what it admits.** Its `?` note leads with the rule the schema states (with
  no `?`, the rule is still its description, out of sight), read by
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
  rule activities follow: one sentence of at most 120 characters, not the name, no two the same. A
  kind that is not built yet says "Planned:" rather than claim a behaviour (`continuous`); the form's
  own note under the picker says why.
- **Every section says what it holds** (#1413), in one line behind the `?` beside its heading
  (#1477 OR29 in the dock; every surface since #1594 OR40 S3): the UI standard keeps prose off the
  page. `Section`'s `help` is required, so a section without one does not compile. **The properties
  pane is the exception (#1694 OR42):** its section headings carry no `?`, and pass `help={null}`
  on purpose; `e2e/property-pane-ratchet.spec.ts` holds that for every catalog type. Plain copy lives
  in `FORM_SECTION_HINTS` (`web/src/lib/form/sectionHints.ts`), held to the same house rule by
  `sectionHints.test.ts`; a hint with markup (a `${…}` reference in `<code>`) is written inline. The note is the section's `aria-describedby`; the `?` is beside the
  heading, never inside it, so the section's name stays the heading alone. A hint never restates a
  note already inside its section, which a screen reader would read twice.
- **The properties pane shows no prose at all (#1694 OR42 item 4).** What a field, a list or a
  type means is its `?`, as the field's description: a list's note follows the field's own in one
  `?`, the panel header (`PanelHeader`) keeps the type's palette sentence behind one, and a
  checkbox's consequence is its `CheckboxField` note. A state line stays visible but terse, three
  words at most ("No variables declared", "No sink dataset", "Parallel (4)"), and is the control's
  description where it explains one. Warnings, errors and advisories about the current value are
  not prose. `e2e/property-pane-ratchet.spec.ts` fails on any prose line in any catalog type's
  default pane.
- **A `?` only where the value is not obvious (#1694 OR42 item 4).** A config field shows a `?`
  only when the catalog writes it a `description` in `presented()`, and the catalog writes one
  only for what an engineer would not know from the label: a default, a constraint between fields,
  a confinement, or what a whole `${}` must give. Top P, Seed, Content and Error message get none.
  A `?` holding only the key, or only a number rule that the error line states on a bad
  value, is noise. The note still leads with the rule and ends with the key; with no `?`, a
  titled label carries the key as its hover `title`. The ratchet's `HELP_LIMITS` are the measured
  counts and may only fall. The same rule holds on the connection and dataset forms, where the CSV
  and Excel header flags, Default headers, Postgres Statement timeout, sqlite and Postgres Allow
  writes, and the CLI's Command and Timeout get none;
  `e2e/resource-form-help.spec.ts` holds each kind's new form to its measured count. Those forms
  keep a `?` per section (#1413). Only the properties pane drops it.
- A field's title must not contain another field's label on the same form ("Name", "Kind",
  "Store"): label lookups by substring, in tests and in assistive tech, would then find two
  controls. A section may share its field's word ("Value"): the section is a group, not a control,
  but a test's label query then needs `FIELD` (below).
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

The prompt is an inline `alertdialog`, not `window.confirm`. Every other question the app asks
goes through the one confirmation dialog, `useConfirm` (`lib/confirm/useConfirm.tsx`, #1397), and a
lint rule forbids `window.confirm`.

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
  does not push the fields below down. In the property dock, a group of number fields shares
  **one** reserved line after the group instead (`useFieldErrorLine`, `DraftNumberField`'s
  `errorLine`). Each message is named there ("Retries: must be a whole number"), and the rows keep
  the dock's rhythm, a control and the grid gap (#1694 OR42 item 5). `fieldAttrs` gives the control:
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
  bound), Max parallel runs and Parameters. Max is read as Save reads it (`Number`), so `1e2` passes;
  empty, `0`, `-1` and `1.5` do not. Its mode editors (recurrence, tumbling window, event, run
  windows) still refuse with the footer's one message on Save, from their converters. Moving them
  onto field keys is a later slice.
- The canvas's `DraftNumberField` uses the same `FieldError` with `role="alert"`, because there is no
  summary on the canvas to announce it.

## The node property panel

- **One header row, pinned with the tab strip** (#1477 OR29): the node's name, its type id, a `?`
  holding what the activity does, then Edit as JSON, Revert, Apply config and a `⋯` menu (Duplicate
  node, then Delete node after a divider). Header and tabs stay put while a long tab scrolls under
  them (`PanelTabs`'s `header`, `.panel-tabs-sticky`). Apply's refusal shows under the header, so it
  is visible from any tab. Revert is live only once the draft differs from the node.
  The `?`'s sentence is the catalog entry's required `description`, which also titles the item in
  the Activities palette, so the hover and the panel cannot disagree (#1413). `registry.test.ts`
  holds every description to one sentence: not blank, not the title, ending in a full stop, at most
  120 characters, and no two the same. A type the catalog does not know gets no `?`. A container's
  panel shows its palette description and its kind (`foreach`, `loop`, `stage`).
- **A container's settings are on tabs too** (#1477), from `containerTabs.ts`: ForEach is Items ·
  Concurrency · Settings, Until is Condition · Settings, Stage is Settings (`join`). A field the
  table does not place lands on the last tab. A field that is not valid on the kind (a repair) stays
  below the tabs, with Apply, so it is in view from any tab. A tab with an unapplied edit gets the
  `•`, and a refused Apply names the tab its field is on (`refusalLead`, shared with the node
  panel). The strip is not pinned and the choice is not kept across containers: the panel is short,
  and each kind has its own tabs.
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
  `model` is "Model for this step" beside "Default model", and the connection's own `headers` is
  "Default headers". A row list's cells open with its title ("Tool definitions row 1 name"); they
  are the list's own and do not clash with it. Buttons are not checked: the expression picker's are
  named by key (below) and would always match a title that spells the key.
- A field that must be a whole `${}` expression says so in its hint. The duration fields (`wait`,
  `webhook`) also give an example the save gate accepts ("e.g. ${30}"), pinned by a test, because a
  bare number there is refused.
- Connection and dataset pickers read `Name (Display kind)`, from `lib/resourceOptionLabel.ts`; an
  override row uses the setting's title, falling back to its key.
- **A bound end's overrides are a name/value table** (#1694 OR42 item 8, after ADF's *Dataset
  properties*), directly under the picker. Every setting the resource declares overridable is a
  row, blank until typed into, with the resource's own value as its placeholder. Clearing a box
  removes its override, so there is no Add control, and an empty-string override cannot be authored
  there. A stored key the resource does not declare is a row too, flagged, and only its ✕ removes
  it. A resource that declares nothing shows no table at all, as ADF shows no Dataset properties
  for an unparameterised dataset.
- What still names the KEY: a top-level field's expression picker buttons ("Insert reference into
  url"). The key is what a `${}` reference and a server message cite. A row cell's buttons follow
  the cell's name ("Insert reference into column mapping row 1 expression").
- **An activity's tabs are declared in its catalog entry** (#1477 OR29): *General* (*Basics*, the
  description, then *Run policy*; #1600 C0b) first, then the entry's `tabs`, from one fixed vocabulary (`ACTIVITY_TAB_KEYS`: Settings, Source,
  Sink, Mapping, Request, Auth, Model, Prompt, Tools, Output, Location, Content), so a tab is named
  the same on every activity that has one.
  - Each tab lists its config keys, required first, and the binding slots it draws (a connection
    with its overrides, a source or sink connection, a source or sink dataset with its overrides).
    `activity-tabs.test.ts` holds every schema key to exactly one tab and every slot the entry has
    to exactly one place.
  - The node opens on its first TYPE tab, where its required settings are. The dock remembers the
    last tab chosen; a node without that tab opens on its first type tab, and the choice is kept for
    the next node that has it.
  - No tab carries container membership (#1597). It is a canvas fact, as in ADF: drag an activity
    into a box, or use the activity's context menu, **Move into ▸** / **Remove from *name*** (the
    keyboard route, raised with the Menu key or Shift+F10). Both go through one confirm-and-apply
    path and one Undo.
  - JSON mode edits the whole config as one document. It shows on the tab the author is on, under
    that tab's bindings; Apply always reads every tab's fields.
  - A call node has General and Settings: `CallPanel` heads its parts ("Call target",
    "Parameters") and applies them itself. Its header has no
    Apply, Revert or JSON toggle.
- **It is not a drawer.** The panel already sits beside the canvas it edits, and it applies each
  change to the editor's draft rather than saving a record, so there is no per-record Save or Cancel
  to put in a drawer footer. The editor's Save writes the draft, and its dirty dot says it is unsaved.
- **Expand properties** (the header's ⤢, #1477 OR29) moves the same panel over the canvas as a
  full-height drawer on the right, for long forms such as prompts, mappings and JSON. It is still
  not a form drawer: no Save or Cancel, and Apply works as it does docked.
  - It is the SAME element with a class, never a second tree, so an unapplied edit survives both
    ways.
  - A strip of canvas stays visible on the left; selecting an activity there shows it in the drawer.
  - Escape (from inside the dock) or Back to dock returns it. An open picker list or help popover
    takes the first Escape. Escape on the canvas keeps its own meaning.
  - It is a moment's mode, not a preference: a reload or folding the dock docks it again. Dock to
    bottom/right is hidden while it is expanded.

## Typing JSON

Every box for typing JSON uses `JsonEditor` (`lib/form/JsonEditor.tsx`). That covers Config
(JSON), a node setting of kind JSON, dataset Columns, trigger Parameters, call Parameters, a JSON run
parameter and a callback body. Two one-line inputs stay inputs: Global params' Value and a
pipeline parameter's default. Their refusals still say where the mistake is (below).

- **It is a native `<textarea>`.** The label pairs by `htmlFor`, and `aria-invalid` and `FieldError`
  attach as on any field. Tab leaves the box, and undo is the browser's.
- **It has a code face:** monospace, unwrapped (long lines scroll), left-to-right, with spelling and
  autocorrect off.
- **Size.** In the properties pane a JSON box expands on edit like a text box (see *Expand on
  edit*), and Edit as JSON's box is as tall as its config up to its cap. Elsewhere it is a fixed
  number of rows.
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

## Density

Compact is the default and comfortable is a per-viewer setting (Settings → Appearance → Density,
`uiStore.density`, mirrored onto `<html data-density>`), per the UI standard and #1477 OR29.
Compact means 13px field text, 12px labels, 28px single-line
controls, and 4/8px spacing. Those numbers are the design tokens in `theme/tokens.css` (#1594
OR40 S1), which hold both densities' values: `--control-h`, `--row-h`, `--type-body-size`,
`--type-caption-size` and `--space-1..6`, plus the `--type-*` font shorthands. Read the tokens
rather than repeating the numbers; `theme/tokens.test.ts` refuses any literal outside them.
Weights are 400 and 600 only: `tokens.css` sets `b` and `strong` to `--weight-strong`, since the
browser's `bolder` draws them at 700 (#1594 OR40 S6g).

Controls take the density app-wide through the control layer (below), icon buttons and tabs
included. A dock label is caption type in both densities (#1594 OR40 S6l); its hint sizes are
still scoped to the compact dock's panel.
`e2e/property-dock-density.spec.ts` measures the dock at 1440x900.

## Controls

One look per control type (#1594 OR40 S2a), from the tokens, in both densities. The layer is in
`index.css` beside the bare `button` rule.

- **Inputs, selects and textareas:** `--control-h` tall (a textarea sizes to its text), 1px
  `--border`, `--radius-control`, body type, accent border on hover, `--error` border on
  `aria-invalid`, 0.6 opacity when disabled. The layer is at zero specificity (`:where()`), so a
  component rule still wins. Do not add a new per-form skin; delete one when you touch it. Known
  leftovers for S6: `.json-editor-input`, `.run-filters` and the page search boxes, which set
  their own padding or width. S6i moved the left panes' filters and the inline name form onto
  the layer; the name form keeps only its accent edge.
- **Buttons, three variants:** secondary is a bare `<button>`, primary is `className="primary"`,
  and subtle (toolbar and icon, #1594 OR40 S2b) has two class names for one variant: `subtle` for
  a text button and `icon-button` for a glyph. `danger` is a colour tone of secondary, not a fourth
  variant. An unclassed button and the variants are at least `--control-h` tall. A classed one-off
  button keeps its own size until S3/S6 moves it.
  - **Subtle** has no fill and a transparent border at rest (so it is the same box as a secondary
    beside it), and `--panel-2` on hover. An open disclosure (`aria-expanded="true"`) gets an
    accent underline, so open never looks merely hovered.
  - **An icon button** is a `--control-h` square with no border and an `--icon-size` glyph (16px
    compact, 20px comfortable; the Fluent icons are `1em`, so the button's font-size is the glyph).
    A call site sets only its rest colour or tone; never a size. The per-family sizes it replaced
    (the editor header's 32px, the dock's 24px, the resource pane's and row menus' 26px, the pane
    toggle's padded 18px, the toolbox fold's bare glyph) are gone. Give an icon button an
    `aria-label` and a matching `title`.
  - **Not icon buttons, so they keep their own box and glyph** (each overrides the square): the
    disclosure twisties (`.factory-resources__disclosure`, `.runs-grid__disclosure`), the
    toolbox's labelled group headings (`.activity-toolbox__disclosure`, `height: auto`), and the
    icon link `.run-editor-link`. The in-canvas
    ghosts (`.flow-container-*`, `.canvas-refusal button`) and the link-like buttons (`.sort-button`,
    `.form-errors-link`) are S6's.
- **Tabs, one style:** `PanelTabs` (Fluent's `TabList`) is the only tab list; use it, never a
  look-alike. A tab is body type in a `--control-h` box with `--space-2` side padding; selected is
  body-strong. Fluent draws a hidden semibold copy of an unselected tab's label to reserve the
  selected width, and that copy takes body-strong too, so selecting a tab moves no tab.
- **Tabs, one keyboard model (#1594 OR40 S5c):** `PanelTabs` keeps Fluent's look but not its
  keyboard handling. Only the selected tab is a tab stop; the arrows move along the strip and wrap
  (flipped right to left), Home and End go to its ends, and Enter, Space or a click selects.
  Tabster's arrow-navigation mover is switched off, because its focusable `aria-hidden` dummies
  fail axe's `aria-hidden-focus`.
- **The property dock's strip** is the dock's name (`Properties`, and `N selected` while folded
  with a selection), the Problems disclosure as a subtle button, then the icon acts at the far end:
  Paste, Expand, the dock's position (`Dock to right` / `Dock to bottom`) and its fold (`Hide
  properties` / `Show properties`, chevron pointing where the dock goes). Properties and Problems
  are deliberately **not** a tablist: Problems shows *with* the properties (a resizable column
  beside them, or stacked under them docked right), and tab semantics would say one panel at a
  time. Problems opens only on request (the toggle, or Validate when it finds something) and only
  while it lists something; it closes when the last problem goes, and with nothing to list the
  toggle is `aria-disabled` with the title "No problems" (#1694 OR42).
- **The panel header's draft acts** (#1694 OR42) are the JSON toggle and Revert as icon buttons, and
  Apply as a short primary `Apply` named "Apply config". They show only on a tab that holds the
  config draft, never on General, which writes straight to the node.
- **Checkboxes and radios** sit beside their words: box, 8px, label. A `<label>` wrapping the input
  is all it takes. Keep `contract-check` on the dock's checkbox labels: the form layout lists it
  among the labels that sit under the label column (`formLayout.test.ts`).
- **One focus ring:** 2px `--accent`, 1px outside, `:focus-visible` only, on everything, canvas
  nodes included. An element that fills a clipping container (a rail link, a grid resizer, a
  splitter) keeps the ring and sets only `outline-offset: var(--focus-ring-inset)`. Restate the
  outline itself only where a third-party rule removes it: a canvas node (React Flow, drawn at
  `--focus-ring-outset` so it clears the node's own selection or issue ring) and the connection
  picker's Fluent input. Fluent's controls keep Fluent's own indicator.

`e2e/control-layer.spec.ts` measures all of this at 1440x900, in both densities.

## Page header, toolbar and content frame

Every page's title row is `PageHeader` (`lib/PageHeader.tsx`, #1594 OR40 S3). Never write a
`.page-header` by hand.

- **The row** is `--header-h` (40px in both densities): the title on the left, then an optional
  `adornment` (the editor's state badge and notices, the run page's editor link), then the toolbar
  at the right end. The title is the page's one `h1`, in the title type (20/600), and ellipsizes first; pass the
  full name as `headingTitle` where a name can be long.
- **The page's `?`** (`help`, #1594 OR40 S6d) sits right after the title: "About {title}", one
  sentence saying what the page holds, in place of a paragraph under the title. Its note opens under
  the header row, at the row's width. It needs a plain-text title and a `headingId`; the page's
  `<section aria-labelledby>` takes `aria-describedby={pageHelpId(headingId)}`, so the note is the
  page's description. The five Manage lists, Pipelines, Runs and AI activity use it. A page whose
  sections each have a `?` (Home, Settings, Git) needs none. A warning an operator must see stays
  visible where it applies (the global parameter Value field's cleartext hint), never behind a `?`.
- **The toolbar** is the header's children, wrapped in `Toolbar`. Controls are 8px apart, every one
  `--control-h` tall, and centred on one line. A Fluent (toggle) button and a `.page-back` link are
  sized to match inside it. Separate groups with `ToolbarDivider` (a 1px rule with the gap either
  side). A label never wraps; a search box is the one control that gives way. The toolbar is not a
  `role="toolbar"`, because it does not implement arrow-key movement; each control keeps its own tab
  stop.
- **A form's add actions** (*Add parameter*, *Add column mapping row*, *Auto-map columns*) sit in
  `<Toolbar align="start">`, ABOVE the rows they add to (ADF's *＋ New*), packed left and sized to
  their text; a pane's own acts at its foot (*Apply call*, *Copy container*) use the same row. Never
  a bare button stretched across the form by its flex column (#1694 OR42).
- **The content frame** is `.content`'s 16px padding on every page, so every title starts at the
  same left edge (the editor keeps the same sides and drops the top and bottom). There is no
  reading-width cap: grids use the width, and a form caps its controls, not the page.
- **A section's heading row** (its heading and its actions, inside a page) is `Section`'s, below.
  It is not a page header.

`e2e/page-header.spec.ts` measures every page at 1440x900 in both densities.

## Left panes (#1594 OR40 S6i)

The hub pane, Factory resources and the Activities toolbox. A pane or tree row is `--row-h`; a
filter, a palette row and the inline name form's controls are `--control-h` from the control
layer, with no skin of their own. The pane's title, filter and first-level chevron glyph share its
12px edge, and each tree level indents 24px, so a name sits under its parent's label. The inline name form puts its field on a line of its own and its
buttons together under it. A long palette name wraps rather than truncating, because the row's
tooltip holds the description, not the name. The action error's Dismiss is a `subtle` button.

`e2e/left-pane-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## Editor header (#1594 OR40 S6j)

The pipeline editor's header row, its status strip and the Trigger now and Debug panels.

- **State badge:** its pills are the shared status pill (`--radius-pill`, `0 8px`), 4px apart. Save's
  dirty mark sits 4px after the label.
- **Status strip:** body type, 12px between its slots. `+N more` is a `subtle` button, and its list
  is a surface (12px padding, 8px between messages, `--radius-surface`). The standing banner in
  the strip is one line: `0 8px` padding, 12px before its actions.
- **Run panels:** a surface with 12px padding and 8px between its parts. The heading is the global
  h2 (the section step), and no paragraph inside carries a margin. Parameters are stacked fields,
  the same rule as the connection, dataset and trigger forms. The refusal line is `.form-error`,
  in `--error`, which also colours every other form's error line.
- **Shared with every form:** `.form-actions` is 8px apart. The JSON editor's text is the body step
  in the mono stack, its Format button is `subtle`, and its problem line is caption.

`e2e/editor-header-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## Canvas chrome (#1594 OR40 S6k)

What the editor draws over the canvas: the empty-canvas guide, the implicit-chain advisory, the
connect refusal, the minimap and zoom controls, the version preview bar and the leave prompt.

- **Panels:** every React Flow panel (minimap, controls, advisory, refusal) sits 16px in from the
  pane's edge. React Flow's own 15px loses to `.react-flow .react-flow__panel`. The advisory and the
  refusal share one surface, `8px 12px` in body type at `--radius-surface`, and differ only in tone:
  muted text and border for the advisory, `--error` border for the refusal. The zoom controls'
  buttons are still React Flow's own; only their panel's inset is on the scale.
- **Refusal:** the back-edge offer is a secondary button and the dismiss is an `.icon-button`, both
  `--control-h`. Neither shrinks or wraps beside a long reason.
- **Empty-canvas guide:** a 12px card in body type at `--radius-surface`, 8px between the lead and
  the templates and between templates. Each template is a `8px 12px` button with its title in
  strong body and its description in caption. The lead ends on a colon because it is a sentence
  introducing the list, not a label.
- **Version preview:** 12px between the bar and the canvas. The bar is `8px 12px` with 12px between
  its parts, and its label has no trailing period. Its refusal line is body type in `--warning`.
- **Leave prompt:** a 12px surface at `--radius-surface`, 8px under its message.
- **Status strip:** one control plus 4px above and below (`--editor-strip-h`: 36px compact, 40px
  comfortable, inside the 40px header row). A standing banner takes the strip's height, so its
  buttons never touch its border.

`e2e/canvas-chrome-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## Property dock and Problems (#1594 OR40 S6l)

The editor's properties dock (every tab of the pipeline, an activity, a call and an edge) and its
Problems column.

- **One bordered group:** a fieldset gathering a few related controls under a legend is `8px 12px`
  inside a 1px border at `--radius-surface`, with its legend in muted caption type, `0 4px`. The
  trigger form's builders, a bound end's parameter overrides and their allowlist, an edge's outcome
  and a call's target share this one rule in `index.css`; a new group adds itself to its selector
  lists rather than copying the skin.
- **Option rows:** an edge's outcomes and a call's target modes are full-width rows at `--control-h`,
  `0 8px` at `--radius-control`, in caption type, the chosen one in strong.
- **Labels:** caption type in both densities; the field text and the controls are what grow with
  comfortable. The panel's acts are `--control-h` with 8px between them, and the node's type code is
  caption.
- **Problems:** the list is `8px 12px` in body type at `--radius-surface`, its items 4px under the
  heading and indented 16px. The count beside the Problems toggle is a caption pill. Warnings (#1669:
  a doc that saves but fails or skips at run) are a second list under the errors, edged in
  `--warning`, with their own `--warning` pill beside the error count. They never refuse Save or
  Debug, and are not attributed to a card.
- **The `ƒx` toggle** under a field is a `--control-h` button in caption type.

`e2e/dock-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## The dock's details (#1594 OR40 S6m)

The pieces inside the dock's fields: a row table's cells, the `${}` and `ƒx` lists, the `?`, and the
editor's run drawer.

- **Row tables:** a cell's control and the note or list under it are 4px apart; a row's acts are
  `--control-h` with 4px between them. A cell's text box is one line centred in `--control-h`
  (`--cell-text-line`: the caption's 16px leading compact, the body's 20px comfortable, with
  `--cell-text-inset` above and below) and grows a line at a time.
- **The `${}` and `ƒx` lists** open 4px under their toggle, `8px` inside a 1px border at
  `--radius-surface`. A group heading is 8px above and 4px under; rows are `4px 8px` with no gap
  between them, and every line in them is on the ramp (a type or a note is caption, never smaller).
  An example's expression and its result are 8px apart.
- **The `?`** (`HelpDisclosure`) is a circle at `--icon-size` (16px compact, 20px comfortable) with
  the glyph in caption type at its centre. Its note is unchanged.
- **The editor's run drawer** is the run page's activity panel (`.node-detail-panel`) 12px under the
  node's properties; it measured clean, so it has no rules of its own.

`e2e/dock-details-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## Canvas nodes, ports, containers and the Graph tab (#1594 OR40 S6n)

The boxes on the authoring canvas and on the run page's Graph tab.

- **Activity card:** `8px 12px` at `--radius-surface`, body type, the glyph at `--icon-size` 8px
  from the name. The name is body strong (two lines at most), 4px above the summary row; that row is
  one body line tall (20px) in caption type, so a bordered badge (`0 4px` at `--radius-control`) fits
  inside it and filling a field never resizes the box.
- **Issue count:** a circle at `--icon-size`, centred on the card's top-right corner, caption type
  at strong weight; a two-digit count grows it into a pill.
- **Port and edge labels:** caption type. A port label is a chip, `0 4px` at `--radius-control`.
  React Flow draws an edge label at 10px; `index.css` puts it on the ramp. Both are drawn at opacity
  0 until hover, focus or selection, so the ramp check measures them without a hover. A port label
  sits 8px past the card's edge.
- **Container:** a dashed box at `--radius-surface`. Its kind label sits 4px down and 12px in, in
  caption type; its configure and delete buttons are body type and keep their 22px targets, because
  the 26px header band (`CONTAINER_HEADER_HEIGHT`) has no room for `--control-h`.
- **Graph tab:** the frame is at `--radius-surface`. A run card is the authoring card plus a foot
  4px under it. The foot takes caption type once, for the status and the facts, so it is 16px tall
  and the card still fits `RUN_NODE_BASE_HEIGHT` (104px) in both densities.
- **The editor's run chip** under a card is caption type, 8px from its tone rule, 8px between its
  parts.

`e2e/canvas-nodes-design.spec.ts` measures them at 1440x900, compact light and comfortable dark.

## The run page's banner and activity runs, and the Runs page's spend (#1594 OR40 S6o)

- **Failure banner:** `4px 12px` in body type, 8px above the activity runs, its parts 4px apart
  vertically and 12px across, and its acts 12px apart. "Show activity" is the shared button at
  `--control-h`.
- **Activity runs:** the bar's heading and filters are 8px apart, with 4px above them, in body
  type. A nested line is indented 16px a level on the cell's own 8px (24px, then 40px), a group
  line is body strong, and a toggle's chevron is 4px from its label.
- **Lifetime spend:** one flex line with its parts 4px apart, wrapping as a whole at a narrow width. Its `?` is the shared one
  (`HelpDisclosure`, inline), so its caveats are a note anchored to the line, opened by a click or
  the keyboard. It was a Fluent tooltip, the app's one other `?` look.
- **Runs grid:** the editor icon is `--icon-size` in its 24px target at `--radius-control`, 4px from
  the pipeline's name; a time column's zone is regular weight in its body-strong header. A child
  run is indented 16px (`--space-4`) a level, its disclosure 4px from its name.
- **Small print:** a copy result, a rerun's start time and the Trigger now drawer's version are
  caption type.

`e2e/run-details-design.spec.ts` measures the banner, the activity runs, the spend line and the
grid's pieces at 1440x900, compact light and comfortable dark; `run-list.spec.ts` measures a child
run's indent. The small print is held by the literal rule only.

## Monitor › AI activity (#1594 OR40 S6r)

- **Header:** the title's `?` says what the page covers. The window picker's label and the figures'
  "Activity as of" line (the Runs page's `.runs-live-status`) sit in the toolbar, in muted caption
  type, the label 8px from its select.
- **Figures:** a `.run-meta` facts list (term, value), never KPI tiles. Agent CLI subprocesses are
  one of the facts, because they are not token-metered and would otherwise print zeros under
  Tokens. A value is a figure or a short phrase, not a sentence.
- **Quota:** an unreadable provider reads "Claude quota unreadable." in sentence case, in a notice and
  never as a number. The reset's relative half is caption type.
- **Token-flow chart:** caption type for its caption, axis and legend, 16px above it. Its marks
  take `--mark-gap` (the 2px surface gap between bars and between stacked segments) and
  `--radius-mark` (2px, since a bar can be 2px wide and `--radius-control` would round it into a
  pill).

`e2e/ai-activity-design.spec.ts` measures the page at 1440x900, compact light and comfortable dark,
with data in every section (stubbed). It also checks every visible text node for ALL CAPS
(`allCapsText` in `e2e/support/allCaps.ts`, beside S4's `capitals`, both on `lib/words.ts`'s
acronyms).

## The shell: rail, version, update banner and command bar (#1594 OR40 S6p)

- **Hub rail:** 8px above the wordmark and 4px below the foot. The wordmark is caption type at 600,
  8px above the links. A link's glyph is `--icon-size-nav`, Fluent's 20px navigation size, in both
  densities: the rail is a fixed 48px and its links 44px, so it does not take `--icon-size`. The
  active link's bar is 8px from the link's top and bottom with a `--radius-control` right edge.
- **Version badge:** caption type, 4px in. A version is wider than the rail, so it wraps and is
  centred; `VersionBadge` offers a break after each `.` and `-` (`0.10.` / `12`), never
  mid-number. Its tooltip and accessible name carry it whole.
- **Update banner:** body type, `4px 16px`, so its text starts at the content frame's x. It has its
  own row in the workspace (command bar, banner, page), so the page under it still starts where it
  ends and fills the rest of the viewport. With no banner, that row is 0px.
- **Command bar:** `--header-h` tall, 16px in like the content frame, its parts 8px apart. The
  breadcrumb is body type, its crumbs 4px either side of the `›`, the current page body strong.

`e2e/shell-design.spec.ts` measures all of these at 1440x900, compact light and comfortable dark,
with an update mocked in, on a page short enough that a banner on the wrong track would grow.

## Drawers and the confirmation dialog (#1594 OR40 S6q)

- **Drawer chrome** (`DrawerShell`, so every side drawer and the kind gallery): `--radius-surface`.
  The header is the page header's `--header-h` row, 16px in, with its Close centred on the title.
  The body is 16px in on every side; the sticky footer is 8px by 16px.
- **A resource form has no box of its own.** `.connection-form`, `.dataset-form` and
  `.trigger-form` are always a `FormDrawer`'s `<form>`, so the drawer is the panel. Their old panel
  skin, and the reset that cancelled it inside the drawer, are gone.
- **A run window** (`.run-window-row`) is the one bordered group, like the trigger form's other
  builders. Its day checkboxes wrap 4px by 16px apart.
- **The footer's alert** (`.form-errors`): 8px above the actions, 4px under its message line, its
  list 16px in.
- **The confirmation dialog**: its message and typed-name prompt are body type (Fluent's
  `DialogContent` sets 14px, off the compact ramp). Paragraphs are 8px apart, the typed-name field
  12px under them with its label 4px above it.

`e2e/drawers-design.spec.ts` measures the trigger form (with a run window and a refused Create),
the Trigger now drawer and a typed-name confirmation at 1440x900, compact light and comfortable
dark.

## Tables (#1594 OR40 S3d)

Every table in the app, whether a list, a run's facts or a form's rows, takes one style from the
element rules in `index.css` (`table`, `th, td`). Never give a table its own row height, padding
or header type.

- **A row** is `--row-h`: 32px compact, 36px comfortable. A cell is 8px either side and vertically
  centred (a form's rows excepted, below).
- **A column header** is body-strong (13/600 compact, 14/600 comfortable), muted, and never wraps.
  A row header (`<th scope="row">`, a variable's name) may wrap.
- **A number** is `className="num"` on its header and its cells: right-aligned, in tabular
  figures. A run's cost is one (`num run-cost`).
- **An id or a value** is `<code>` (or `CopyableId`), so it is in the mono face.
- **A list's free text is one line.** A cell that can be long (a name, a path, an audit entry, an
  event's detail, an activity run's error) is wrapped in `OneLine` (`lib/OneLine.tsx`). It cuts at a
  fixed 18rem (40rem with `wide`, for a table's one long column, but never more than 45% of the
  window) and puts the whole text in its tooltip. A link inside it draws its focus ring inset. The cap is fixed
  rather than the column's width, so a name can be cut while its column still has room. A table in
  automatic layout has no column width to cut to, and that cost is accepted.
- **The grids** (Runs, Pipelines) cut every cell at its column's width (`table-layout: fixed`). Any
  `title` a cell sets therefore leads with the cell's whole text, and the secondary detail follows
  it: a pipeline's version id, a rerun's source run, a cost's caveat. A status pill in a grid cell
  ellipsises its own word inside a whole ring, and the cell's `title` says the word (#1626).
- **Exempt from one line, on purpose:** prose, logs and block values, which grow their row instead.
  These are a diagnostic's explanation, a dataset reference's mapping verdict, a streamed log line's
  value (the drawer is where it is read), and a variable's or global's capped JSON value on the run
  page. The activity runs table scrolls sideways in its own box rather than cutting its columns;
  fitting it to the page is S6's.
- **A form's rows** (`RowTable`) keep their own cell padding: `--row-cell-inset` (what is left of
  `--row-h` around a bare `--control-h` control) above and below, 4px either side, top-aligned. That
  is a 28px control in a 32px row compact, and 32 in 36 comfortable. Their header is the same
  body-strong as every table's, but only as tall as its words, so the dock's required fields still
  fit (#1477 OR29). A row's notes row (`RowNotes`) takes its own height, so it hangs under its row
  as one entry.
- **An id's Copy** (`CopyableId`) is an icon button, as in ADF, so the Runs grid's ID column holds
  the id and its button without clipping either.

`e2e/table-style.spec.ts` measures the lists, the grids and the run page at 1440x900 in both
densities: row heights, header type, cell padding, numbers, the mono face, and that every cut cell's
tooltip holds its whole text.

## Sections everywhere

Every titled part of a form, a panel or a page is `Section` (`lib/Section.tsx`, #1594 OR40 S3). It
replaced `FormSection` (a drawer's `fieldset` and `legend`), `DockSection` (the dock's `h4`) and
`.panel-heading-row`. Never write a section heading by hand.

- **The heading** is in the section type (14/600 compact, 16/600 comfortable), sentence case. It
  is an `h3` under a drawer or panel title (`h2`) and an `h2` under a page title (`level={2}`).
- **The heading row** holds the heading, its `?` (none with `help={null}`, the properties pane) and,
  optionally, `actions`: a `Toolbar` at the row's right end (the Monitor's Refresh quota).
- **Spacing:** the content starts 8px under the heading row, and its fields are 8px apart. Every
  container that holds sections stacks at 8px (`.form-drawer-body`, `.property-panel`,
  `.panel-tab`), and a section that follows anything takes 8px more, so sections are 16px apart.
  No rule is drawn between sections. A page section's own rule (`.monitor-panel`) sets its margin.
- **Semantics:** a section is a `group` named by its heading. Use `landmark` only for a section
  that is itself a top-level part of a page (a `region`: the Monitor's account quota, a run's
  diagnostics). Inside a form or a panel, which is already a named part of the page, another
  landmark is noise. A field whose label is the same word as its section ("Value") needs a field
  query in tests (`FIELD` in `web/src/testing/fieldQuery.ts`).
- **Collapsible** sections (Advanced) are a disclosure button inside the heading, with
  `aria-expanded`, not a `<details>`: a `<summary>` cannot hold the `?` beside it. They are closed
  unless `defaultOpen`, and they open if `defaultOpen` turns true after mount (a record that loads
  late and uses the section).
- **Moved in S6:** Home first, then Settings, Git, the Manage lists' Import panel, and the run
  page's Timeline, Variables, Global parameters and Cost & usage (S6g). A static explanation is
  the section's `?`; a line that reports state (a run's "Final values.", an unsettled run's
  caveat, an empty state) stays as a hint in the body. S6h moved the Runs page's cross-run
  Timeline (its lane-key toggle in `actions`) and the run drawer: a figure's explanation, such as
  the drawer's Duration, is an `AboutHelp` `?` on the figure's row, with any state sentence on the
  line under it. A section's own acts (Git's Refresh, Disconnect and each check) go in its `actions`,
  the heading row's `Toolbar`; a form's submit stays at the form's foot. A page form inside a
  `Section` is a `.field-form` wrapper in its body, so the label-left layout keeps its container;
  a `.run-meta` facts list there drops its own margin.

`e2e/section.spec.ts` measures a drawer, the dock and a page at 1440x900 in both densities.

## The form layout (#1594 OR40 S3c)

Every form takes one layout: the property dock, every drawer, and a page's form (Settings' appearance,
the Manage import panel). It started as the dock's own (#1477 OR29) and is now one rule set in
`index.css` (`@container field-form`), in both densities. Comfortable changes sizes (type, control and
row heights), not the layout.

- **Labels sit left once the form is at least 400px wide.** Each field of a form's own sections is a
  row: the label in a 150px column (`--form-label-column`), 12px, then the control, its hint and its
  error. A one-line label is centred on its control; a long one wraps inside its column. Narrower, the
  label sits over its control, 4px above it.
- **One row markup.** Every field row is a `LabelledControl` (`lib/LabelledControl.tsx`), inputs
  included, so the layout has one shape to place. `SecretInput` is one too: its input and Show sit
  together in the control column. A checkbox stays a wrapping label (box, 8px, words) and sits in the
  control column, as do a sibling hint and a `FieldError`. A row table's cells (a bound end's
  overrides included) and a dock fieldset of choices are not rows: they are too narrow for a label
  column, or their legend is their label. The trigger form's builders (recurrence, window,
  binding) are fieldsets of fields, so their fields are rows.
- **Rows are 8px apart**, and required is the `*` after the label (`RequiredMark`), never a word in
  the hint.
- **The threshold is measured on the form's context, not the window.** The context is the dock tab,
  a drawer's body (`.form-drawer-body`) or a `.field-form`.
  - **Dock:** it shares its width with the Problems column while that is open (#1694 OR42: only on
    request, and only while it lists something). At 1440 wide the bottom dock is 935px, but with
    Problems open its tab is 589px. The tab is 429px at 1280 wide, 1069px at 1920, and 302–463px when docked right.
  - **Drawer:** beside its list the drawer is 340–460px (`--drawer-width`), which is 460px from about a
    960px window up, so its body is 418px and label-left. Under 960px it stacks below the list at the
    content column's width, which a 700px window takes under 400px. The editor's trigger and
    connection columns are narrower (361px at 1440), so their forms keep the label over the control.
- **Controls are sized by type at every width**, on every form. Outside the property pane (below), a
  select is as wide as its longest option, capped at 320px. A number (`.number-input`, or an `<input type="number">` row) is 120px. Only
  free text grows. The run drawer (`.node-detail-panel`) shares the dock and is not a form, so none of
  this applies to it.
- **In the property pane, three size classes (#1694 OR42 F10).** Every control outside a table takes
  one of them, by what the field holds, never by what it sits in:

  | Class | Width | Holds |
  | --- | --- | --- |
  | S | `--field-s`, 120px | a number, a field with a unit, a choice `fieldSpan` packs as short |
  | M | `--field-m`, 240px | a name (a one-line literal), a connection or dataset binding, a longer choice; any unmarked select |
  | L | the value column | free text, paths, expressions, JSON |

  `fieldSize` (`configForm.ts`) sets `data-size` on a config field, and a choice is S exactly where
  `fieldSpan` packs it short: up to 12 characters, what 120px shows beside a select's arrow. A
  schema choice shows its longest option whole; a binding lists the operator's own names, which an M
  clips. Drawers and Settings keep a select's natural width (above). A row table's cells are sized
  by its columns instead: a one-line text column (`data-width="name"`, a mapping's source and sink,
  a key) has a `--row-table-name-min` floor of 160px, and in a narrow dock the table scrolls
  sideways rather than crush it. An optional choice cell's empty option is blank, because empty
  means its default; a required one keeps "— none —". `e2e/property-pane-ratchet.spec.ts` holds the
  classes for every catalog type and tab.
- **Expand on edit (#1694 OR42 F10).** Nothing is permanently tall or permanently full-bleed. A
  config field's text box (`ConfigFieldControl`, through `AutoGrowTextarea`'s `restRows`) is one
  line at rest, showing its first line, and grows to its text, up to eight lines, while it has
  focus. A blur during a pointer press collapses it only after the press ends, so a click on the
  control below lands where the author aimed. An S or M one-line box holding a `${}` widens to the
  value column while it has focus. A top-level JSON box (`JsonEditor`'s `restRows`: a JSON config
  field, Execute pipeline's JSON parameters) expands on edit the same way, a scrollbar under a long
  unwrapped line added to its height, and Edit as JSON's box is as tall as its config up to its cap.
  `e2e/property-pane-expand-on-edit.spec.ts` pins the text boxes and `e2e/json-expand-on-edit.spec.ts`
  the JSON ones.
- **⤢ opens a field in a full-size editor (#1694 OR42 F10).** Beside a top-level text field's `${}`
  and `ƒx` sits ⤢ (`ExpressionEditor`): a modal holding a draft of the field's text, 16 lines tall
  (4 for a one-line field), with the same reference and function flyout, inserting at the
  editor's own caret. OK (or ⌘/Ctrl+Enter; Enter alone in a one-line field, which takes no line
  break) writes the draft through the field's own change, exactly as typing would, and only if the
  draft differs from the text it opened on. Cancel and Escape discard it without asking, as ADF's
  dynamic-content pane does; an Escape the flyout takes closes only its list. Buttons follow the
  confirm dialog: Cancel, then OK, at the right.
  - **Where it is:** every field that carries the flyout at the top level, in an activity's or a
    container's pane. **Not** on a table cell (its toggles show only while its box has focus), a
    `literal` field, a `json` or `stringList` field (no flyout, #864), a field with no flyout (the
    connection and dataset forms), or `PickableInput`'s rows (call arguments, parameter overrides).
  - It is a native `<dialog>` portalled to the app's Fluent root, not a Fluent dialog, because it is
    mounted by a field that can unmount while it is open. A top-layer modal cannot be occluded, so
    the overlay occlusion gate does not open it. Inferred, not tested: the leave prompt renders under
    the top layer, so a Back press while the editor is open is answerable only once it closes.
  - `e2e/expression-editor.spec.ts` pins it.
- **A unit is a suffix inside its box, not label text (#1694 OR42 item 5).** `30` `s`, through
  `WithUnit`/`UnitLabel` (`lib/form/UnitInput.tsx`), so a label is the title alone and never wraps. The
  unit stays in the field's accessible name, out of sight ("Timeout (seconds)"), so its name, its
  `?` and its validation messages are unchanged. This applies to a top-level number or one-line
  field, which is an S on every surface, Settings included. A table's column header keeps "(ms)".
  - **The one exception is a duration (#1680).** A timeout shown as `D.HH:MM:SS` (`12:00:00`)
    carries its units in its value, so `DURATION_UNIT` draws no suffix and only names it:
    "Timeout (duration)". Its value IS converted for display, which `unit` never does elsewhere, so
    the field's `format` and `parse` must round-trip (`DraftNumberField`).

**A drawer has no two-column grid.** #1396 first asked for one on wide screens. At 460px two columns
would make controls about 100px wide beside their labels, too narrow for a URL, a JSON box or a time
zone. No form runs full-bleed: a drawer stacked below its list is about 600px at most at the
breakpoint, so no cap is needed. (A 40rem cap was tried and dropped, because it could never apply.)

**The dock also packs short fields (#1477 OR29)**, once a tab is at least 580px wide:

- **Short fields pack.** A number, a checkbox, or a choice whose options are all short (16
  characters or fewer, so they are not clipped) packs two to a row, or three once the tab
  is 900px wide. Everything else spans the row: free text, paths, expressions, JSON, row lists and
  advisories. Fields keep their schema order, left to right and then down. `fieldSpan`
  (`configForm.ts`) decides which kinds pack. `FieldGrid` and `FieldCell` (`lib/form/FieldGrid.tsx`)
  are the markup, used by `ConfigEditor`, the container panel and the General tab's policy (numbers
  in one grid, flags in the next, so neither leaves one alone on a row). A cell is
  `display: contents` everywhere else, so the wrapper changes no resource form; a grid given
  `field-stack` keeps a field's gap when it is not packed. A number field is `label[for]`
  beside its input, like every other kind, rather than a label wrapping it, so its hint sits inside
  the `.config-field` it belongs to.
- **Why 580px.** Two cells of a 150px label, a 12px gap and a 120px number, beside a 16px gutter,
  need 2 × 282 + 16 = 580px. The operator's "dock at least 720px wide" in #1477 is this tab width.
  The 56rem readability cap is lifted for the grid alone.

`e2e/field-grid.spec.ts` measures a drawer, a builder fieldset, Settings and the import panel at
1440x900 in both densities; `e2e/property-dock-grid.spec.ts` measures the dock.

**A field's explanation is behind a `?` beside its label (#1594 OR40 S3c-2).** `LabelledControl`'s
`about={{ name, note }}` draws it (`AboutHelp`, the one "About {name}" `?` that `Section` and the
config fields use too) and hands the note's id to the control's `aria-describedby`, after the
error, through `attrsFor`'s third argument. So the note stays the control's description.
`SecretInput` takes the same `about`; `DraftNumberField`'s `about` is the note alone, named by
its label. What stays a visible line:
- a note on the field's **state**: a preview, a problem, an advisory, why a control is locked
  (a tumbling trigger's Concurrency), what an empty list means;
- the Kind or Mode picker's one line on the chosen kind (`hint`, above);
- a checkbox's line, since its label wraps the box and there is no label row for a `?`.

A section that holds one field under the same name (a secret's Value) takes the field's note into
its own `?` line instead, because a second "About Value" would be two controls with one name. That
note describes the section's group, not the input.
`e2e/field-help.spec.ts` measures each moved field.

**Still to come:** the editor's Run popover joins in S6's page sweep. The Git page's forms moved
in S6c: the repository URL's credential warning is its `?`, and whether a token is stored is the
Token field's `hint`, because it is the field's state.

**Authored rows are tables (#1477 OR29).** Parameters, variables, outputs, annotations and every row
list (a Copy mapping, HTTP headers, LLM messages, an output schema) render through `RowTable`
(`lib/form/RowTable.tsx`). It applies at every width and both densities.

- **A header names each column once.** A cell shows no label of its own. It keeps one, out of sight,
  as its control's name ("Column mapping row 2 sink", "Parameter 1 default"), so specs and screen readers still
  reach each control. A row-list column's header carries what the cell label said: its title, its
  format (`— number`, `— JSON`) and the required mark.
- **A row is one line.** At compact density it is 32px (`--row-h`) of 28px controls. A
  text cell is a one-line textarea that grows with its text. The growing is CSS `field-sizing:
  content`, which only Chromium supports. Elsewhere the cell stays one line and scrolls.
- **A row's errors and advisories go on a notes row under it** (`RowNotes`, spanning the table), only
  when it has any, so they never widen a cell.
- **A cell's `${}` and `ƒx` toggles show under the box only while the cell has focus**, or while their
  list is open. ADF's "Add dynamic content" link sits under the box at all times
  ([Learn](https://learn.microsoft.com/azure/data-factory/how-to-expression-language-functions));
  showing it on focus is a deliberate difference for table rows. Inline, three text columns' toggles leave
  no room for the text in a 589px tab. They are hidden from sight, not removed: Tab from the box lands
  on `${}`, and a spec focuses the cell before it clicks one.
- **The table scrolls sideways rather than crushing its columns.** A text column is at least 5rem, so
  the 302px right-hand dock scrolls. At 1440x900 a three-row Copy mapping fits its tab whole, with no
  sideways scroll (`e2e/row-tables.spec.ts`).
- **Column help lives in the section's `?`.** The wrapper's `overflow-x` clips vertically too, so a
  header `?` would cut off its own note. A row list's hint sits behind a `?` beside its label.

Axe now gates every audited view: see "Accessibility gate" below. OR24 (#1415) keeps wiring errors
to their fields and the single announcer.

## Headings and regions (#1594 OR40 S5)

- **One `h1` per page: its title**, rendered by `PageHeader`. The rail's wordmark is not a
  heading. Under the title, sections are `h2`, a drawer's or panel's title is `h2`, and what sits
  under those is `h3`, then `h4`. A heading never skips a level going down.
- **The pane title** is an `h2` inside its own `nav` landmark ("<hub> sections"), not part of the
  page's outline.
- **A named part of the page is a `region`**: a `section` with an `aria-label` or
  `aria-labelledby`. That covers the editor's Activities, Properties and Problems, the run drawer's
  activity run, version history, the triggers and connection columns. Never an `aside`: a
  `complementary` landmark must be top level, and these all sit inside `main`.
- `e2e/heading-structure.spec.ts` checks every page, the run page with its drawer and views, and
  the editor's selection states.
- **Nothing outside a landmark.** The pane's resize separator is inside the pane's `nav`. A popup
  that would portal to `<body>` mounts in `main` instead, through `useMainPortal()` with
  `strategy: 'fixed'` (`ConnectionPicker` does this).
- **A header cell has text.** An actions column's header is visually hidden text, not an
  `aria-label` on an empty `th`.

## Accessibility gate (#1594 OR40 S5b)

`e2e/accessibility.spec.ts` runs axe on every audited view, in both themes and both densities, and
fails on **any** violation, whatever its impact. The views are:

- every titled page;
- the run page, with its five views and its drawer;
- the editor: pipeline properties, Copy on General and Sink, the connection list open, Expand
  properties, and ForEach;
- the New connection kind gallery;
- Git, connected.

The workspace is seeded first, so lists are scanned with rows in them.

- A new page or panel state goes into that spec.
- There is no allowlist. Fix a violation; never hide it with axe's `exclude` or `disableRules`.
- `eslint-plugin-jsx-a11y`'s recommended rules lint `packages/web` at error (#1639). It is pinned
  at 6.10.2, whose peer range stops at eslint 9; `pnpm-workspace.yaml` allows eslint 10. A per-line
  disable carries its reason on the line above, and an unused disable fails the lint.
- A canvas port is `role="img"`, named by its routing key: it is drawn and named but not
  keyboard-operable, and an `aria-label` on an element with no role is prohibited.

## Overlay occlusion gate (#1695 OR43)

Every overlay renders on top. Fluent menus, lists, tooltips and dialogs portal to one mount node at
the end of `<body>` (`z-index: 1000000`). The theme bridge's `display: contents` applies to the
app's provider only, never to that mount node, because a mount node without a box loses its
`z-index`. A `?` help note opens in the browser's top layer (`popover="manual"`), placed by
`placeNote`. `e2e/support/occlusion.ts` holds the helpers: `expectOverlayUnobstructed` hit-tests
an open overlay at its corners and centre, and checks the viewport and every clipping ancestor.
The `expectEvery…` sweeps find the triggers by role (`aria-haspopup`, `combobox`, `?`).
`e2e/overlay-occlusion.spec.ts` runs them over every toolbox activity's tabs, the node and canvas
menus, the editor header, the pipeline tree, the hub pages, the shell's tooltips and a confirmation
dialog. It runs at 1440×900 and 1920×1000, docked and expanded. A new overlay needs no entry; a new
kind of trigger goes into those helpers. Never fix an occluded overlay by raising its `z-index`.

## Case and terms (#1594 OR40 S4)

**Sentence case everywhere.** A name, label, tab, button or heading capitalises its first word
and nothing else, except acronyms (ID, CSV, HTTP, JSON, LLM, SQL, AI, API, CLI, URL) and proper
names (ForEach, SQLite, PostgreSQL, OpenAI, Anthropic, Excel, Ollama, Autonomy). Activity titles
read "Copy data", "If condition", "Execute pipeline", "HTTP request"; the Author pane is "Factory
resources"; the brand is "Autonomy studio". No stylesheet sets `text-transform: uppercase`. The
rule and its word lists are `testing/sentenceCase.ts`. `testing/sentenceCase.test.ts` holds the
catalog, the nav, the pane titles and every kind label to it, and
`e2e/sentence-case.spec.ts` holds the rendered pages to it.

A node's name is not stored (`activityLabels` derives it), so recasing a title renames its nodes on
screen and rewrites no saved pipeline.

Run and node status words ("success", "failure", "running") stay lower case, as the Runs grid has
always shown them. A status is a value, not a label.

**Labels end without punctuation and are words, not keys (S4b).** A label, button, heading or
control name takes no trailing colon or period ("Duration", not "Duration:"); a colon belongs only
inside running text or a filter pill's value. A row's controls are named by the glossary term and
its position: "Parameter 1 name", "Variable 2 default", "Remove annotation 1", never the key
(`param 1 name`). `labelProblem` in `testing/sentenceCase.ts` is the rule;
`PipelinePanel.test.tsx` holds every control on the pipeline's properties to it, and
`e2e/sentence-case.spec.ts` a rendered parameter row.

Config row lists follow the same rule (S4b-2). A cell is named by its list's title, its row and its
column: "Column mapping row 2 on error", "Request headers row 1 key"; its buttons are "Move column
mapping row 2 up", "Remove column mapping row 2" and "Add column mapping row"; its column headers
are the cells' titles ("Source", "On error"). An untitled cell reads its key as words
(`keyToWords` in `lib/words.ts`: `secret name` is "Secret name"). `NodePanelLabels.test.tsx` holds
every row list of every activity to `labelProblem`, and `e2e/row-tables.spec.ts` a rendered Copy
mapping. Two exceptions remain: an override allowlist's checkbox is "Overridable <key>", because
the key is what an override cites, and a top-level field's expression picker keeps its key. Left
for S6: the validation messages ("row 2 sink: …"), and the tools list's "parameters" cell, which
is not the glossary's Parameters.

**One term per concept.** Use the term in the first column on every tab, button, heading and run
detail. Only "Parameters" has banned variants today, and `e2e/sentence-case.spec.ts` fails on
"Params" in a heading, tab, button or label. The others record the term to use. S6 sweeps the
strays: "node" in version history's counts, and "param" in validation and server messages
("param #1 has no name", "trigger param binding could not be resolved").

| Term | Use for | Never |
| --- | --- | --- |
| Parameters | A pipeline's typed inputs, and the values a run or trigger supplies for them ("Add parameter", "Parameters (JSON)") | params, Params, PARAMS |
| Activity | One step on the canvas, of any kind | |
| Run | One execution of a pipeline version | |
| Activity run | One activity's execution inside a run, one row per attempt | |
| Dataset | A named shape of data at a connection (table, query, file) | |
| Bind values | A query's `:name` values, keyed without the colon ("Add bind value"; an inline query's "Import from statement" adds one per unbound `:name`), on a saved query dataset and an inline one alike | Parameters, params (a pipeline's inputs) |
| Preview data | Reading a source's first rows from the form ("Preview data"; a `${}` bind value asks for a *Preview value for :name*). *Preview vN* stays the version-history view | Sample, Test query |
| Connection | Where and how studio reaches a system, with its secrets | |
| Trigger | What starts runs: manual, schedule, tumbling window, webhook, event | |
