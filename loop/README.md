# `loop/` — the studio build loop's control plane

This is the headless driver that builds `studio/`: a launchd agent runs `drive.sh`, which
repeatedly fires `run.sh` (one fresh `claude -p` per fire, driven entirely by `prompt.md`) against
the worktree at `~/Dev/studio-loop-repo` until a stop condition.

It lives at the repo ROOT, not under `studio/`, for two reasons: it outlives the root engine
(`bin/`, `lib/`) that is being ripped out, and it stays outside `studio/`'s pnpm workspace so
`studio-ci`'s TypeScript lint scope needs no bash exclusions. Its own CI is the `loop` job in
`.github/workflows/ci.yml`, deliberately separate from `lint-and-test` for the same reason.

## Files

| File | What it is |
|---|---|
| `drive.sh` | The driver: stop conditions, quota guard, fire budget, auth backoff, gate waits |
| `run.sh` | ONE fire — a fresh headless `claude -p` with the flags that keep it authed and thinking |
| `prompt.md` | The work order the fire is driven by. The most load-bearing file here |
| `claude_usage.py` | The quota guard's fallback reader: prints the 7-day utilization percent, or nothing (#764) |
| `test_quota_guard.sh` | Drives the REAL `drive.sh` with PATH stubs. No network, no tokens, ~10 min |
| `test_claude_usage.py` | Unit tests for `claude_usage.py`; every seam injected, so no Keychain and no network |
| `reap_test_drivers.sh` | Kills and removes the fixture trees the suite above builds — including a driver still running out of one (#821) |
| `test_reap_test_drivers.sh` | Tests for the reaper, mostly REFUSALS: real trees, real processes, no mocks |
| `fire_stats.sh` | Per-fire cost/turn/tool report read from the stream-json logs |
| `reload_schedule_once.sh` | Reload helper for the launchd schedule |
| `install_studio_server.sh` | Installs the SUPERVISED studio server LaunchAgent the quota guard reads |
| `test_install_studio_server.sh` | Sources the real installer; asserts the plist it renders and the staleness/drift predicates. No launchd, no network |
| `com.autonomy.studio-build-*.plist` | The launchd agents |
| `com.autonomy.studio-server.plist.tmpl` | Template for the supervised studio server unit |

## The supervised studio server (#765 Defect 2)

The quota guard's third source is studio's `/api/quota`, and after the engine is parked (#410) it
is one of only two left — the other being the reader #764 relocated into `loop/`.
Nothing supervised a studio server until this unit existed — the only
listeners were ad-hoc `pnpm dev` sessions that die with their terminal — so at 03:05 the endpoint
was **connection-refused**, not merely rate-limited. Every "studio UNREADABLE" measured before this
therefore measured *no server*, not the reader.

```sh
loop/install_studio_server.sh              # provision, install, load, wait for /health
loop/install_studio_server.sh --dry-run    # print the plist it would install; touch nothing
loop/install_studio_server.sh --status     # fetch, then report drift + unit state; changes nothing
loop/install_studio_server.sh --update     # refresh to origin/main IF STALE (see below)
loop/install_studio_server.sh --update --force   # rebuild even if the stamp says current
loop/install_studio_server.sh --uninstall  # remove the unit; KEEPS the state dir (it holds a DB)
```

The installer is idempotent, and re-running while the unit is live is safe — the port-conflict check
recognises the service's own pid as its own.

### Drift, and why there is no scheduled updater (#773)

The clone is pinned to `origin/main` at install time and **nothing moves it forward on its own**, so
it drifts indefinitely (measured 2026-07-30: the live clone was 14 commits and ~20h behind `main`).
That is mild now and stops being mild after #410, when a fix to the quota reader would ship to `main`
and never reach the process the spend guard actually asks.

A scheduled updater is **deliberately not the answer**.
`studio/docs/2026-07-30-packaging-and-updates.md` (approved 2026-07-30) rejects scheduled
auto-update for this service by name, and the reasoning holds up against this repo's own evidence: a
scheduled updater must not interrupt a running pipeline, so it needs an interlock, which needs
starvation handling, which needs a rule about the loop's 03:05/21:05 windows. And the interlock
really would starve — the driver run beginning `2026-07-26T02:05Z` ran for **74.7 hours**, so an
interlock keyed on "a fire is running" would have skipped nine consecutive slots. Applying an update
stays a human act; **#792 phase 2** owns making that act a click.

So the job here is to make the human act cheap and the drift visible.

**`--update` is a no-op when there is nothing to do**, so it is safe to run any time instead of being
a minutes-long rebuild-and-bounce every time. Four properties, each asserted by the suite:

- **Staleness is measured from a build stamp, not from `HEAD`.** `provision` does
  `reset --hard origin/main` *before* `pnpm build`, so a failed build leaves `HEAD` already advanced.
  Comparing `HEAD` would then read "current" forever while the service ran old code — a loud failure
  turned into a silent permanent one. `built.sha` under the state dir is written only after a build
  succeeds, so a failed build is retried rather than latched.
- **A failed `git fetch` is UNKNOWN, never "current".** `origin/main` inside the clone is a cached
  local ref, so a failed fetch leaves a stale one that compares equal to the stamp.
- **"Current" includes actually answering.** A tree that built and bootstrapped but never served
  satisfies every other check — `launchctl` prints `-` in the pid column for a job it is respawning
  every 30s exactly as it does for a healthy idle one — so `/health` is part of the predicate,
  retried three times so a blip does not buy a full rebuild.
- **Concurrent runs are serialised** by a `mkdir` lock under the state dir, stolen after 60 minutes
  so a killed install cannot wedge the next one, and stamped with the owner pid so a run never
  deletes a lock it does not hold.

**`--status` is the drift surface.** It prints the built, `HEAD` and `origin/main` shas, whether the
server answers, the unit's state, and a plain `CURRENT`/`STALE` verdict. It **fetches first** — that
is the difference between a drift report and a comforting one, because a status built on the cached
ref fails in the same direction as the thing it monitors: the longer nobody updates, the more
confidently it would say "current". Fetching touches refs only. (An HTTP surface for the running
commit is #792's `GET /api/version`, which landed in `521c4f2`; this is the operator-side view.)

Three isolation properties are load-bearing, each asserted by the test suite:

- **Its own port, 8788** — not studio's 8080 dev default, which any `pnpm dev` from any checkout
  takes. A wrong-but-answering server 404s, which reads as UNREADABLE forever while looking
  correctly configured.
- **Its own DB and git workspace root**, under `~/.autonomy-studio/service/`. Two studio servers
  against one sqlite file corrupt each other: `packages/server/src/index.ts` `reconcileOnBoot`
  treats every `running` row as a crash survivor and pumps it *without* the drive lock, and
  `scheduler/lease.ts` judges liveness from in-process `drives.activeRunIds()`, so a second
  instance reclaims the first's live runs. A developer's `pnpm dev` must never share state with the
  service. (`WORKSPACE_GIT_ROOT` defaults to a *cwd-relative* `data/git`, so leaving it unset puts
  it back inside whatever tree the service runs from — it is pinned explicitly.)
- **Its own copy of the code**, a clone pinned to `origin/main`. The loop branch-switches and
  rebuilds its working checkout every fire and `dist/` is gitignored, so a checkout does not
  restore it; with `KeepAlive`, a crash mid-fire would otherwise reboot the guard's quota source
  from a foreign branch's half-written build.

`AUTONOMY_DATA_DIR` is deliberately **not** set: it also relocates the master key file, so pinning
it would mint a new key and orphan every existing secret.

**The port is written down in exactly two places** — `drive.sh`'s `STUDIO_QUOTA_URL` default and
`install_studio_server.sh`'s `DEFAULT_PORT` — and a test asserts they agree. The driver LaunchAgent
used to pin `STUDIO_QUOTA_URL` in `EnvironmentVariables`, which *beats* a `${VAR:-default}`; that
pin outlived its reason and would have made any change to the default silently inert. It is gone.
Do not re-add it.

## Runtime state is NOT tracked

`loop/logs/` (one multi-MB stream-json file per fire — ~546MB and growing), `loop/.last_quota` (the
last-known 7-day reading), `loop/.last_quota_poll` (the source-2 poll memo, #777) and
`loop/.last_quota_shadow` (the diagnostic probe's rate stamp, #765) and `loop/.driver_handoff`
(the #811 self-adopt handoff) are gitignored.
All four are per-machine and meaningless in another checkout. Nothing here should ever write into a
tracked path — and keep this list in step with `.gitignore`, because it is what a live-control-plane
sync is checked against.

## Where it actually runs from — READ BEFORE CHANGING PATHS

**These files are a versioned COPY. The live control plane is still `~/Dev/studio-loop/`**, which
is what `com.autonomy.studio-build-driver.plist` points at and what fires at 03:05 and 21:05 daily.
Editing `loop/drive.sh` here changes nothing about tonight's run until the cutover below happens.

That split is deliberate: getting the control plane under version control is worth doing on its
own, and it carries no risk to a scheduled fire. Repointing launchd is a separate, verifiable step.

### Cutover procedure (not yet done)

1. `drive.sh` and `run.sh` still hardcode `INFRA=/Users/lukebradford/Dev/studio-loop`. Change them
   to derive it from the script's own directory (keeping the env override) so the tree is portable.
2. Decide where logs live. `$INFRA/logs` would put ~546MB inside the repo — gitignored, but
   consider pointing them outside instead.
3. Update `ProgramArguments` in the plist to the repo path, then
   `launchctl unload` + `launchctl load` it.
4. Verify with a supervised fire before trusting the next scheduled one.
5. Retire `~/Dev/studio-loop/` only once a scheduled fire has succeeded from the new path.

Until step 5, **`~/Dev/studio-loop/` is the source of truth for behaviour** and this directory must
be kept in sync by hand. Diff them before assuming they match.

**They had already drifted, in BOTH directions** (measured 2026-07-29, #765):

- `~/Dev/studio-loop/drive.sh` did not contain the C2 studio source *at all*, so the third quota
  source shipped in `3a17fe1` was never live. Syncing `drive.sh` is what makes a change here real.
- `loop/com.autonomy.studio-build-driver.plist` had only the 03:05 `StartCalendarInterval` while
  the *installed* agent has 03:05 **and** 21:05 — the second entry was added live on 2026-07-23 and
  never backported. Copying this repo's copy over the installed one would have silently deleted a
  scheduled fire. Reconciled in this PR; the two now differ only in comments.

So: **diff before you sync, in both directions**, and never `cp` a plist over an installed agent
without reading the diff. If the driver plist itself ever needs reinstalling, use
`reload_schedule_once.sh` — a bare `launchctl unload` kills a fire in flight.

**A sync is now more than one file.** `drive.sh` reads its quota fallback from
`$LOOP_LIB/claude_usage.py`, and `LOOP_LIB` defaults to `$INFRA` — the same directory the driver
runs from (#764). So syncing `drive.sh` without `claude_usage.py` silently drops the guard's second
source, which is the exact failure #764 exists to prevent, just re-created by hand. Copy
`drive.sh`, `claude_usage.py`, `test_quota_guard.sh` and `test_claude_usage.py` together, and
write `drive.sh` via a sibling temp file + `mv` rather than `cp` — the live file is being *executed* while you edit it, and an
in-place overwrite corrupts a running fire.

**A sync is not a deploy — though since #811 the driver usually finishes the job itself.** Read the
self-adoption section below before relying on either half of that sentence. `drive.sh`'s body is a
`while true` loop and bash holds its script open by descriptor, so replacing the file does not
change the process now running; what #811 added is that the driver notices and re-`exec`s itself
between fires. It **refuses** to do so in several cases (a file that does not parse, a truncated
sync, a handoff it cannot write, `SELF_ADOPT=0`, or once `MAX_SELF_ADOPT` is spent), and the manual
restart below is the remedy for every one of them — so it is still the thing to reach for when
`driver code: STALE` persists across iterations. Measured 2026-07-31 (#808): the live `drive.sh` was byte-identical
to `origin/main`, and PID 74021 — booted ~15h earlier — was still executing a 13KB-older inode.
#765's quota shadow probe had been merged, synced, and had *never once run*; C3's evidence gate was
therefore accumulating nothing while looking perfectly healthy. After any `loop/` sync:

```sh
launchctl kickstart -k gui/$(id -u)/com.autonomy.studio-build-driver   # -k: restart if running
```

`-k` terminates the current process, so do it between fires, not during one.

**The driver now measures both gaps itself** (#808), once per loop iteration, right after the
iteration's `git fetch` and *ahead of every stop condition* — a run that never fires because the
quota gate, an operator signal or `MAX_STALL` stopped it is exactly a run that might be stopping
because it is executing superseded code, so reporting only alongside a fire would go quiet in the
case that matters most. Two independent verdicts, because the 2026-07-31 incident is exactly the
case where one of them reads healthy and the other does not:

| log line | question | how to read it |
| --- | --- | --- |
| `driver code: live \| STALE \| UNKNOWN` | is *this process* running its own file's contents? | compares the file now against its hash at `DRIVER START`. `STALE` ⇒ restart. |
| `plane drift: in sync \| <names> \| UNKNOWN` | does `~/Dev/studio-loop/` match `origin/main`? | fetches first, then compares git blob ids for every file tracked under `loop/` on main. |

Both are **advisory** — they log and decide nothing, like `quota_shadow_probe`. Every failure path
reads `UNKNOWN`, never a clean bill of health: a plane whose drift could not be measured must not be
indistinguishable from one that is current. A plane *ahead* of main is normal mid-deploy, so
`plane drift` naming files is information, not an alarm; `driver code: STALE` is the one that means
a merged fix is inert. `DRIFT_REPORT=0` silences both — and *only* the literal `0` does, so a typo
such as `DRIFT_REPORT=no` leaves the monitor on rather than switching it off in silence.

`driver code` reads `UNKNOWN` for the whole of any run started before #808 landed, because that
process recorded no boot hash — which is the honest answer, not a gap.

**Since #811 the driver adopts a merged fix itself.** At the top of each iteration — after the
drift report, before every gate and fire, so never mid-fire — `drive_self_adopt` compares the file
against the boot hash and, when it differs, re-`exec`s into it. The manual `kickstart` above is
still the remedy for every case adoption refuses, and `SELF_ADOPT=0` (only the literal `0`) turns
the behaviour off entirely.

The load-bearing part is not the exec, it is what the exec carries. `fires`, `stall`,
`blind_fires`, `budget_regrants`, `crash`, `loops` and `prev_head` live in shell variables, so a
naive exec would silently reset the bounds behind `MAX_STALL`, `MAX_CRASH`, `QUOTA_UNKNOWN_FIRES`
and `MAX_BUDGET_REGRANTS` — trading a visible staleness for an invisible fail-open, which is why
#808 refused to build it. They are handed over in `$INFRA/.driver_handoff`, a single-use
`"<epoch> <k=v,…>"` record written through the same `quota_stamped_write` that owns every other
stamped state file here (#806).

**What is deliberately NOT persisted, and why.** #811 as filed asked for the counters to survive
*any* restart. That would be a worse bug: `MAX_FIRES` is documented as per-run and reset by a
scheduled start, `blind_fires` and `budget_regrants` are per-run by construction, and a `stall`
that survived would **permanently wedge the loop** — once it reached `MAX_STALL`, every future
03:05 run would stop at "nothing more to do" before firing, forever, even after new work was
queued. The guard that must survive a restart is `quota_gate`, and it already does: it reads the
live 7-day window, not a counter. So the handoff is *continuation-only*. The discriminator is the
PID, which `exec` preserves and nothing else does; a record from another PID, or older than
`HANDOFF_MAX_AGE`, is discarded and the run starts clean exactly as it does today.

Adoption refuses — loudly, and staying on the old code — when the new file does not `bash -n`
parse (a half-finished sync must not become an exec into garbage that kills the driver outright),
when the handoff cannot be written or does not read back as written, and after `MAX_SELF_ADOPT`
attempts in one run (which bounds an adopt-*loop* if the file keeps changing underneath the
driver). The record's parse degrades per field rather than all-or-nothing, because on an adopt the
**writer is the old code and the reader is the new one**: a counter the writer did not have resets
alone and is named in the log; a field the reader does not know is ignored and named.

| knob | default | what it does |
| --- | --- | --- |
| `SELF_ADOPT` | `1` | exactly `0` disables self-adoption; any other value still adopts |
| `MAX_SELF_ADOPT` | `3` | adoption *attempts* per driver run |
| `HANDOFF_MAX_AGE` | `300` | seconds after which a handoff is no longer a continuation |
| `DRIVER_HANDOFF` | `$INFRA/.driver_handoff` | where the record is written |

The adopt count rides in the environment as `DRIVE_ADOPT_COUNT` as well as in the record, because
the cap has to survive the record's loss — a mutation test that disabled the record did not turn
assertions red so much as **hang the suite**, adopting forever and never firing. The two combine by
MAX, so a lost carrier can only tighten the cap, and it is `unset` before the loop so no fire ever
inherits it.

Two operator-visible consequences worth knowing at 3am. A handoff that is **present but
unreadable** turns self-adoption **off for the rest of that run** (the bounds it carried are already
lost; refusing further adoption stops the loss repeating) — the log says so, and a restart is the
remedy. And adopting a **rollback** to a `drive.sh` from before #811 resets every bound, because the
code being adopted knows nothing about the handoff.

## Safety model

Three independent bounds, checked before every fire, each with its own test in
`test_quota_guard.sh` (plus a note on the three quota SOURCES those bounds read from):

- **Quota guard** — refuses at/above `QUOTA_STOP_PCT` (80) 7-day utilization. The 7-day window
  resets weekly, so exhausting it locks the operator out of their own sessions for days; stopping
  is the fail-safe direction.
- **Three quota sources, in a deliberate order** — `DASH_URL` (the prototype dashboard,
  `/api/state`) FIRST, then the loop's own usage reader (`LOOP_LIB/claude_usage.py`, relocated out
  of the engine by #764; #766 fixed the *call site* against the old engine module, which the port
  cannot reproduce), then `STUDIO_QUOTA_URL` (studio's native `/api/quota`,
  #440 C1) LAST. All three bottom out in the same
  upstream `GET /api/oauth/usage` on one shared rate-limit budget, and that endpoint 429s under
  direct polling. Only the dashboard rides through it, because it samples in the background and
  answers from a warm cache; the other two are direct polls from a cold start and both return ""
  under a 429. Between those two the *proven* one goes first — #766 measured the loop reader
  returning a real figure, while studio had not returned one *through this path* (#765). **Do not
  read that as "the reader works and studio does not"**: re-measured 2026-07-29, the loop reader's
  token read succeeded and the endpoint 429'd too — the same failure studio reports. Whichever
  process holds the bucket answers, and that is currently the dashboard's 60s sampler, continuously.
  The contrast is confounded; `drive.sh` spells this out at the `quota_pct` header. (Studio has
  since answered for real: an attended probe on 2026-07-30 returned 0.16, matching the dashboard.)
  Studio last is what keeps the SELECTION path free: it is reached only when both others failed, so
  it cannot starve the sampler the primary depends on. Every read logs
  `quota source: <dashboard|loop|loop-memo|studio>`. **Do not reorder** until the promotion evidence
  exists.
- **A once-per-hour DIAGNOSTIC probe of studio** (`quota_shadow_probe`, `QUOTA_SHADOW_MIN_INTERVAL`,
  default 3600s; #765) — because the promotion evidence above was **unobtainable**. `quota source:
  studio` can only be logged when sources 1 and 2 have BOTH failed, so while the dashboard is
  healthy studio is never asked and C3 waits on an outage of the source it replaces. The probe asks
  anyway and logs `quota shadow: studio <n>%` — a **second, non-interchangeable** evidence line:
  `source` means the guard USED studio, `shadow` means studio COULD have answered. It decides
  nothing (it calls `quota_read_url` directly, so there is no code path from it to the quota cache or
  the source-2 memo; it writes nothing to stdout; the call site redirects anyway). **This does mean
  studio is now polled in the common case** — a deliberate reversal, priced at one request per hour
  per active driver, and not the standing ~1/min sampler #770 rejected. `QUOTA_SHADOW_MIN_INTERVAL=0`
  turns it off. Its rate stamp is `.last_quota_shadow` (gitignored), written on the **attempt** so a
  failing studio cannot un-throttle it; if that stamp cannot be written the probe **skips** rather
  than polling un-throttled. `loop-memo` (#777) means source 2 answered from its
  poll memo rather than polling — counted separately on purpose, because a throttle that logged the
  same string either way would hide a source-2 death the way #766 hid for its whole life. **Anchor
  the grep** when counting real source-2 polls: `'quota source: loop ('`, since a bare
  `'quota source: loop'` also matches `loop-memo`. What changed with #765 is *availability*: studio is now
  served by the supervised `com.autonomy.studio-server` unit on 8788 rather than by whatever
  `pnpm dev` happened to be up, so an UNREADABLE from source 3 is finally a measurement of the
  reader instead of a measurement of "no server".
- **Source 2 is poll-throttled** (`QUOTA_POLL_MIN_INTERVAL`, 60s; #777) — it is a fresh `python3`
  process per call, so it cannot cache in memory and nothing gave it a cross-process throttle. With
  `quota_pct` running up to three times per iteration plus once per `AUTH_LONG_BLOCK` retry while
  blocked, and source 1 gone after C3, it could self-inflict the very 429 that then reads as
  UNREADABLE. It now answers from a poll memo (`.last_quota_poll`, gitignored) inside that interval,
  **memoises failures too** (the correct response to a 429 is to poll *less* — the same reason
  studio throttles failed reads, #770), and **drops the memo after every fire**, so a memo can only
  ever serve reads about the fire it was taken for. 60s matches what the other two sources already
  do. `QUOTA_POLL_MIN_INTERVAL=0` disables it; anything over the **300s ceiling is clamped**, and an
  unparseable value falls back to the default with a `WARN` — same for `QUOTA_CACHE_MAX_AGE`, because
  an operand `test` cannot parse returns 2, which is *neither* branch, so the age comparison used to
  fall through and make every stamped record look fresh. `QUOTA_SHADOW_MIN_INTERVAL` goes through the
  same normaliser but has **no ceiling**, deliberately: a ceiling exists where an over-wide value is a
  *fail-open* (it bounds how stale a reading may be when it **permits** a fire), and the shadow probe
  never feeds the guard — a wide value buys less load and less evidence, which is useless but never
  unsafe.
  It is a *ceiling* on the poll rate, not a measured reduction of it — in production those three
  reads are usually minutes apart (`ensure_auth` backs off 30→600s), so the memo mostly bites on
  adjacent reads, a restart mid-iteration, or a manual run racing the scheduled one.
  **The cost, because it is a change of polarity:** unlike `.last_quota` below, the memo is trusted in
  BOTH directions — it can serve a reading up to 60s old that *permits* a fire the live figure would
  refuse. #777 proposed serving nothing in-window for exactly that reason and **was overruled on
  evidence**; the exposure is bounded twice instead (≤60s, and dropped at every fire) rather than
  argued away. The argument, the flat-vs-geometric asymmetry with studio, and the **revisit trigger**
  (source 3 answering makes the fail-safe polarity affordable again) are set out ONCE on
  `quota_poll_memo_read` in `drive.sh` and on #777 — deliberately not restated here, because a
  divergence rationale kept in two places is how the second copy goes stale.
- **What cutover C3 does to that order** — parking `bin/ lib/ tests/ templates/ start` (#410)
  removes source 1 *and*, before #764, removed source 2 as well, because the reader lived in the
  engine's `lib/`. #764 relocated it to `loop/claude_usage.py`, so the surviving pair is
  (loop reader, studio). Be honest about what that pair is: two direct cold pollers of one shared
  rate-limit budget. C3 also removes the warm-cache property that made source 1 reliable, so it is
  a real reduction in the guard's strength, compensated only by the last-known cache below (which
  can refuse but never permit). `loop/claude_usage.py` ships **beside** `drive.sh` — `LOOP_LIB`
  defaults to `$INFRA`, so a sync of the live control plane must carry **both** files.
- **Blind-fire bound** — an UNREADABLE quota is not "fine". A fresh cached reading at/above the
  stop pct refuses outright (usage only rises within a window, so a recent high reading is still
  evidence); otherwise `QUOTA_UNKNOWN_FIRES` (2) blind fires are allowed, then it stops. The cache
  can only ever REFUSE a fire, never permit one.
- **Fire budget** — `MAX_FIRES` (0 = uncapped by default since `a8c72bd`) per run, re-granted
  at most `MAX_BUDGET_REGRANTS` (1) times
  after an auth/limit block long enough that the quota window it was sized against has moved on.

A usage/rate limit is always a PAUSE (back off and retry), never a stop. Only an operator signal,
a real crash loop, nothing-to-do, or the quota guard stops the driver.
