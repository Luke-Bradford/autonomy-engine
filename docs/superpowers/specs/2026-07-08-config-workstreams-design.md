# Config workstreams — user-configurable org per repo (operator-approved design)

Operator session 2026-07-08. Supersedes the read-only Org & Workflow zone
(#326 slice 1) with a fully configurable surface, and **supersedes SD-28 for
target-repo packs** (recorded below). Prior art: the ClaudeDevs loops
taxonomy (claude.com/blog/getting-started-with-loops) mapped onto the
engine's triggers.

## Concept model

**Repo is the top of the hierarchy; workstreams pin below it.** A workstream
is one named unit: template (Coder / PM / QA / Researcher / Custom) + on/off
+ trigger + scope + gate + model/effort + account + optional lane + knobs.
Parallel workstreams per repo are first-class (two coder workstreams =
distinct names + lanes).

**Storage: a workstream IS a `roles:` entry.** No new schema, no migration —
`lib/roles.py` stays the SSOT; W1 cron, W2 events, validation, dispatch all
keep working. The UI concept is new; the storage is not.

## Write model (SD-28 SUPERSEDED for packs — operator decision 2026-07-08)

> "Config changes should just be local, shouldn't need constant PRs. A user
> downloading this could add their own config, not ours."

- Every UI edit writes **locally and immediately** — but NOT to the tracked
  `.autonomy/config.yaml` in the loop worktree: preflight stash-sweeps
  tracked-file drift after 3 dirty sessions (that sweep is why the old
  overlay existed). The live truth is a full-file shadow at
  **`var/autonomy/config.yaml`** — `var/` is the established
  preflight-surviving home. The committed `.autonomy/config.yaml` remains
  the shareable default that SEEDS the live file on first structural write
  (old overlay values folded in, overlay deleted). No PR, no key-level
  overlay shadow. PR-gating remains OUR engine-repo dev workflow, never a
  product requirement on a user's pack.
- **One resolver, every reader**: `config_parser.effective_config_path()` —
  given a pack config path, prefer the sibling `var/autonomy/config.yaml`
  when present. Applied inside config_parser's CLI (supervisor, safe_merge,
  board.sh, doctor all funnel through it) and its python API (roles.py,
  dashboard readers). No split-brain: either every consumer sees the live
  file or none does. A present-but-unparseable live file is a pack FAILURE
  (doctor/preflight refuse the session) — never a silent fall-back to the
  older committed config (a remit change behind the operator's back).
- **Drift is visible**: the config page badges "live config — diverges from
  committed" whenever the shadow exists and differs; committing it back is
  the user's choice (copy-back helper later).
- Onboard idempotently ensures the target repo's `.gitignore` covers `var/`
  (the preflight-survival assumption made explicit).
- The writer keeps the SD-29 mechanics: full-block re-emit, validated by
  `roles.py` BEFORE writing, re-parsed and compared AFTER — any mismatch
  refuses and leaves the file untouched. Invalid edits are refused inline
  with the validator's reason.
- The **unattended loop stays barred** from editing packs (hard_rules
  unchanged) — this unlocks the UI/operator only.
- The one-shot "next session only" override is the only overlay left; the
  persistent overlay retires (it shadowed committed truth — the fable-5 vs
  sonnet-5 confusion). Migration: on first structural write, fold any
  existing overlay values into the file and delete the overlay.
- Effect latency: the supervisor re-enumerates roles every tick and the
  fingerprint gate hashes pack bytes — edits apply next tick automatically.

## Layout — full 3-zone (same tokens as the main page)

- **Left rail — workstreams tree.** Repos, each with its pinned workstreams:
  status dot · name · trigger glyph (`⟳ loop` / `⏱ 0 */2 * * *` /
  `⚡ pr.opened`). "+ add workstream" per repo.
- **Center — canvas.** Repo selected → org overview (pair flow + workstream
  summary rows). Workstream selected → its editor card (below).
- **Right rail — machine level.** Accounts, credentials, quota windows,
  engine-update chip. Frees the center from plumbing; uses the dead width.

## Workstream editor card

- **Toggle** on/off (writes `enabled:`).
- **Run now** — one-shot manual dispatch (the article's turn-based invoke);
  POST `/api/control action=run_now` → supervisor one-shot marker for that
  role next tick. Disabled while a session for that workstream is live.
- **Trigger editor** — segmented `loop | cron | event | manual`:
  - loop: round-robin note (no fields);
  - cron: preset picker (hourly / daily 09:00 / every N h) + raw cron field
    with a next-3-fires preview via `roles.cron_next_fire`;
  - event: checkbox list of the engine's known events (pr.opened,
    issue.created, merge.done, …) from a single source shared with
    `_event_poll`;
  - manual: never auto-fires; Run-now only.
- **Scope** — label chips (add/remove; the label routing contract, SD-23).
- **Gate** — select (QA gate values; non-QA shows the honesty NOTE).
- **Model / effort / account** — selects (existing rosters; SD-13 precedence
  labelled).
- **Pair card** (coder-template workstreams): pair on/off, planner model
  picker (writes the agent file frontmatter), coder model/effort — the flow
  line from #326 slice 1 becomes the card header.
- **Context strip** (read-only truth, no toggles): what a session will carry
  — `CLAUDE.md ✓ · skills N · agents planner ✓ · rail <prompt path>`; red
  when `engine.requires_claude_md` is true and the file is missing. No
  "apply CLAUDE.md" toggle: `claude -p` runs in the repo, so CLAUDE.md /
  .claude/skills / .claude/agents load unconditionally — a toggle would lie.
- **Tools allowlist** — wires the existing validated-but-unwired `tools:`
  knob: unset = today's `--dangerously-skip-permissions` full access; set =
  the adapter passes the allowlist instead. Restriction is the fail-safe
  direction; widening beyond default is not offered.
- **Budget** (SD-30 reserved knob) — max sessions/day per workstream;
  supervisor skips dispatch past the cap with an honest heartbeat.
- **Goal / stop-condition** — LATER slice (article's goal-based loops):
  verifiable done-criteria per run. Recorded, not built now.

## Add-workstream wizard

Template → prefilled trigger/scope/duties + rail prompt scaffolded into
`.autonomy/roles/<name>.md` (from `templates/autonomy-pack/roles/`) → name
(charset-gated) → lands **disabled** → user flips it on. Custom = blank rail.

## Safety rails kept

- `roles.py` validation before every write; refuse-on-invalid; re-parse
  compare (SD-29).
- Loop unattended never edits packs; merge-gate strategy still hard-refuses
  misconfig; manual stays the default (SD-5).
- Dashboard remains loopback-only + control-token; all writes through the
  single `/api/control` endpoint (dashboard security contract).
- Degrade-to-truth rendering carried over from #326 slice 1 (invalid badges,
  never healthy defaults — prevention-log 15/18).

## Slices (each ships usable)

1. **Writer foundation**: SD-28 supersession entry in settled-decisions +
   `config_parser.effective_config_path()` resolver (CLI + python API, so
   supervisor/safe_merge/board/doctor/roles/dashboard all agree) +
   the var-live structural writer in `lib/dashboard_control.py` (seed from
   committed + overlay fold-in + delete overlay; roles-block re-emit +
   scalar sets; validate-before + reparse-compare-after) + onboard
   `.gitignore var/` step + drift badge data + tests. No UI change yet.
2. **3-zone layout + workstream nav** (read): left rail tree, center canvas,
   right rail machine panels. #191 closes here.
3. **Inline editors**: toggle, trigger editor, scope chips, gate,
   model/effort/account, Run now.
4. **Wizard + pair card + context strip.**
5. **Tools allowlist wiring + budget knob** (adapter + supervisor touches;
   own TDD).

## Out of scope (recorded)

Goal-based stop conditions; per-workstream notifications/escalation
routing; free-form cross-repo workstreams; #154 named preset export.
