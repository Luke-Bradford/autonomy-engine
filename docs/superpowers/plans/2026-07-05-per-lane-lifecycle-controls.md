# Per-Lane Lifecycle Controls Implementation Plan (#147 remainder)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The control-room's lane rows (multi-lane repos) and selected-lane detail header act on *that lane's* supervisor service — pause/resume via the lane worktree's sentinel, stop/start via the lane's own launchd label — instead of silently acting on the registered worktree's service.

**Architecture:** SD-21: a lane = its own worktree + its own launchd service (`com.autonomy.<slug>.<lane>.supervisor`, provisioned by `setup_worktree.sh --lane`). The dashboard's registered repo is ONE of those worktrees; sibling lanes are *not* assumed to be dashboard-managed. Resolution is strict and constructed, never scanned-and-guessed: derive `<slug>` from the registered repo's own plist, construct the sibling label exactly, content-verify the plist's `--lane` value, extract its `--repo` for the sentinel path. The lane name is gated server-side against the repo's config (`roles.lanes_valid` + `lane_names`) before any filesystem use — unknown/unprovisioned lanes REFUSE, never fall back to the default service (fail-safe, never fail-open). Per-lane button states come from engine-owned artifacts only (sentinel + `lib/health.py` heartbeat reads of the sibling worktree) — no `launchctl` queries.

**Tech Stack:** Python 3 stdlib (`lib/dashboard_control.py`, `lib/dashboard_state.py`, `bin/dashboard.py`), vanilla JS in `lib/dashboard_page.html`. bash 3.2.57 untouched (no shell changes).

## Global Constraints

