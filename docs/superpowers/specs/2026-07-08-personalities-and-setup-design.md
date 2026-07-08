# Personalities & the 5-minute setup — product design (operator session 2026-07-08, late)

Operator verdict on the current config surface: "not what anyone would expect
for a dynamic polished implementation … PM/QA/Researcher shouldn't be the
de-facto hard-wired. These are almost personalities we can throw into the
mix … I wouldn't know how to simply start … we're band-aiding bits I'm
raising, not considering what this app should do."

This spec is the step-back. It re-grounds in the loops docs, states the
product in one sentence, catalogues testable user stories, and lays out the
design that serves them. It supersedes the incremental slice list; the
existing writer/authoring plumbing (SD-34, ws_*) is the substrate it builds
on, unchanged.

## The product, one sentence

> A person running Claude on their own computer points this at a repo,
> picks what should work on it and when, and lets it run — watching it work
> from one page, never touching a config file.

## Doc grounding (claude.com/blog/getting-started-with-loops + agent-loop SDK docs)

- Loop taxonomy: **turn-based** (manual prompt) · **goal-based** (verifiable
  exit criteria) · **time-based** (interval) · **proactive routines**
  (event/schedule, no human). The engine is the proactive-routine runner;
  our triggers map: loop=continuous routine, cron=schedule, event=event,
  manual=turn-based invoke. Goal-based = per-run stop criteria (budget /
  max-sessions first; verifiable goals later).
- SDK levers we should surface per personality, because the docs name them
  as THE control surface: `model`, `effort` (low→max; xhigh recommended on
  Fable/Sonnet-5 for agentic work), `allowed_tools`, `max_turns`/
  `max_budget_usd`, permission mode. Today we surface model/effort; tools +
  budget are the known slice-5 gaps.
- Doc guidance already embodied: route routines to smaller models, reserve
  capable models for judgment (the two-brain pair); verification as skills;
  second-agent review; "start with the simplest solution".

## The reframe: personalities, not hard-wired roles

