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
| `fire_stats.sh` | Per-fire cost/turn/tool report read from the stream-json logs |
| `reload_schedule_once.sh` | Reload helper for the launchd schedule |
| `install_studio_server.sh` | Installs the SUPERVISED studio server LaunchAgent the quota guard reads |
| `test_install_studio_server.sh` | Sources the real installer; asserts the plist it renders. No launchd, no network |
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
loop/install_studio_server.sh --update     # alias for a re-run (see below)
loop/install_studio_server.sh --uninstall  # remove the unit; KEEPS the state dir (it holds a DB)
```

The installer is idempotent, and `--update` is an **alias for running it again**, not a separate
mode: the install path already fetches, resets the clone to `origin/main`, rebuilds and reloads. It
exists only because "re-run the installer to update" is not obvious. Re-running while the unit is
live is safe — the port-conflict check recognises the service's own pid as its own.

`--uninstall` is scoped to the `HOME` it is run under: it unloads the job only if *this* `HOME`
actually has the plist. Without that scoping a run with a temp `HOME` unloads the operator's live
service while reporting success, which is exactly what happened during review of this change.

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
last-known 7-day reading) and `loop/.last_quota_poll` (the source-2 poll memo, #777) are gitignored.
All three are per-machine and meaningless in another checkout. Nothing here should ever write into a
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
  returning a real figure, while studio has never once returned a number here (#765). **Do not read
  that as "the reader works and studio does not"**: re-measured 2026-07-29, the loop reader's token
  read succeeded and the endpoint 429'd too — the same failure studio reports. Whichever process
  holds the bucket answers, and that is currently the dashboard's 60s sampler, continuously. The
  contrast is confounded; `drive.sh` spells this out at the `quota_pct` header. Studio last is
  what makes it free: it is polled only when both others failed, so it adds no upstream load in the
  common case and cannot starve the sampler the primary depends on. Every read logs
  `quota source: <dashboard|loop|loop-memo|studio>`, which is the evidence for promoting studio.
  **Do not reorder** until that evidence exists. `loop-memo` (#777) means source 2 answered from its
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
  fall through and make every stamped record look fresh.
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