- Python 3 stdlib only; no new dependencies.
- Repo-agnostic `bin/`/`lib/` — no hardcoded owners/titles/paths.
- Fail-safe, never fail-open: unknown lane / missing sibling plist / unreadable config → refuse with a clear error; NEVER act on the default service as a fallback.
- Lane names re-validated server-side (`^[A-Za-z0-9._-]{1,64}$`, same as `supervisor.sh validate_lane`) before reaching any filename construction (prevention-log #6).
- Single-lane repos render byte-identical (no `lanes:` block ⇒ zero change).
- Display truth (#234-class): no button may imply a state we cannot observe; a lane with no installed service gets NO cluster.
- Tests source the real modules; plist fixtures in `$tmp` (established `test_dashboard_control.py` pattern).

## File Structure

- `lib/dashboard_control.py` — pure-ish resolution: `parse_plist_args()`, `is_valid_lane_name()`, `find_lane_service()` (file I/O like the existing `find_service`).
- `bin/dashboard.py` — `execute_control(repo, action, lane=None)` + POST body `lane` handling + config-authoritative lane gate; passes `LAUNCH_AGENTS` into state build.
- `lib/dashboard_state.py` — `lane_status(worktree, now)` + `lanes.services` block on multi-lane repos.
- `lib/dashboard_page.html` — `lifecycleCluster(r, st, lane)` lane param, `control(repoEnc, action, label, lane)`, lane cluster on `.lgrp-h` rows + lane-aware detail-header cluster.
- Tests: `tests/test_dashboard_control.py`, `tests/test_dashboard_state.py`, `tests/test_dashboard_server.py`.

---

### Task 1: lane service resolution in `lib/dashboard_control.py`

**Files:**
- Modify: `lib/dashboard_control.py` (after `find_service`, ~line 232)
- Test: `tests/test_dashboard_control.py`

**Interfaces:**
- Consumes: existing `find_service(repo, launch_agents_dir)` → `{label, plist}|None`.
- Produces:
  - `is_valid_lane_name(lane) -> bool` — `^[A-Za-z0-9._-]{1,64}$` full match.
  - `parse_plist_args(text) -> {"repo": str|None, "lane": str|None}` — the `<string>--repo</string><string>X</string>` / `--lane` pairs from our own template's rendering.
  - `find_lane_service(repo, lane, launch_agents_dir, default_lane=None) -> {"label","plist","repo"} | {"error": str} | None` — `None` means "requested lane IS the registered service's own lane — use the existing path"; a dict with `repo` = the sibling lane's worktree path. **CP1 High-1:** when `lane == default_lane`, the sibling label is the LEGACY `com.autonomy.<slug>.supervisor` (SD-21: the default lane keeps the legacy label — `setup_worktree.sh lane_label_middle`), and its plist must have NO `--lane`; only a non-default lane constructs `com.autonomy.<slug>.<lane>.supervisor`. **CP1 Med-5:** verify the found plist's `<key>Label</key>` string equals the constructed label (a stale/mismatched plist must refuse, or stop's constructed label and start's internal label diverge).

- [ ] **Step 1: failing tests** — add to `tests/test_dashboard_control.py` (reuse its `PLIST` fixture idiom; add a lane-arg variant). **Check first** whether the existing `PLIST` fixture carries a `<key>Label</key>` entry — the Label-verification path needs it; extend the fixture (all existing tests must stay green) if it doesn't:

```python
LANE_PLIST = """<?xml version="1.0"?><plist><dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>/eng/bin/supervisor.sh</string>
    <string>--repo</string><string>%s</string>
    <string>--lane</string><string>%s</string>
  </array></dict></plist>"""

class TestFindLaneService(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.repo = "/Users/op/.myrepo-autonomy"
        # the registered (default-lane) service
        with open(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"), "w") as fh:
            fh.write(PLIST % self.repo)

    def _lane_plist(self, label_mid, worktree, lane):
        name = "com.autonomy.%s.supervisor.plist" % label_mid
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(LANE_PLIST % ("com.autonomy.%s.supervisor" % label_mid, worktree, lane))

    def test_sibling_lane_resolves_label_and_worktree(self):
        self._lane_plist("myrepo.qa", "/Users/op/.myrepo-qa-autonomy", "qa")
        svc = dc.find_lane_service(self.repo, "qa", self.dir)
        self.assertEqual(svc["label"], "com.autonomy.myrepo.qa.supervisor")
        self.assertEqual(svc["repo"], "/Users/op/.myrepo-qa-autonomy")

    def test_missing_sibling_plist_is_error_never_default(self):
        svc = dc.find_lane_service(self.repo, "qa", self.dir)
        self.assertIn("error", svc)
        self.assertIn("setup_worktree", svc["error"])

    def test_lane_content_mismatch_is_error(self):
        # a plist named .qa. whose --lane says something else: refuse
        self._lane_plist("myrepo.qa", "/Users/op/.myrepo-qa-autonomy", "prod")
        self.assertIn("error", dc.find_lane_service(self.repo, "qa", self.dir))

    def test_own_lane_returns_none_when_registered_is_that_lane(self):
        # registered worktree runs lane qa itself -> None (use existing path)
        os.remove(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"))
        self._lane_plist("myrepo.qa", self.repo, "qa")
        self.assertIsNone(dc.find_lane_service(self.repo, "qa", self.dir))

    def test_no_own_service_is_error(self):
        self.assertIn("error", dc.find_lane_service("/nope", "qa", self.dir))

    def test_bad_lane_name_is_error_before_io(self):
        self.assertIn("error", dc.find_lane_service(self.repo, "../x", self.dir))

    def test_default_lane_from_nonown_registration_uses_legacy_label(self):
        # registered worktree IS lane qa; requested lane = default 'main':
        # resolve the LEGACY com.autonomy.myrepo.supervisor (SD-21), never
        # a constructed .main. label.
        os.remove(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"))
        self._lane_plist("myrepo.qa", self.repo, "qa")
        with open(os.path.join(self.dir, "com.autonomy.myrepo.supervisor.plist"), "w") as fh:
            fh.write(PLIST % "/Users/op/.myrepo-autonomy-main")
        svc = dc.find_lane_service(self.repo, "main", self.dir, default_lane="main")
        self.assertEqual(svc["label"], "com.autonomy.myrepo.supervisor")
        self.assertEqual(svc["repo"], "/Users/op/.myrepo-autonomy-main")

    def test_label_content_mismatch_is_error(self):
        # plist file named .qa. whose internal Label says something else:
        # stop (constructed label) and start (plist's internal Label) would
        # act on different targets -- refuse.
        name = "com.autonomy.myrepo.qa.supervisor.plist"
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(LANE_PLIST % ("com.autonomy.OTHER.supervisor",
                                   "/Users/op/.myrepo-qa-autonomy", "qa"))
        self.assertIn("error", dc.find_lane_service(self.repo, "qa", self.dir))
```

- [ ] **Step 2:** run `python3 -m unittest tests.test_dashboard_control -v` → new tests FAIL (`no attribute 'find_lane_service'`).
- [ ] **Step 3: implement** in `lib/dashboard_control.py`:

```python
_LANE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

def is_valid_lane_name(lane):
    return bool(_LANE_NAME_RE.fullmatch(lane or ""))

def parse_plist_args(text):
    """--repo / --lane values from our own supervisor plist template."""
    out = {"repo": None, "lane": None}
    for key in ("repo", "lane"):
        m = re.search(r"<string>--%s</string>\s*<string>([^<]+)</string>" % key, text)
        if m:
            out[key] = m.group(1)
    return out

def find_lane_service(repo, lane, launch_agents_dir, default_lane=None):
    """Resolve lane -> ITS launchd service, strictly. None = the registered
    service already runs this lane (caller uses the existing path). Errors
    refuse; there is NO fallback to a different service (fail-open bar).
    default_lane: the config-authoritative default -- the default lane keeps
    the LEGACY label com.autonomy.<slug>.supervisor with no --lane (SD-21)."""
    if not is_valid_lane_name(lane):
        return {"error": "invalid lane name"}
    own = find_service(repo, launch_agents_dir)
    if own is None:
        return {"error": "no launchd service installed for this repo -- run setup_worktree.sh first"}
    try:
        with open(own["plist"], errors="replace") as fh:
            own_text = fh.read()
    except OSError:
        return {"error": "cannot read the repo's own plist"}
    own_args = parse_plist_args(own_text)
    seg = own["label"][len("com.autonomy."):-len(".supervisor")]
    own_lane = own_args.get("lane")
    is_default = (default_lane is not None and lane == default_lane)
    if own_lane == lane or (own_lane is None and is_default):
        return None
    slug = seg
    if own_lane and is_valid_lane_name(own_lane) and seg.endswith("." + own_lane):
        slug = seg[:-(len(own_lane) + 1)]
    label = ("com.autonomy.%s.supervisor" % slug if is_default
             else "com.autonomy.%s.%s.supervisor" % (slug, lane))
    plist = os.path.join(launch_agents_dir, label + ".plist")
    try:
        with open(plist, errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {"error": "no service installed for lane '%s' -- run setup_worktree.sh <target-repo> --lane %s" % (lane, lane)}
    args = parse_plist_args(text)
    want_lane = None if is_default else lane
    if args.get("lane") != want_lane or not args.get("repo"):
        return {"error": "plist for lane '%s' does not match (lane=%r) -- refusing" % (lane, args.get("lane"))}
    if "<string>%s</string>" % label not in text.split("ProgramArguments")[0]:
        return {"error": "plist Label does not match its filename for lane '%s' -- refusing (stale plist?)" % lane}
    return {"label": label, "plist": plist, "repo": args["repo"]}
```

(The Label check scopes to the text before `ProgramArguments` — the `<key>Label</key>` value is the only `<string>` there in our template; a full plist parser is not warranted for our own rendered template.)

- [ ] **Step 4:** run the suite → PASS.
- [ ] **Step 5:** commit `feat: lane->service resolution in dashboard_control (#147)`.

**Own-lane vs default subtlety:** `own_lane == lane` only matches when the registered worktree is a NON-default lane worktree named `lane`. The "requested lane == config default lane AND own service has no `--lane`" equivalence is decided in Task 2 where the config is authoritative — `find_lane_service` is not called in that case at all.

---

### Task 2: `execute_control` lane parameter + POST gate in `bin/dashboard.py`

**Files:**
- Modify: `bin/dashboard.py` — `execute_control` (~line 1245) + the POST dispatch (~line 1522)
- Test: `tests/test_dashboard_server.py` (new class, function-level like the others)

**Interfaces:**
- Consumes: Task 1's `find_lane_service`; `roles.lanes_valid/lane_names/default_lane` (import `roles` — same `lib/` path already on `sys.path`); `config_parser.parse`.
- Produces: `execute_control(repo, action, lane=None)`; POST body key `lane` (optional string).

- [ ] **Step 1: failing tests** — new class in `tests/test_dashboard_server.py`; build a tmp repo with a `lanes:` config + a fake LaunchAgents dir; patch `dashboard.LAUNCH_AGENTS`:

```python
class TestLaneControl(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, ".myrepo-autonomy")
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            # real lanes schema (test_roles.py idiom): only `worktree:` is a
            # valid lane key; the FIRST declared lane is the default -- there
            # is no `default:` flag (roles.default_lane).
            fh.write("lanes:\n"
                     "  main:\n    worktree: ../.myrepo-autonomy\n"
                     "  qa:\n    worktree: ../.myrepo-qa-autonomy\n"
                     "roles:\n  coder:\n    enabled: true\n"
                     "    trigger: { type: loop }\n")
        self.la = os.path.join(self.tmp, "LaunchAgents")
        os.makedirs(self.la)
        self._plist("com.autonomy.myrepo.supervisor", self.repo, None)
        self.qa_wt = os.path.join(self.tmp, ".myrepo-qa-autonomy")
        os.makedirs(os.path.join(self.qa_wt, "var", "autonomy-logs"))
        self._plist("com.autonomy.myrepo.qa.supervisor", self.qa_wt, "qa")
        self._saved = dashboard.LAUNCH_AGENTS
        dashboard.LAUNCH_AGENTS = self.la

    def tearDown(self):
        dashboard.LAUNCH_AGENTS = self._saved

    def test_lane_pause_touches_the_lane_worktrees_sentinel(self):
        r = dashboard.execute_control(self.repo, "pause", lane="qa")
        self.assertTrue(r["ok"], r)
        self.assertTrue(os.path.exists(os.path.join(
            self.qa_wt, "var", "autonomy-logs", "autonomy-PAUSE")))
        self.assertFalse(os.path.exists(os.path.join(
            self.repo, "var", "autonomy-logs", "autonomy-PAUSE")))

    def test_default_lane_name_uses_the_repos_own_path(self):
        r = dashboard.execute_control(self.repo, "pause", lane="main")
        self.assertTrue(r["ok"], r)
        self.assertTrue(os.path.exists(os.path.join(
            self.repo, "var", "autonomy-logs", "autonomy-PAUSE")))

    def test_unknown_lane_refuses(self):
        r = dashboard.execute_control(self.repo, "pause", lane="prod")
        self.assertFalse(r["ok"])
        # prove nothing happened: no sentinel appeared in EITHER worktree
        # (CP1 Low-7: execute_control never returns plan keys, so asserting
        # on the result dict alone proves nothing).
        for wt in (self.repo, self.qa_wt):
            self.assertFalse(os.path.exists(os.path.join(
                wt, "var", "autonomy-logs", "autonomy-PAUSE")))

    def test_unprovisioned_lane_refuses_never_falls_back(self):
        os.remove(os.path.join(self.la, "com.autonomy.myrepo.qa.supervisor.plist"))
        r = dashboard.execute_control(self.repo, "stop", lane="qa")
        self.assertFalse(r["ok"])
        self.assertIn("setup_worktree", r["error"])
```

(`_plist` helper mirrors Task 1's fixtures; check the config shape against `roles.py`'s actual `lanes:` schema before writing — adjust keys to the real schema.)

- [ ] **Step 2:** run → FAIL (`execute_control() got an unexpected keyword argument 'lane'`).
- [ ] **Step 3: implement** — in `execute_control`:

```python
def execute_control(repo, action, lane=None):
    uid = os.getuid()
    service = dcx.find_service(repo, LAUNCH_AGENTS)
    target_repo = repo
    if lane:
        if not dcx.is_valid_lane_name(lane):
            return {"ok": False, "error": "invalid lane name"}
        try:
            with open(os.path.join(repo, ".autonomy", "config.yaml"), encoding="utf-8") as fh:
                config = config_parser.parse(fh.read())
        except (OSError, ValueError):
            return {"ok": False, "error": "cannot read .autonomy/config.yaml -- refusing lane control"}
        if not roles_schema.lanes_valid(config):
            return {"ok": False, "error": "lanes: block is invalid -- refusing lane control"}
        if lane not in roles_schema.lane_names(config):
            return {"ok": False, "error": "unknown lane %r" % lane}
        svc = dcx.find_lane_service(repo, lane, LAUNCH_AGENTS,
                                    default_lane=roles_schema.default_lane(config))
        if svc is None:
            pass                           # own service already runs this lane
        elif "error" in svc:
            return {"ok": False, "error": svc["error"]}
        else:
            service, target_repo = {"label": svc["label"], "plist": svc["plist"]}, svc["repo"]
    plan = dcx.control_plan(target_repo, action, service, uid)
    ... (unchanged body)
```

POST dispatch: `lane = str(body.get("lane") or "") or None`, pass to `execute_control`. Imports: add `import config_parser` / `import roles as roles_schema` if absent (check the hot-reload module list at `bin/dashboard.py:118` and register any new module the same way the others are).

- [ ] **Step 4:** run the class + whole file → PASS.
- [ ] **Step 5:** commit `feat: /api/control takes a lane -- resolves that lane's service+worktree (#147)`.

---

### Task 3: per-lane status + lane cluster render

**Files:**
- Modify: `lib/dashboard_state.py` (build_repo_state lanes block, ~line 1991)
- Modify: `bin/dashboard.py` (pass `LAUNCH_AGENTS` into the state build)
- Modify: `lib/dashboard_page.html` (`lifecycleCluster`, `control`, `.lgrp-h` render ~line 973, detail header ~line 697)
- Test: `tests/test_dashboard_state.py`

**Interfaces:**
- Consumes: Task 1's `find_lane_service`/`parse_plist_args`; `health.read_heartbeat` + freshness; `dashboard_control.sentinel_path`.
- Produces: `r["lanes"]["services"] = {name: {"installed": bool, "own": bool, "status": str|None}}` (present only when `valid` and >1 lane and a launch-agents dir was provided); JS `control(repoEnc, action, label, lane)`.

- [ ] **Step 1: failing tests** in `tests/test_dashboard_state.py` — `lane_status(worktree, now)`:

```python
def test_lane_status_paused_by_sentinel(...)      # sentinel file -> "paused"
def test_lane_status_working_fresh_session_running(...)  # heartbeat phase session-running, fresh -> "working"
def test_lane_status_idle_fresh_other_phase(...)  # phase board-empty, fresh -> "idle"
def test_lane_status_stopped_when_stale_or_absent(...)   # no heartbeat, or stale beyond the NOW-card staleness rule -> "stopped"
def test_lane_status_wedged(...)                  # session-running + stale artifacts -> "wedged"
```

and `build_repo_state` integration: multi-lane fixture + fake LaunchAgents dir ⇒ `lanes.services` has `own: True` for the registered lane (status `None` — the card's own status applies), a DECLARED sibling with a plist installed carries its coarse status, a DECLARED-but-unprovisioned sibling is `installed: False, status: None`. `services` iterates DECLARED lane names ONLY — an undeclared lane never appears (CP1 Med-6; unknown-lane POST refusal is Task 2's separate test). Single-lane fixture ⇒ NO `services` key (byte-compat).

**Before writing these**: read how `build_repo_state` computes the NOW-card heartbeat staleness guard (#182) and reuse the SAME threshold constant; read how `test_dashboard_state.py` builds repo fixtures and copy that idiom.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement**:

```python
def lane_status(worktree, now=None):
    """Coarse per-lane display status from engine artifacts only (no launchctl):
    paused | working | idle | wedged | stopped. Wedge detection = lib/health;
    a fresh non-working heartbeat is idle; stale/absent reads stopped (coarse:
    a hard-killed supervisor and a never-started one look alike -- accepted,
    the buttons are the same)."""
    now = time.time() if now is None else now
    logdir = os.path.join(worktree, "var", "autonomy-logs")
    if os.path.exists(dashboard_control.sentinel_path(worktree)):
        return "paused"
    hb = health.read_heartbeat(logdir)
    if not hb:
        return "stopped"
    h = health.loop_health(logdir, now)
    if h.get("state") == "wedged":       # health returns "state", NOT "status" (CP1 High-3)
        return "wedged"
    phase = str(hb.get("phase") or "")
    if phase.startswith("session-running") or phase.startswith("dispatching"):
        return "working"
    if phase == "stopped":
        return "stopped"
    return "idle" if <fresh per the #182 staleness rule> else "stopped"
```

`build_repo_state(..., launch_agents_dir=None)` (default None keeps every existing caller/test byte-identical): when multi-lane + valid + dir given, for each declared lane resolve via `find_lane_service`; `None` ⇒ own lane (`{"installed": True, "own": True, "status": None}`); error/missing ⇒ `{"installed": False, "own": False, "status": None}`; resolved ⇒ `{"installed": True, "own": False, "status": lane_status(svc["repo"])}`. Wrap the whole block in try/except → omit `services` on any surprise (render stays total). `bin/dashboard.py` passes `LAUNCH_AGENTS` at its `build_repo_state`/state-assembly call site.

- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: page render** — `lifecycleCluster(r, st, lane)`: `ibtn` onclick gains the lane argument (empty for repo-scope); `control(repoEnc, action, label, lane)` adds `lane` to the POST body when truthy. `.lgrp-h` (line ~973): **guard explicitly** (CP1 High-2) — `const svc = r.lanes && r.lanes.services && r.lanes.services[ln]; svc && svc.installed ? lifecycleCluster(r, svc.own ? st : svc.status, svc.own ? "" : ln) : ""` — `services` absent (older payload, degraded build, single-lane) ⇒ NO cluster, no throw, no repo-state stand-in for a sibling lane (#234 display-truth). Uninstalled ⇒ no cluster; `title` notes "not provisioned — setup_worktree.sh --lane". Detail header (line ~697): same guard — the existing repo-scoped cluster renders ONLY when the selected lane is `svc.own` (or the repo is single-lane); a non-own selected lane uses its `svc.status` + lane param, and with no service truth renders no cluster at all. Single-lane repos: `services` absent ⇒ all new paths no-op, byte-identical.
- [ ] **Step 6:** python suites + `bash tests/run_all.sh` + shellcheck → clean.
- [ ] **Step 7: browser verify** (dashboard skill): fixture `repo-alpha` (single-lane — byte-identical, zero console errors) + a `/tmp` multi-lane repo with a fake LaunchAgents dir (env/param seam) — verify lane rows show clusters with per-lane state, uninstalled lane shows none, POST returns 200, toasts render. Kill servers after (`lsof -tnP -iTCP:<port>` first — stale-server hazard).
- [ ] **Step 8:** commit `feat: lane rows carry their own lifecycle cluster (#147)`.

---

## Deferred (state on the ticket, not built here)

- Repo-level "all lanes" convenience action.
- Full sibling-lane session visibility (cards/rows for sibling worktrees' sessions) — that is the #147 `instances:` N-visibility build.
- `wedged` nuance for siblings beyond health.py's rule.

## Self-review notes

- Spec coverage: #147 remainder comment = "per-lane lifecycle controls ride the UI-2 icon-cluster pattern; wired to supervisor --lane services" — Tasks 1–3 cover control + honest state + render; deferred items listed.
- Fail-open scan: unknown lane refuses (Task 2 gate); missing plist refuses with provisioning hint; content-mismatch refuses; config unreadable refuses; state build degrades by OMITTING services (display-only, buttons vanish — safe direction).
- Type consistency: `find_lane_service` returns `None|dict-with-error|dict-with-repo` — Task 2's three-way branch matches; `services` shape identical between Task 3 state and render.
