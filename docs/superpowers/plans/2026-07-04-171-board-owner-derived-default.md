# board.owner derived default (#171 slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The config page offers `board.owner` as a value derived from the repo's GitHub remote (best-effort), instead of raw free text — override always preserved.

**Architecture:** A best-effort `repo_owner_default(repo)` in `bin/dashboard.py` (beside the #170 `board_list`) shells `gh repo view --json owner -q .owner.login` with `cwd=repo`, re-validates the login against the GitHub grammar, and caches it briefly per repo. `config_read_model()` adds `board_owner_derived` to each repo's payload. The config page shows a "from git remote: <owner> · use" hint next to `board.owner` **only** when the field is empty and a derived owner exists; clicking "use" fills (does not auto-save) the field.

**Tech Stack:** Python 3 stdlib only, gh CLI, vanilla JS in `lib/config_page.html`.

## Global Constraints

- macOS `/bin/bash` 3.2.57 compatible; Python 3 **stdlib only** (no third-party imports).
- **Settled-decision 6 (best-effort periphery):** any gh/JSON/validation failure yields `""` — NEVER a fabricated default, never a false warning; the field stays free-text and the page still works. Fail-safe, never fail-open.
- **Prevention-log 6:** a string that crosses into use (display/argv) gets a strict grammar check at the boundary even though gh produced it. The derived login is re-validated against `^[A-Za-z0-9][A-Za-z0-9-]*$` before it is surfaced.
- Best-effort fetch/cache functions document "never raises, falls back safely" (prevention-log entry on best-effort contracts).
- Repo-agnostic: no target-repo-specific owner hardcoded; the value comes only from the repo's own remote.

---

### Task 1: `repo_owner_default` — best-effort derivation + cache (backend)

**Files:**
- Modify: `bin/dashboard.py` (add beside `board_list`, ~line 330)
- Test: `tests/test_dashboard_server.py` (monkeypatch `dashboard._run`, like the board_list tests)

**Interfaces:**
- Produces: `repo_owner_default(repo: str) -> str` — the GitHub owner login for `repo`'s origin remote, or `""` on any failure. Never raises.

- [ ] **Step 1: Write the failing tests** in `tests/test_dashboard_server.py` (new class, mirroring `TestBoardList`'s `_run` monkeypatch + `_owner_cache.clear()` in setUp/tearDown):

```python
class TestRepoOwnerDefault(unittest.TestCase):
    def setUp(self):
        # defensive: the cache attr does not exist yet on the red run, so the
        # test must fail on the MISSING FUNCTION, not on clearing a missing dict.
        if hasattr(dashboard, "_owner_cache"):
            dashboard._owner_cache.clear()
        self._orig_run = dashboard._run
    def tearDown(self):
        dashboard._run = self._orig_run
        if hasattr(dashboard, "_owner_cache"):
            dashboard._owner_cache.clear()

    def test_valid_login_returned(self):
        dashboard._run = lambda args, **kw: "Luke-Bradford\n"
        self.assertEqual(dashboard.repo_owner_default("/r"), "Luke-Bradford")

    def test_gh_failure_yields_empty(self):
        dashboard._run = lambda args, **kw: None
        self.assertEqual(dashboard.repo_owner_default("/r"), "")

    def test_grammar_reject_yields_empty(self):
        dashboard._run = lambda args, **kw: "-bad owner!"
        self.assertEqual(dashboard.repo_owner_default("/r"), "")

    def test_blank_repo_yields_empty_no_gh(self):
        called = {"n": 0}
        dashboard._run = lambda *a, **kw: called.__setitem__("n", called["n"] + 1)
        self.assertEqual(dashboard.repo_owner_default(""), "")
        self.assertEqual(called["n"], 0)

    def test_cached_second_call_skips_gh(self):
        calls = []
        dashboard._run = lambda args, **kw: calls.append(1) or "Acme\n"
        dashboard.repo_owner_default("/r")
        dashboard.repo_owner_default("/r")
        self.assertEqual(len(calls), 1)

    def test_cache_bounded(self):
        dashboard._run = lambda args, **kw: "Acme\n"
        for i in range(dashboard._OWNER_CACHE_MAX + 5):
            dashboard.repo_owner_default("/r%d" % i)
        self.assertLessEqual(len(dashboard._owner_cache), dashboard._OWNER_CACHE_MAX)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 tests/test_dashboard_server.py TestRepoOwnerDefault -v`
Expected: FAIL — `AttributeError: module 'dashboard' has no attribute 'repo_owner_default'`

- [ ] **Step 3: Implement** in `bin/dashboard.py` beside `board_list` (reuse `re`, `time`, `threading` already imported):

```python
# --- config-page board.owner derived default (#171) --------------------------
# The config page offers board.owner as a value DERIVED from the repo's GitHub
# remote instead of raw free text. Best-effort periphery (settled-decision 6):
# any gh/validation failure yields "" -- never a fabricated default, the field
# stays free-text. The login is re-validated against the GitHub grammar before
# it is surfaced (prevention-log 6) even though gh produced it. Cached briefly
# per repo so config reloads/saves don't re-hit slow gh.
_OWNER_LOGIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")
_OWNER_TTL = 60.0
_OWNER_CACHE_MAX = 32
_owner_cache = {}      # repo_path -> (wall_ts, login_str)
_owner_lock = threading.Lock()


def repo_owner_default(repo):
    """Best-effort GitHub owner login for `repo`'s origin remote, for the config
    page's board.owner default. Never raises, never invents: any gh/validation
    failure yields "" (settled-decision 6). Re-validates the login grammar."""
    repo = (repo or "").strip()
    if not repo:
        return ""
    now = time.time()
    with _owner_lock:
        hit = _owner_cache.get(repo)
        if hit and now - hit[0] < _OWNER_TTL:
            return hit[1]
    # never raises (settled-decision 6): any unexpected fault -> "".
    try:
        raw = _run(["gh", "repo", "view", "--json", "owner",
                    "-q", ".owner.login"], cwd=repo, timeout=8)
        login = (raw or "").strip()
        if not _OWNER_LOGIN_RE.match(login):
            login = ""
    except Exception:
        login = ""
    with _owner_lock:
        if len(_owner_cache) >= _OWNER_CACHE_MAX and repo not in _owner_cache:
            for k in [k for k, (ts, _) in _owner_cache.items()
                      if now - ts >= _OWNER_TTL]:
                del _owner_cache[k]
            if len(_owner_cache) >= _OWNER_CACHE_MAX:
                _owner_cache.clear()
        _owner_cache[repo] = (now, login)
    return login
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 tests/test_dashboard_server.py TestRepoOwnerDefault -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add bin/dashboard.py tests/test_dashboard_server.py
git commit -m "feat: repo_owner_default -- best-effort board.owner from the git remote (#171 slice)"
```

---

### Task 2: expose `board_owner_derived` in the config read model

**Files:**
- Modify: `bin/dashboard.py` `config_read_model()` (~line 766, the `repos.append(...)` loop)
- Test: `tests/test_dashboard_server.py` (extend/append — assert the key appears; monkeypatch `_run` + `Handler.repos`)

**Interfaces:**
- Consumes: `repo_owner_default` (Task 1).
- Produces: each `config_read_model()["repos"][i]` gains `"board_owner_derived": str`.

- [ ] **Step 1: Write the failing test** in `tests/test_dashboard_server.py` (find how existing tests set `dashboard.Handler.repos`; a temp repo dir with `.autonomy/config.yaml` is enough — `build_repo_state` tolerates a minimal repo):

```python
class TestConfigReadModelOwnerDerived(unittest.TestCase):
    def setUp(self):
        dashboard._owner_cache.clear()
        self._orig_run = dashboard._run
        self._orig_repos = dashboard.Handler.repos
        self._td = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self._td.name, ".autonomy"))
        with open(os.path.join(self._td.name, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("board:\n  owner: \"\"\n")
        dashboard.Handler.repos = [self._td.name]
    def tearDown(self):
        dashboard._run = self._orig_run
        dashboard.Handler.repos = self._orig_repos
        dashboard._owner_cache.clear()
        self._td.cleanup()

    def test_derived_owner_in_payload(self):
        dashboard._run = lambda args, **kw: "Luke-Bradford\n"
        repo = dashboard.config_read_model()["repos"][0]
        self.assertEqual(repo["board_owner_derived"], "Luke-Bradford")

    def test_derivation_failure_is_empty_not_fatal(self):
        dashboard._run = lambda args, **kw: None
        repo = dashboard.config_read_model()["repos"][0]
        self.assertEqual(repo["board_owner_derived"], "")
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 tests/test_dashboard_server.py TestConfigReadModelOwnerDerived -v`
Expected: FAIL — `KeyError: 'board_owner_derived'`

- [ ] **Step 3: Implement** — in `config_read_model()` extend the `repos.append(...)` dict. `repo_owner_default` never raises, but wrap defensively to match the existing `try/except` posture around `build_repo_state`:

```python
        try:
            owner_derived = repo_owner_default(repo)
        except Exception:
            owner_derived = ""
        repos.append({"path": repo, "name": os.path.basename(repo.rstrip("/")),
                      "config": cfg, "board_owner_derived": owner_derived})
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 tests/test_dashboard_server.py TestConfigReadModelOwnerDerived -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add bin/dashboard.py tests/test_dashboard_server.py
git commit -m "feat: config read model carries board_owner_derived per repo (#171 slice)"
```

---

### Task 3: config-page hint — offer the derived owner when the field is empty

**Files:**
- Modify: `lib/config_page.html` (`renderCfg` board.owner line + new `cfgFieldOwner`/`cfgUseOwner`; reuse existing `.hint`/`.cbtn` classes, add a minimal `.cfghint` rule only if none fits)

**Interfaces:**
- Consumes: `r.board_owner_derived` from `/api/config` (Task 2).

- [ ] **Step 1: Replace the board.owner render line** in `renderCfg`:

From:
```js
      ${cfgField(enc,"board.owner","board owner",c.board_owner)}
```
To:
```js
      ${cfgFieldOwner(enc,"board.owner","board owner",c.board_owner,r.board_owner_derived)}
```

- [ ] **Step 2: Add the two functions** near `cfgField`:

```js
// board.owner derived default (#171): the same row as cfgField, plus a hint
// offering the owner gh derived from the repo's git remote -- shown ONLY when
// the field is empty AND a derived owner exists. Clicking "use" fills (does not
// save) the field, so the committed value always wins and an override stays
// possible. Best-effort: no derived value -> just the plain field.
function cfgFieldOwner(enc,key,label,val,derived){
  const row=`<div class="cfgrow"><span class="cfglab">${esc(label)}</span><input class="cfgin" name="${key}" data-key="${key}" value="${esc(val||"")}"><button class="cbtn" onclick="cfgSave(this,'${enc}','${key}')">save</button></div>`;
  const d=(derived||"").trim();
  if((val||"").trim()||!d) return row;
  // the derived owner rides in a data attribute (not an inline JS string arg):
  // esc() is HTML-escaping, which is NOT JS-string escaping, so interpolating it
  // into onclick would be unsafe if the grammar ever regressed. The handler
  // reads it back via getAttribute.
  return row+`<div class="cfghint">from git remote: <b>${esc(d)}</b> <button class="cbtn" data-owner="${esc(d)}" onclick="cfgUseOwner(this)">use</button></div>`;
}
function cfgUseOwner(btn){
  const owner=btn.getAttribute("data-owner")||"";
  const repoEl=btn.closest(".cfgrepo");
  const input=repoEl&&repoEl.querySelector('[name="board.owner"]');
  if(!input) return;
  input.value=owner; input.focus();
  // the field is now non-empty, so the hint's invariant (shown only when empty)
  // no longer holds -- remove it. Still unsaved until the operator clicks save
  // (override preserved); refresh the #170 board picker against the filled owner.
  const hint=btn.closest(".cfghint");
  if(hint) hint.remove();
  refreshRepoBoards(repoEl);
}
```

- [ ] **Step 3: Add a `.cfghint` CSS rule** only if no existing neutral hint class fits (check the `<style>` block; `.hint` may suffice for text but the inline button needs alignment). Minimal:

```css
.cfghint{font-size:12px;color:var(--muted,#8b949e);margin:2px 0 6px 0;display:flex;gap:6px;align-items:center}
```
(Match the file's existing token/variable names — read the `<style>` block first and reuse its muted color variable.)

- [ ] **Step 4: Browser-verify** per `.claude/skills/dashboard/SKILL.md`:

```bash
python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790 &
```
Drive `/config` via chrome-devtools MCP: `new_page` → `take_snapshot` → `list_console_messages` (ZERO `error`) → `list_network_requests` (`/api/config` 200). The fixture repo has no GitHub remote, so the derived value is `""` and NO hint shows — assert the board.owner field renders normally (the correct empty state). Then confirm the positive path with `evaluate_script`:
```js
cfgFieldOwner("x","board.owner","board owner","","Acme-Co").includes("from git remote")   // => true
cfgFieldOwner("x","board.owner","board owner","already-set","Acme-Co").includes("from git remote")  // => false
```
Kill the server after.

- [ ] **Step 5: Commit**

```bash
git add lib/config_page.html
git commit -m "feat: config page offers board.owner derived from the git remote (#171 slice)"
```

---

## Self-Review

- **Spec coverage:** #171 board.owner row = "derive default from the repo's remote (`gh repo view --json owner`); page shows derived value, override stays possible" → Task 1 (derive), Task 2 (expose), Task 3 (page shows + override preserved). ✅ Other #171 rows are split out (#170 title picker, #82 model picker, #87 account select) or already shipped (#205 scope-labels, #209 marker) — out of this slice's scope.
- **Placeholder scan:** none.
- **Type consistency:** `repo_owner_default(repo)->str`, payload key `board_owner_derived`, JS reads `r.board_owner_derived` — consistent across tasks.
