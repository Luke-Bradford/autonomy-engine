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
`test_quota_guard.sh`:

- **Quota guard** — refuses at/above `QUOTA_STOP_PCT` (80) 7-day utilization. The 7-day window
  resets weekly, so exhausting it locks the operator out of their own sessions for days; stopping
  is the fail-safe direction.
- **Two quota sources, in a deliberate order** — `DASH_URL` (the prototype dashboard,
  `http://127.0.0.1:8787/api/state`) is read FIRST, `STUDIO_QUOTA_URL` (studio's native
  `http://127.0.0.1:8080/api/quota`, #440 C1) SECOND. Both ultimately read the same upstream
  `GET /api/oauth/usage` on one shared rate-limit budget, and that endpoint 429s under direct
  polling. The dashboard rides through because it samples in the background and serves a warm
  cache; studio's reader is lazy, so every read is a direct poll. Studio is therefore second —
  when the dashboard answers, studio is never polled and adds zero upstream load. **Do not invert
  this** until studio's reader stops polling upstream on the request path. Every read logs
  `quota source: <dashboard|studio>`, which is how the decision to promote it gets made.
- **Blind-fire bound** — an UNREADABLE quota is not "fine". A fresh cached reading at/above the
  stop pct refuses outright (usage only rises within a window, so a recent high reading is still
  evidence); otherwise `QUOTA_UNKNOWN_FIRES` (2) blind fires are allowed, then it stops. The cache
  can only ever REFUSE a fire, never permit one.
- **Fire budget** — `MAX_FIRES` (6) per run, re-granted at most `MAX_BUDGET_REGRANTS` (1) times
  after an auth/limit block long enough that the quota window it was sized against has moved on.

A usage/rate limit is always a PAUSE (back off and retry), never a stop. Only an operator signal,
a real crash loop, nothing-to-do, or the quota guard stops the driver.
