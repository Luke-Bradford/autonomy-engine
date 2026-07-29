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
| `test_quota_guard.sh` | Drives the REAL `drive.sh` with PATH stubs. No network, no tokens, ~3 min |
| `fire_stats.sh` | Per-fire cost/turn/tool report read from the stream-json logs |
| `reload_schedule_once.sh` | Reload helper for the launchd schedule |
| `com.autonomy.studio-build-*.plist` | The launchd agents |

## Runtime state is NOT tracked

`loop/logs/` (one multi-MB stream-json file per fire — ~546MB and growing) and `loop/.last_quota`
are gitignored. Nothing here should ever write into a tracked path.

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

## Safety model

Three independent bounds, checked before every fire, each with its own test in
`test_quota_guard.sh` (plus a note on the two quota SOURCES those bounds read from):

- **Quota guard** — refuses at/above `QUOTA_STOP_PCT` (80) 7-day utilization. The 7-day window
  resets weekly, so exhausting it locks the operator out of their own sessions for days; stopping
  is the fail-safe direction.
- **Three quota sources, in a deliberate order** — `DASH_URL` (the prototype dashboard,
  `/api/state`) FIRST, then the engine's usage reader (`ENGINE_LIB`, fixed in #766), then
  `STUDIO_QUOTA_URL` (studio's native `/api/quota`, #440 C1) LAST. All three bottom out in the same
  upstream `GET /api/oauth/usage` on one shared rate-limit budget, and that endpoint 429s under
  direct polling. Only the dashboard rides through it, because it samples in the background and
  answers from a warm cache; the other two are direct polls from a cold start and both return ""
  under a 429. Between those two the *proven* one goes first — #766 measured the engine reader
  returning a real figure, while studio has never once returned a number here (#765). Studio last is
  what makes it free: it is polled only when both others failed, so it adds no upstream load in the
  common case and cannot starve the sampler the primary depends on. Every read logs
  `quota source: <dashboard|engine|studio>`, which is the evidence for promoting studio. **Do not
  reorder** until studio's reader stops polling upstream on the request path.
- **Blind-fire bound** — an UNREADABLE quota is not "fine". A fresh cached reading at/above the
  stop pct refuses outright (usage only rises within a window, so a recent high reading is still
  evidence); otherwise `QUOTA_UNKNOWN_FIRES` (2) blind fires are allowed, then it stops. The cache
  can only ever REFUSE a fire, never permit one.
- **Fire budget** — `MAX_FIRES` (0 = uncapped by default since `a8c72bd`) per run, re-granted
  at most `MAX_BUDGET_REGRANTS` (1) times
  after an auth/limit block long enough that the quota window it was sized against has moved on.

A usage/rate limit is always a PAUSE (back off and retry), never a stop. Only an operator signal,
a real crash loop, nothing-to-do, or the quota guard stops the driver.