**A personality is a reusable, named behaviour**: one-line description a
human reads, a prompt (its standing instructions), a default trigger shape,
default gate/scope, and a brain shape (single or pair). PM/QA/Researcher/
Coder become STARTER personalities in a library — not fixtures. Users
duplicate, rename, rewrite, delete them, and invent new ones ("qa-merge-
sweeper: on a cron, find PRs the review bot approved that sit unmerged;
verify CI; merge via safe_merge; regression-sweep weekly").

**This is SD-30 finished**: "agents are global entities in
`~/.config/autonomy/agents`; bindings live in each repo's `roles:` block."
The library = those global entities grown a human face; a repo's
workstreams = bindings instantiated FROM the library.

### Library mechanics

- Store: `~/.config/autonomy/library/<name>/` → `card.json` (description,
  default trigger, gate, scope, brain shape, model hints) + `prompt.md`.
  Same index-file conventions as accounts (stdlib json, 0600, atomic).
- Ships seeded from `templates/autonomy-pack/roles/*` + the coder rail on
  first run (never re-seeded over edits; a "restore starter" action
  recovers originals from templates).
- **Add to a repo** = instantiate: copies the prompt into the repo's
  `var/autonomy/roles/<name>.md` + writes the binding (existing `ws_add`
  grows a `from_library` source). Editing the instance never touches the
  library; "save back to library" and "push library update to repos that
  haven't diverged" are explicit actions.
- **Editing the library changes what NEW repos/instantiations get** — the
  operator's "amend the default settings for new projects to pick from".
- Remove from a repo = existing binding delete (`ws_remove` — to build);
  remove from library = library delete (bindings keep working; card shows
  "library entry gone" only as info, never breakage — the instance owns
  its copy).

### Brain shape is a choice, not an imposition

`agent.planner.enabled: true|false` (per repo, live-config editable):

- **one brain**: a single model does thinking + building (today's classic
  loop). Default for new repos — "start with the simplest solution".
- **two brains**: thinking (plans, unblocks, checks vs plan) + building
  (writes the code). The wizard offers it with the one-line economics
  ("thinking pays premium only at the judgment moments").

Materializer + coder rail sections become conditional on the flag; the
pair panels render only when enabled, with an on/off segmented control.

## The 5-minute setup (the "how do I simply start" answer)

`/config` gets a **Set up a repo** flow (also the empty-state):

1. **Point** — path picker → registers + scaffolds the pack (exists:
   repo_init).
2. **Pick who works here** — personality cards from the library, each a
   name + one-liner + default schedule in plain words; Coder pre-ticked,
   everything else opt-in. No jargon, no YAML.
3. **Coder brains** — ○ one brain [model] ● two brains [thinking model ·
   building model+effort].
4. **Go** — summary in plain words ("coder picks up labelled tickets
   continuously; qa checks each opened PR and merges on green; pm tidies
   the board every 2 hours") + a **Start the loop** button (control.sh
   start via the existing lifecycle endpoint) + where to watch it (link to
   the control room).

Everything the wizard writes is the same live-config the cards edit.

## Progressive disclosure (the "too much text" answer)

- Every inline `.cfghint` paragraph moves behind an ⓘ affordance
  (hover/click popover). Cards show VALUES; explanations are on demand.
- One short empty-state sentence per zone maximum.
- The workstream card collapses to: on/off · one-line trigger · scope
  chips · gate · runs-as · [instructions ▸ expands] · [ⓘ details].
- Rule going forward: if a control needs a paragraph beside it to be
  usable, the control is wrong — redesign the control, don't write the
  paragraph.

## Activity: personalities must be visible doing work

Exists today (main page): per-role last-run on the fleet rail (#230),
session history with role attribution, per-ticket sess·tok·$ (#229),
heartbeat narration (#177). Gaps to close so "can we show them being used"
is a yes:

- Workstream card gets a **recent activity** strip: last 5 sessions for
  that role (time · outcome · ticket) from the existing session index, and
  a "watch live" link to the control room filtered to that role.
- The control room feed gains a role filter chip row.
- Cron personalities show "last fired / next fire" (data exists: #18/#230).

## Testable user stories (the acceptance catalogue)

Each must be executable through the page alone; each becomes a browser-
verified test scenario. "WS" = workstream.

| # | Story | Test oracle |
| --- | --- | --- |
| S1 | Solo dev: point at a repo, accept defaults (one-brain coder), press Start; coder drains labelled tickets. | wizard → running loop; session log shows coder run |
| S2 | Same, but two brains: fable thinks, sonnet builds. | planner file materialized w/ fable; rail directs pair |
| S3 | Add QA from the library: reviews each opened PR, auto-merges on green. | binding: event pr.opened + gate auto-merge-on-pass |
| S4 | **Operator's sweeper**: duplicate QA in the library → "qa-merge-sweeper", rewrite prompt (find bot-approved unmerged PRs, verify CI, safe_merge; weekly regression sweep), cron hourly; add to repo. | new library entry; binding cron; prompt verbatim |
| S5 | Add PM every 2h with custom decision conditions in its prompt. | done today (verified 2026-07-08) — regression-keep |
| S6 | Rename/personalize: PM → "board-butler" on one repo without touching the library. | binding renamed; library unchanged |
| S7 | Remove a personality from a repo; loop stops running it. | ws_remove; enumerators exclude it next tick |
| S8 | Edit the LIBRARY's PM prompt; a newly onboarded repo inherits the edit; existing repos untouched. | library write; new instantiate carries it |
| S9 | Run a WS off a local LLM (Ollama) end-to-end from the page. | account create w/ endpoint + runs-as + local model id |
| S10 | Manual helper: a WS that only runs when I press Run now. | manual trigger + Run-now dispatch (to build) |
| S11 | Cap a WS: at most N sessions/day (budget). | budget knob (slice-5) honoured w/ honest heartbeat |
| S12 | Restrict a WS to read-only tools. | tools allowlist wired to the adapter (slice-5) |
| S13 | See what a personality did this week. | activity strip + role-filtered feed |
| S14 | Two coders in parallel on disjoint labels (lanes). | lanes exist (#147); wizard/manual binding w/ lane |
| S15 | Turn the pair off later (two brains → one) without breaking anything. | planner.enabled=false; materializer skips; rail single |

## Build order (each slice = stories it closes)

1. **Library backend + seed + ws_remove** (S4 backend, S6, S7, S8):
   `lib/library.py`, seeded from templates; `ws_add from_library`;
   `ws_remove`; library CRUD control actions.
2. **Brain-shape flag** (S15, S2/S1 choice): `agent.planner.enabled`,
   conditional materializer + rail + pair panels w/ one/two segmented
   control.
3. **Setup wizard** (S1, S2, S3): the 4-step flow over existing endpoints
   + Start button.
4. **Library UI + disclosure redesign** (S4, S6, S8 + the text purge):
   library zone on /config; ⓘ popovers replace hints; card diet.
5. **Run now + activity strip** (S10, S13): supervisor one-shot marker;
   card activity from session index; feed role filter.
6. **Budget + tools** (S11, S12): the original slice 5.

Every slice browser-verified against its stories; the story table IS the
regression suite for this surface.

## Out of scope (recorded)

Goal-based verifiable stop criteria; cross-repo personalities acting on
many repos in one session; a hosted/multi-user story; marketplace/sharing
of personalities beyond the local library.
