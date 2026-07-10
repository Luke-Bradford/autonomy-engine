"""Unit test for the dashboard server's benign-disconnect classifier -- the
guard that stops a browser resetting an SSE/keep-alive connection from spewing
a traceback that looks like the app crashing -- and the served-page templating
that single-sources the model-picker roster (#134)."""
import json
import os
import re
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import dashboard  # noqa: E402
import accounts  # noqa: E402


class TestConfigOverlayWrite(unittest.TestCase):
    """#202: model/effort default-saves land in an untracked overlay under
    var/autonomy-logs (survives the preflight stash-recovery), never the
    tracked config.yaml. _write_overlay merges/preserves; the POST executors
    (execute_set_model default scope, execute_config_set model keys) route
    there end-to-end."""
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name

    def tearDown(self):
        self._td.cleanup()

    def _overlay(self):
        return os.path.join(self.repo, "var", "autonomy-logs", "config-overrides")

    def _write_config(self):
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        cfg = os.path.join(self.repo, ".autonomy", "config.yaml")
        with open(cfg, "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n")
        return cfg

    def _gitify(self):
        # Slice 3a: live-shadow writes require var/ gitignored (SD-34).
        import subprocess
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")

    def _live(self):
        return os.path.join(self.repo, "var", "autonomy", "config.yaml")

    def test_execute_set_model_default_writes_live_shadow_not_config(self):
        cfg = self._write_config()
        self._gitify()
        before = open(cfg).read()
        r = dashboard.execute_set_model(self.repo, "claude-opus-4-8", "high", "default")
        self.assertTrue(r["ok"], r)
        self.assertEqual(open(cfg).read(), before)    # committed config untouched
        live = open(self._live()).read()
        self.assertIn("claude-opus-4-8", live)
        self.assertIn("effort: high", live)
        self.assertFalse(os.path.exists(self._overlay()))   # overlay retired

    def test_execute_config_set_model_key_writes_live_shadow(self):
        cfg = self._write_config()
        self._gitify()
        before = open(cfg).read()
        r = dashboard.execute_config_set(self.repo, "agent.model.primary",
                                         "claude-opus-4-8")
        self.assertTrue(r["ok"], r)
        self.assertEqual(open(cfg).read(), before)
        self.assertIn("claude-opus-4-8", open(self._live()).read())

    def test_execute_config_set_planner_model_creates_key(self):
        self._write_config()
        self._gitify()
        r = dashboard.execute_config_set(self.repo, "agent.planner.model",
                                         "claude-opus-4-8")
        self.assertTrue(r["ok"], r)
        self.assertIn("planner:", open(self._live()).read())

    def test_client_disconnects_are_benign(self):
        for exc in (ConnectionResetError(), BrokenPipeError(),
                    ConnectionAbortedError(), TimeoutError()):
            self.assertTrue(dashboard._is_benign_disconnect(exc),
                            "%r should be benign" % exc)

    def test_real_errors_are_not_benign(self):
        for exc in (ValueError("boom"), KeyError("x"), RuntimeError(),
                    OSError("disk full")):
            self.assertFalse(dashboard._is_benign_disconnect(exc),
                             "%r should NOT be swallowed" % exc)

    def test_quiet_server_swallows_benign_only(self):
        # handle_error must return None (swallow) for a benign disconnect and
        # delegate (raise/print) for a real one. Drive it via a fake exc state.
        srv = dashboard._QuietThreadingHTTPServer.__new__(
            dashboard._QuietThreadingHTTPServer)
        try:
            raise ConnectionResetError()
        except ConnectionResetError:
            self.assertIsNone(srv.handle_error(None, ("127.0.0.1", 0)))


class TestPageTemplating(unittest.TestCase):
    def test_page_bytes_fills_all_placeholders(self):
        # the served page must leave no build-time placeholder behind: an
        # unreplaced __MODEL_CHOICES__ is invalid JS (the picker breaks).
        html = dashboard._page_bytes(dashboard.PAGE)
        self.assertNotIn(b"__MODEL_CHOICES__", html)
        self.assertNotIn(b"__CONTROL_TOKEN__", html)

    def test_model_choices_are_single_sourced_from_accounts(self):
        # the injected roster IS accounts.subscription_models("claude_
        # subscription") -- the dashboard derives its MODEL_CHOICES from the
        # accounts curated source, so the two surfaces cannot drift (#134).
        html = dashboard._page_bytes(dashboard.PAGE)
        roster = accounts.subscription_models("claude_subscription")
        injected = ("const MODEL_CHOICES=" + json.dumps(roster) + ";").encode()
        self.assertIn(injected, html)
        self.assertIn(b'"claude-opus-4-8"', html)

    def test_config_page_templates_without_error(self):
        # /config leaves no build-time placeholder behind and still serves.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE)
        self.assertNotIn(b"__CONTROL_TOKEN__", html)
        self.assertNotIn(b"__MODEL_CHOICES__", html)

    def test_pipeline_page_templates_without_error(self):
        # P3b (#365): the editor page now carries both placeholders (Save posts
        # a token; runs_as picks a model). The served page must leave neither
        # behind -- an unreplaced __MODEL_CHOICES__ is invalid JS.
        html = dashboard._page_bytes(dashboard.PIPELINE_PAGE)
        self.assertNotIn(b"__CONTROL_TOKEN__", html)
        self.assertNotIn(b"__MODEL_CHOICES__", html)
        roster = accounts.subscription_models("claude_subscription")
        injected = ("const MODEL_CHOICES=" + json.dumps(roster) + ";").encode()
        self.assertIn(injected, html)

    def test_config_page_model_roster_single_sourced(self):
        # the config page's model-field datalist is filled from the SAME
        # accounts curated roster the main page uses (#82 builds on #134), so
        # the authoring picker and the runtime override picker cannot drift.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE)
        roster = accounts.subscription_models("claude_subscription")
        injected = ("const MODEL_CHOICES=" + json.dumps(roster) + ";").encode()
        self.assertIn(injected, html)
        self.assertIn(b'"claude-opus-4-8"', html)

    def test_config_model_field_is_select_with_custom_escape(self):
        # #273: the config page's model fields must be REAL <select> pickers,
        # not free-text datalist inputs (Safari renders a datalist as a bare text
        # box, so it read as hard-typing). The build-time source is asserted here;
        # runtime behaviour is covered by the dashboard browser-verify loop.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE)
        # the model field builds a <select> tagged cfgmodel...
        self.assertIn(b'class="cfgin cfgmodel"', html)
        # ...with a custom... escape hatch (BYO-LLM / local ids stay free-text, #78)
        self.assertIn(b'__custom__', html)
        self.assertIn(b'cfgcustom', html)
        # ...and the old datalist-backed text input for models is gone.
        self.assertNotIn(b'<input class="cfgin" list="cfg-models"', html)


class TestControlRoomShell(unittest.TestCase):
    """UI-1 (#184): the control-room skin + shell. The reskin restructures the
    page into a full-viewport three-zone grid with an icon top bar, killing the
    grid background / accent stripes / max-width cage -- but it must NOT drop any
    render mount point, or the JS silently stops populating a panel. These assert
    the render contract survives the reskin (and future ones)."""

    # every id the page's render functions write into (render() in the page
    # script) -- dropping one silently breaks that panel.
    MOUNTS = [
        b'id="focus"', b'id="repos"', b'id="quota"',
        b'id="activity"', b'id="tp"', b'id="handoffs"', b'id="needsyou"', b'id="voice"',
        b'id="git"', b'id="toast"',
        # header/live stats the tickers + render update every second/tick
        b'id="h-repos"', b'id="h-active"', b'id="h-fresh"', b'id="h-clock"',
        b'id="h-live"', b'id="h-live-t"', b'id="h-update"',
        # activity view tabs (setView) must stay wired
        b'id="v-tree"', b'id="v-time"', b'id="v-flat"',
    ]

    def test_all_render_mounts_present(self):
        html = dashboard._page_bytes(dashboard.PAGE)
        for m in self.MOUNTS:
            self.assertIn(m, html, "reskin dropped render mount %r" % m)

    def test_three_zone_shell_and_top_bar(self):
        # the new shell: a full-viewport three-zone grid under an icon top bar.
        html = dashboard._page_bytes(dashboard.PAGE)
        self.assertIn(b'class="shell"', html)
        self.assertIn(b'class="top"', html)

    def test_killed_grid_stripes_and_cage(self):
        # operator's explicit kills: the grid background texture and the
        # max-width cage (page now runs full-bleed, one viewport).
        html = dashboard._page_bytes(dashboard.PAGE)
        self.assertNotIn(b"max-width:1640px", html)
        self.assertNotIn(b"background-image:linear-gradient(var(--grid)", html)

    def test_focus_card_uses_detail_header(self):
        # #269 UI-3c: the selected-lane focus card renders the dense detail header
        # (dh1 identity row + ticketline + dh2 stat strip), not the legacy fcard
        # top/ticket/meta rows. Build-time guard against an accidental revert;
        # runtime behaviour is covered by the dashboard browser-verify loop.
        html = dashboard._page_bytes(dashboard.PAGE)
        self.assertIn(b'class="dh1"', html)
        self.assertIn(b'class="ticketline"', html)
        self.assertIn(b'class="dh2"', html)
        # the retired legacy fcard rows are gone from the render source.
        self.assertNotIn(b'class="fc-top"', html)
        self.assertNotIn(b'class="fc-ticket"', html)


class TestCompareTiles(unittest.TestCase):
    """#190 UI-7: pin 2+ lanes -> the center renders a compare-tile grid.
    Structural build-time guards on the page source; runtime behaviour
    (pin toggle, grid swap, drill-back, signature-guard stability) is the
    dashboard browser verify loop. Marker-based on purpose -- no byte-window
    slicing (a fixed html[i:j] breaks on innocent growth)."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_pin_primitive_present(self):
        # client-only pin state (ephemeral Set, laneKey contract) + toggle.
        html = self._page()
        self.assertIn(b"PINNED", html)
        self.assertIn(b"function togglePin(", html)
        # the pin key travels in the onclick arg (encAttr -> decodeURIComponent,
        # the shipped ibtn/control round-trip) -- no dead data-* duplicate.
        self.assertIn(b"onclick=\"togglePin(", html)
        self.assertIn(b"pinbtn", html)

    def test_tile_grid_render_path(self):
        # renderFocus branches to the tile grid; tiles reuse the shipped
        # phase-track markup (.ptrack/.pseg) rather than a new track renderer;
        # vanished repos/lanes are pruned (validPins) and a tile click drills
        # back to the single view (drillTo).
        html = self._page()
        self.assertIn(b"function tileCard(", html)
        self.assertIn(b"tilegrid", html)
        self.assertIn(b"function validPins(", html)
        self.assertIn(b"function drillTo(", html)

    def test_pace_flag_is_earned(self):
        # pace flag only from >=3 completed same-role durations (median) --
        # the "never imply certainty" acceptance test applied to pace.
        html = self._page()
        self.assertIn(b"function paceFlag(", html)
        self.assertIn(b"ds.length<3", html)

    def test_tile_css_defined(self):
        html = self._page()
        self.assertIn(b".tilegrid", html)
        self.assertIn(b".tile", html)
        self.assertIn(b".pinbtn", html)

    def test_pace_ratio_in_volatile_normalization(self):
        # the live pace ratio drifts every second; it must sit inside the
        # shared _volRe normalization or the grid rebuilds on every tick
        # (prevention-log #13/#14 class; Codex CP1 finding).
        html = self._page()
        self.assertIn(b"qreset|agox|upe|pacex", html)
        self.assertIn(b'class="pacex"', html)

    def test_tile_degrades_malformed_track_and_ticket(self):
        # source-level guards: non-array track -> no track (never a map/find
        # throw); absent ticket number -> omitted, never "#undefined".
        html = self._page()
        self.assertIn(b"Array.isArray(ft.track)", html)
        self.assertIn(b"ft.number!=null", html)

    def test_ptrack_render_is_shared_helper(self):
        # ONE honest track renderer (SD-32): the focus card and the compare
        # tiles both draw via renderPtrack, so the tiles inherit the #312
        # tests-verdict/empty semantics and the two can never drift. The
        # ptrack container template exists exactly once in the page source.
        html = self._page()
        self.assertIn(b"function renderPtrack(", html)
        self.assertEqual(html.count(b'class="ptrack"'), 1)
        # the helper itself guards a malformed track (total render).
        self.assertIn(b"if(!Array.isArray(trk)||!trk.length)", html)

    def test_sibling_lane_tile_is_reduced(self):
        # CP2: a sibling lane's tile must not borrow the repo-level session /
        # ticket / track (they belong to the active lane) -- it renders the
        # service truth + an explicit no-data note and returns early.
        html = self._page()
        self.assertIn(b"if(sibSt){", html)
        self.assertIn(b"no lane-scoped session data", html)

    def test_pace_ratio_is_ticked_not_frozen(self):
        # CP2: pacex is normalized OUT of the #focus signature, so the 1s
        # ticker must own its motion (data-e/data-med) -- otherwise the earned
        # ratio freezes at first render until an unrelated rebuild.
        html = self._page()
        self.assertIn(b'querySelectorAll(".pacex")', html)
        self.assertIn(b'data-med=', html)


class TestRosterCountdownStability(unittest.TestCase):
    """#238 (p1 regression): seconds-granularity countdowns embedded in the roster
    markup defeated the #164 skip-unchanged compare -- the string differed every
    second, so the whole roster innerHTML rebuilt every SSE push and variable-width
    time text reshaped the rows. The fix: minute-granularity roster times (opt-in
    via data-g="m"), a compare that normalizes the volatile .qreset/.agox span
    contents out before comparing, and width-reserved time cells. These pin the
    fix's structure; the behavioral acceptance (zero roster rebuilds over a
    no-change window) is the browser verify loop (#239)."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_minute_granularity_helpers_defined(self):
        # the roster uses minute-granularity siblings of dur()/ago() so the
        # embedded + ticked countdown is `next 32m`, not `next 32m16s`.
        html = self._page()
        self.assertIn(b"function durm(", html)
        self.assertIn(b"function agom(", html)

    def test_roster_time_spans_opt_into_minute_granularity(self):
        # both roster time spans (cron next-fire countdown, last-run age) carry
        # data-g="m" so the shared 1s ticker formats them at minute granularity;
        # non-roster spans have no data-g and keep their seconds countdowns.
        html = self._page()
        self.assertIn(b'data-g="m"', html)

    def test_ticker_branches_on_granularity(self):
        # the shared ticker must special-case data-g="m" spans (durm/agom, and no
        # appended " ago" for the roster agox whose " ago" is static in markup),
        # while the fallback path stays EXACTLY today's behavior.
        html = self._page()
        self.assertIn(b'dataset.g', html)

    def test_roster_compare_normalizes_volatile_time(self):
        # the skip-unchanged compare strips .qreset/.agox contents before
        # comparing, so a pure time tick never rebuilds the roster innerHTML.
        # The naive full-string compare (html!==_reposHtml) must be gone.
        html = self._page()
        self.assertIn(b"(?:qreset|agox)", html)
        self.assertNotIn(b"html!==_reposHtml", html)

    def test_roster_time_cells_reserve_width(self):
        # tabular-nums + a reserved min-width so a ticking/format-length change
        # can never reshape the row (part 3 of the fix).
        html = self._page()
        self.assertIn(b".role .trig .qreset", html)
        self.assertIn(b".role .rlast .agox", html)
        self.assertIn(b"min-width", html)


class TestUpdateChipPerComponent(unittest.TestCase):
    """#240 (p1): the #196 update chip fired on aggregate `engine.stale` with one
    'restart to apply' call-to-action + the aggregate commit count -- so a
    fully-current dashboard still demanded a restart whenever any supervisor was
    behind, and an unknown-sha supervisor borrowed the aggregate count. The fix is
    render-only (engine_status already exposes per-component truth): the dashboard
    (the shell the operator restarts) gets the warning 'pull + restart' CTA; a
    dashboard-current / supervisor-behind state is informational ('refresh at next
    session boundary'); unknown-sha reads 'version unknown', never a borrowed
    count. These pin the render's structure; per-scenario DOM output is the browser
    verify loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_restart_wording_requires_pull(self):
        # until auto-pull lands (#166) a bare restart applies nothing -- the CTA
        # must say "pull + restart", not "restart".
        html = self._page()
        self.assertIn(b"pull + restart", html)

    def test_dashboard_vs_supervisor_messaging_split(self):
        # per-component: the dashboard CTA is distinct from the supervisor-only
        # informational message (no shared 'engine updated ... restart' for both).
        html = self._page()
        self.assertIn(b"dashboard outdated", html)
        self.assertIn(b"session boundary", html)

    def test_unknown_sha_not_a_borrowed_count(self):
        # a pre-tracking supervisor (sha:"") reads 'version unknown', never the
        # aggregate commit count.
        html = self._page()
        self.assertIn(b"version unknown", html)

    def test_informational_tone_class_present(self):
        # the supervisor-only state uses a muted informational class, not the
        # warning-styled chip, so it doesn't read as an alarm.
        html = self._page()
        self.assertIn(b".updchip.info", html)


class TestConciergeAccountSelection(unittest.TestCase):
    """The concierge's local-account selection rule (#137). An explicit
    AUTONOMY_CONCIERGE_ACCOUNT preference wins; unset keeps the deterministic
    registry-first default; a set-but-unmatched preference is a visible error,
    never a silent fall back to a different endpoint (fail-safe)."""

    def test_unset_preference_uses_registry_first(self):
        self.assertEqual(
            dashboard._pick_concierge_account(["ollama", "lmstudio"], None),
            "ollama")
        self.assertEqual(
            dashboard._pick_concierge_account(["ollama", "lmstudio"], ""),
            "ollama")
        # whitespace-only preference is treated as unset
        self.assertEqual(
            dashboard._pick_concierge_account(["ollama", "lmstudio"], "  "),
            "ollama")

    def test_matching_preference_wins_over_registry_order(self):
        self.assertEqual(
            dashboard._pick_concierge_account(["ollama", "lmstudio"],
                                              "lmstudio"),
            "lmstudio")
        # surrounding whitespace is tolerated
        self.assertEqual(
            dashboard._pick_concierge_account(["ollama", "lmstudio"],
                                              " lmstudio "),
            "lmstudio")

    def test_unmatched_preference_raises_not_silent_fallback(self):
        with self.assertRaises(ValueError) as ctx:
            dashboard._pick_concierge_account(["ollama"], "does-not-exist")
        msg = str(ctx.exception)
        self.assertIn("does-not-exist", msg)
        self.assertIn("ollama", msg)  # lists what IS available

    def test_no_local_accounts_raises(self):
        with self.assertRaises(ValueError) as ctx:
            dashboard._pick_concierge_account([], None)
        self.assertIn("openai_compatible", str(ctx.exception))
        # a preference set with no accounts at all still refuses
        with self.assertRaises(ValueError):
            dashboard._pick_concierge_account([], "ollama")


class TestBoardList(unittest.TestCase):
    """The best-effort Projects v2 board enumerator behind the config page's
    board picker (#170). Mirrors the engine's best-effort periphery posture
    (settled-decision 6): any gh failure yields an empty list + error, NEVER an
    invented board (fail-safe, never fail-open). The user-supplied owner is
    re-validated before it reaches gh argv (prevention log 6)."""

    def setUp(self):
        # deterministic: never let a prior case's cache leak into this one.
        dashboard._board_cache.clear()
        self._orig_run = dashboard._run

    def tearDown(self):
        dashboard._run = self._orig_run
        dashboard._board_cache.clear()

    _GOOD = json.dumps({"projects": [
        {"title": "Autonomy Progress", "closed": False},
        {"title": "eBull engineering board", "closed": False},
        {"title": "Archived thing", "closed": True},
    ]})

    def test_titles_extracted_open_only(self):
        calls = []
        dashboard._run = lambda args, **kw: calls.append(args) or self._GOOD
        out = dashboard.board_list("Luke-Bradford")
        self.assertEqual(out["boards"],
                         ["Autonomy Progress", "eBull engineering board"])
        self.assertIsNone(out["error"])
        # the owner reached gh argv exactly (not shell), with a bounded limit.
        self.assertIn("--owner", calls[0])
        self.assertIn("Luke-Bradford", calls[0])
        self.assertIn("--limit", calls[0])

    def test_gh_failure_is_empty_never_invents(self):
        dashboard._run = lambda args, **kw: None   # gh failed/timed out
        out = dashboard.board_list("Luke-Bradford")
        self.assertEqual(out["boards"], [])
        self.assertTrue(out["error"])   # a reason is surfaced, not faked-empty

    def test_invalid_owner_never_calls_gh(self):
        called = {"n": 0}
        dashboard._run = lambda *a, **kw: called.__setitem__("n", called["n"] + 1)
        for bad in ("", "  ", "-rf", "a b", "user_name", "a.b", "x;y"):
            out = dashboard.board_list(bad)
            self.assertEqual(out["boards"], [], bad)
            self.assertTrue(out["error"], bad)
        self.assertEqual(called["n"], 0, "gh must not run for an invalid owner")

    def test_malformed_json_degrades(self):
        dashboard._run = lambda args, **kw: "{not json"
        out = dashboard.board_list("Luke-Bradford")
        self.assertEqual(out["boards"], [])
        self.assertTrue(out["error"])

    def test_titles_filtered_to_save_contract(self):
        # a board whose title the config-save contract (dcx._valid_text) would
        # reject must NOT be suggested -- else the picker offers an unsavable
        # value. Here: a title holding BOTH quote kinds.
        bad_title = "he said \"hi\" it's fine"
        payload = json.dumps({"projects": [
            {"title": "OK Board", "closed": False},
            {"title": bad_title, "closed": False},
        ]})
        dashboard._run = lambda args, **kw: payload
        out = dashboard.board_list("Luke-Bradford")
        self.assertEqual(out["boards"], ["OK Board"])

    def test_cache_avoids_repeat_gh(self):
        calls = []
        dashboard._run = lambda args, **kw: calls.append(1) or self._GOOD
        dashboard.board_list("Luke-Bradford")
        dashboard.board_list("Luke-Bradford")
        self.assertEqual(len(calls), 1, "second call within TTL must be cached")

    def test_cache_is_bounded(self):
        # a long-lived process must not grow _board_cache without bound as
        # distinct owners are queried (review NITPICK). Feed more distinct
        # owners than the cap and assert the dict stays bounded.
        dashboard._run = lambda args, **kw: self._GOOD
        for n in range(dashboard._BOARD_CACHE_MAX + 20):
            dashboard.board_list("owner%d" % n)
        self.assertLessEqual(len(dashboard._board_cache),
                             dashboard._BOARD_CACHE_MAX)


class TestBoardsRoute(unittest.TestCase):
    def test_api_boards_routes_to_board_list(self):
        # GET /api/boards?owner=<o> returns 200 with the board_list payload,
        # bytes-encoded like the other JSON routes (Content-Length needs bytes).
        h = dashboard.Handler.__new__(dashboard.Handler)
        h.path = "/api/boards?owner=Luke-Bradford"
        captured = {}
        h._send = lambda code, body, ctype="application/json": captured.update(
            code=code, body=body)
        dashboard._board_cache.clear()
        orig_run = dashboard._run
        dashboard._run = lambda args, **kw: TestBoardList._GOOD
        try:
            h.do_GET()
        finally:
            dashboard._run = orig_run
            dashboard._board_cache.clear()
        self.assertEqual(captured["code"], 200)
        self.assertIsInstance(captured["body"], (bytes, bytearray))
        payload = json.loads(captured["body"].decode("utf-8"))
        self.assertEqual(payload["boards"][0], "Autonomy Progress")


class _FakeAccts:
    """A stand-in for accounts.Accounts with a known registry + discover_models --
    lets models_read_model be driven without a real account index / network. Its
    discover_models mirrors the real source dispatch (#206): claude_subscription
    is "live" when a live roster is supplied, else "curated"; openai_compatible is
    "live"; api/unknown is "none" (and is NOT consulted, so setting models_raises
    for such a kind still yields none without blowing up)."""

    def __init__(self, registry, models=None, list_raises=None,
                 models_raises=None, live=None, labels=None):
        self._registry = registry          # list of {name, kind}
        self._models = models or {}        # name -> curated/openai [model ids]
        self._live = live or {}            # name -> live [model ids] (claude_sub)
        self._labels = labels or {}        # name -> {id: display_name} (#206)
        self._list_raises = list_raises    # exc to raise from list()
        self._models_raises = models_raises  # name whose discover_models raises

    def list(self):
        if self._list_raises is not None:
            raise self._list_raises
        return list(self._registry)

    def _kind(self, name):
        return next((a.get("kind") for a in self._registry
                     if a.get("name") == name), None)

    def discover_models(self, name):
        kind = self._kind(name)
        labels = dict(self._labels.get(name, {}))
        if kind == "claude_subscription":
            if name == self._models_raises:
                raise RuntimeError("boom in discover_models(%s)" % name)
            live = self._live.get(name)
            if live:
                return {"source": "live", "models": list(live), "labels": labels}
            return {"source": "curated",
                    "models": list(self._models.get(name, [])), "labels": {}}
        src = accounts.model_source(kind)
        if src == "none":
            # not consulted; never raises
            return {"source": "none", "models": [], "labels": {}}
        if name == self._models_raises:
            raise RuntimeError("boom in discover_models(%s)" % name)
        return {"source": src, "models": list(self._models.get(name, [])),
                "labels": labels}


class TestModelsReadModel(unittest.TestCase):
    """/api/models read model (#82): per-account discovered models for the
    config picker, sourced from accounts.model_source + Accounts.list_models.
    Best-effort + fail-safe -- a registry fault yields accounts=[] + error,
    never a 500 and never a leaked partial list (never fail-open)."""

    def setUp(self):
        self._saved = dashboard._accts_singleton[0]

    def tearDown(self):
        dashboard._accts_singleton[0] = self._saved

    def _install(self, fake):
        dashboard._accts_singleton[0] = fake

    def test_openai_compatible_is_live_source(self):
        self._install(_FakeAccts(
            [{"name": "ollama", "kind": "openai_compatible"}],
            models={"ollama": ["qwen3:14b", "deepseek-r1:14b"]}))
        out = dashboard.models_read_model()
        self.assertIsNone(out["error"])
        self.assertEqual(out["accounts"], [
            {"name": "ollama", "kind": "openai_compatible", "source": "live",
             "models": ["qwen3:14b", "deepseek-r1:14b"], "labels": {}}])

    def test_subscription_curated_when_live_absent(self):
        self._install(_FakeAccts(
            [{"name": "sub", "kind": "claude_subscription"}],
            models={"sub": ["claude-opus-4-8"]}))
        out = dashboard.models_read_model()
        acct = out["accounts"][0]
        self.assertEqual(acct["source"], "curated")
        self.assertEqual(acct["models"], ["claude-opus-4-8"])

    def test_subscription_live_source_when_roster_present(self):
        # #206: when the live /v1/models roster comes back, source is "live".
        self._install(_FakeAccts(
            [{"name": "sub", "kind": "claude_subscription"}],
            models={"sub": ["claude-opus-4-8"]},
            live={"sub": ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]}))
        out = dashboard.models_read_model()
        acct = out["accounts"][0]
        self.assertEqual(acct["source"], "live")
        self.assertEqual(acct["models"],
                         ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"])

    def test_subscription_live_labels_flow_through(self):
        # #206 follow-up: display_name labels ride the /api/models payload so the
        # config picker can show a human name next to each model id.
        self._install(_FakeAccts(
            [{"name": "sub", "kind": "claude_subscription"}],
            live={"sub": ["claude-fable-5", "claude-opus-4-8"]},
            labels={"sub": {"claude-fable-5": "Claude Fable 5",
                            "claude-opus-4-8": "Claude Opus 4.8"}}))
        out = dashboard.models_read_model()
        acct = out["accounts"][0]
        self.assertEqual(acct["source"], "live")
        self.assertEqual(acct["labels"], {"claude-fable-5": "Claude Fable 5",
                                          "claude-opus-4-8": "Claude Opus 4.8"})

    def test_api_kind_is_none_source_and_skips_lookup(self):
        # a 'none'-source kind must NOT consult list_models at all; if it did,
        # this fake would raise (models_raises) and the test would fail.
        self._install(_FakeAccts(
            [{"name": "key", "kind": "anthropic_api"}],
            models_raises="key"))
        out = dashboard.models_read_model()
        self.assertEqual(out["accounts"], [
            {"name": "key", "kind": "anthropic_api", "source": "none",
             "models": [], "labels": {}}])

    def test_registry_failure_is_fail_safe(self):
        self._install(_FakeAccts([], list_raises=RuntimeError("gh down")))
        out = dashboard.models_read_model()
        self.assertEqual(out["accounts"], [])
        self.assertIn("gh down", out["error"])

    def test_partial_failure_discards_the_partial_list(self):
        # first account resolves, the second raises mid-loop -> the whole read
        # is discarded (accounts==[]). Never leak a partial list (fail-open).
        self._install(_FakeAccts(
            [{"name": "ollama", "kind": "openai_compatible"},
             {"name": "broken", "kind": "openai_compatible"}],
            models={"ollama": ["qwen3:14b"]},
            models_raises="broken"))
        out = dashboard.models_read_model()
        self.assertEqual(out["accounts"], [])
        self.assertIsNotNone(out["error"])


class TestRepoOwnerDefault(unittest.TestCase):
    """The best-effort board.owner derivation behind the config page's derived
    default (#171). Mirrors the engine's best-effort periphery (settled-decision
    6): any gh/validation failure yields "" -- never a fabricated owner. The
    login gh returns is re-validated against the GitHub grammar before it is
    surfaced (prevention log 6). Never raises; cached briefly per repo."""

    def setUp(self):
        # defensive: on the red run the cache attr does not exist yet, so the
        # test must fail on the MISSING FUNCTION, not on clearing a missing dict.
        if hasattr(dashboard, "_owner_cache"):
            dashboard._owner_cache.clear()
        self._orig_run = dashboard._run

    def tearDown(self):
        dashboard._run = self._orig_run
        if hasattr(dashboard, "_owner_cache"):
            dashboard._owner_cache.clear()

    def test_valid_login_returned(self):
        calls = []
        dashboard._run = lambda args, **kw: calls.append((args, kw)) or "Luke-Bradford\n"
        self.assertEqual(dashboard.repo_owner_default("/r"), "Luke-Bradford")
        # gh queried the repo's own remote (cwd=repo), not a global lookup.
        self.assertIn("repo", calls[0][0])
        self.assertEqual(calls[0][1].get("cwd"), "/r")

    def test_gh_failure_yields_empty(self):
        dashboard._run = lambda args, **kw: None   # gh failed/timed out
        self.assertEqual(dashboard.repo_owner_default("/r"), "")

    def test_grammar_reject_yields_empty(self):
        # a login that fails the GitHub grammar is never surfaced (prevention 6):
        # leading/trailing/consecutive hyphens, over-length, and non-login chars.
        for bad in ("-bad", "a b", "user_name", "a.b", "x;y", "--flag",
                    "Acme-", "a--b", "a" * 40):
            dashboard._owner_cache.clear()
            dashboard._run = lambda args, **kw: bad + "\n"
            self.assertEqual(dashboard.repo_owner_default("/r"), "", bad)

    def test_never_raises_on_run_exception(self):
        def boom(*a, **kw):
            raise RuntimeError("gh blew up")
        dashboard._run = boom
        self.assertEqual(dashboard.repo_owner_default("/r"), "")

    def test_blank_repo_yields_empty_no_gh(self):
        called = {"n": 0}
        dashboard._run = lambda *a, **kw: called.__setitem__("n", called["n"] + 1)
        self.assertEqual(dashboard.repo_owner_default(""), "")
        self.assertEqual(dashboard.repo_owner_default("   "), "")
        self.assertEqual(called["n"], 0, "gh must not run for a blank repo")

    def test_cached_second_call_skips_gh(self):
        calls = []
        dashboard._run = lambda args, **kw: calls.append(1) or "Acme\n"
        dashboard.repo_owner_default("/r")
        dashboard.repo_owner_default("/r")
        self.assertEqual(len(calls), 1, "second call within TTL must be cached")

    def test_cache_is_bounded(self):
        dashboard._run = lambda args, **kw: "Acme\n"
        for i in range(dashboard._OWNER_CACHE_MAX + 20):
            dashboard.repo_owner_default("/r%d" % i)
        self.assertLessEqual(len(dashboard._owner_cache),
                             dashboard._OWNER_CACHE_MAX)


class TestConfigReadModelOwnerDerived(unittest.TestCase):
    """config_read_model() carries a best-effort board_owner_derived per repo so
    the config page can offer it as a default. A derivation failure must be ""
    and non-fatal -- the page still renders (#171)."""

    def setUp(self):
        if hasattr(dashboard, "_owner_cache"):
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
        if hasattr(dashboard, "_owner_cache"):
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

    def test_multi_repo_owners_mapped_concurrently(self):
        # owners are derived concurrently (not blocking N x gh); each repo's
        # derived owner must still land on the right repo. A cwd-sensitive run
        # returns a distinct login per repo path.
        td2 = tempfile.TemporaryDirectory()
        self.addCleanup(td2.cleanup)
        os.makedirs(os.path.join(td2.name, ".autonomy"))
        with open(os.path.join(td2.name, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("board:\n  owner: \"\"\n")
        repo_a, repo_b = self._td.name, td2.name
        dashboard.Handler.repos = [repo_a, repo_b]
        dashboard._run = lambda args, **kw: (
            "Owner-A\n" if kw.get("cwd") == repo_a else "Owner-B\n")
        by_path = {r["path"]: r["board_owner_derived"]
                   for r in dashboard.config_read_model()["repos"]}
        self.assertEqual(by_path[repo_a], "Owner-A")
        self.assertEqual(by_path[repo_b], "Owner-B")


class TestConfigPageUi1Parity(unittest.TestCase):
    """#191: the config page adopts the UI-1 token system from dashboard_page.html
    (#184). The two pages already share the same token variable NAMES; this reskin
    re-points the VALUES, drops the Google-webfont dependency + grid texture, and
    aligns the theme resolver -- so /config and / render as one skin and cannot
    drift. Parity is asserted value-for-value. The shared `ae-theme` localStorage
    key can hold 'system' (the dashboard's dark/light/system cycle), which the
    config page must resolve to dark|light rather than applying raw and blanking
    every token (Codex CP1 [High])."""

    _BLOCK_SELECTORS = (":root", ':root[data-theme="dark"]',
                        ':root[data-theme="light"]')

    def _token_blocks(self, page):
        # selector -> list of brace-body strings. `:root` is matched only when a
        # `{` follows (optionally after whitespace), so it never captures the
        # bracketed `:root[data-theme=...]` variants.
        text = dashboard._page_bytes(page).decode("utf-8")
        out = {}
        for sel in self._BLOCK_SELECTORS:
            out[sel] = re.findall(re.escape(sel) + r"\s*\{([^}]*)\}", text)
        return out

    @staticmethod
    def _decls(body):
        # compare declarations only: strip comments, split on ';', normalize ws.
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        return sorted(d.strip() for d in body.split(";") if d.strip())

    def test_config_page_no_webfont_dependency(self):
        # UI-1 uses macOS-present system fonts -- "no webfont gamble" (spec). No
        # <link>, no @import, no gstatic preconnect may remain.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE)
        for needle in (b"fonts.googleapis", b"fonts.gstatic", b"@import"):
            self.assertNotIn(
                needle, html,
                "config page still pulls a webfont (%r); UI-1 is system-font only"
                % needle)

    def test_config_page_uses_ui1_tokens(self):
        # canonical dark-theme values from dashboard_page.html (UI-1 #184).
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE).decode("utf-8")
        self.assertIn("--bg:#15181d", html)
        self.assertIn("--accent:#4c9ee3", html)
        self.assertIn("--grid:transparent", html)   # no grid texture (spec)
        self.assertIn('"Avenir Next"', html)
        self.assertIn("--r:6px", html)

    def test_token_blocks_match_dashboard_value_for_value(self):
        cfg = self._token_blocks(dashboard.CONFIG_PAGE)
        dash = self._token_blocks(dashboard.PAGE)
        for sel in self._BLOCK_SELECTORS:
            # Codex CP1/CP2 [Med]: exactly one block per selector on BOTH pages,
            # else a later duplicate could win the cascade while this test still
            # compares against the first block and passes.
            self.assertEqual(
                len(cfg[sel]), 1,
                "config page has %d %s token blocks, want exactly 1"
                % (len(cfg[sel]), sel))
            self.assertEqual(
                len(dash[sel]), 1,
                "dashboard page has %d %s token blocks, want exactly 1"
                % (len(dash[sel]), sel))
            self.assertEqual(
                self._decls(cfg[sel][0]), self._decls(dash[sel][0]),
                "config %s tokens diverge from UI-1 dashboard_page.html" % sel)

    def test_config_theme_resolves_system(self):
        # Codex CP1 [High]: the shared ae-theme key can hold 'system' (dashboard
        # cycle). The config page must resolve system->dark|light via matchMedia,
        # never set a raw data-theme="system" that matches no token block.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE).decode("utf-8")
        self.assertIn("prefers-color-scheme", html)
        # Codex CP2 [Med]: pin that data-theme is set to the RESOLVED value, not
        # the raw stored choice -- a substring check for `_effTheme` alone would
        # false-pass even if setAttribute still applied a raw "system".
        self.assertIn('setAttribute("data-theme",_effTheme(', html)
        # and that unknown values are coerced rather than applied verbatim.
        self.assertIn('["dark","light","system"].indexOf(t)<0', html)


class TestAccountUsageForecast(unittest.TestCase):
    """#188b: the live-quota assembly (_account_usage) threads each live window's
    burn-rate forecast onto the window -- so the quota card's dynamically-selected
    window carries it -- WITHOUT mutating cu.live_quota()'s shared cache dict, and
    still fails closed (claude=None) when the live read raises."""

    def setUp(self):
        # force a cache miss so each call actually re-assembles usage.
        dashboard._acct_cache[0] = 0.0
        dashboard._acct_cache[1] = None

    def _neutralise_other_sources(self):
        # only the live claude path matters here; stub the other two usage sources.
        return (
            mock.patch.object(dashboard.ds, "account_usage",
                              lambda *a, **k: {"five_hour": {}, "seven_day": {}}),
            mock.patch.object(dashboard.ds, "codex_usage",
                              lambda *a, **k: {"available": False}),
        )

    def test_live_windows_carry_forecast_and_shared_cache_not_mutated(self):
        now = int(time.time())
        shared = {"five_hour": {"utilization": 0.5, "resets_at": now + 3600},
                  "seven_day": {"utilization": 0.5, "resets_at": now + 3600},
                  "source": "live"}
        b1, b2 = self._neutralise_other_sources()
        with b1, b2, mock.patch.object(dashboard.cu, "live_quota", lambda *a, **k: shared):
            usage = dashboard._account_usage()
        self.assertIn("forecast", usage["claude"]["five_hour"])
        self.assertEqual(usage["claude"]["source"], "live")
        # the shared cache dict cu.live_quota returned must be untouched.
        self.assertNotIn("forecast", shared["five_hour"])

    def test_live_read_exception_fails_closed_to_none(self):
        def boom(*a, **k):
            raise RuntimeError("live read failed")
        b1, b2 = self._neutralise_other_sources()
        with b1, b2, mock.patch.object(dashboard.cu, "live_quota", boom):
            usage = dashboard._account_usage()
        self.assertIsNone(usage["claude"])


class TestFleetRailLifecycleCluster(unittest.TestCase):
    """#258 slice 2a: the redesign moves per-repo lifecycle controls off the
    center NOW cards onto the fleet-rail repo header as a compact icon-button
    cluster (the mockup's `.ibtn` cluster), so controls stay reachable for EVERY
    repo once slice 2b collapses the center to the selected lane. This slice is
    additive -- the center cards keep their controls this PR. These assertions
    pin the render structure + wiring; the behavioral acceptance (buttons render
    per status, a click POSTs /api/control without changing the lane selection)
    is the dashboard browser verify loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def _cluster_body(self, html):
        # slice the ibtn() helper + lifecycleCluster() function bodies so the
        # wiring assertions are scoped to them (not incidental control() calls
        # elsewhere on the page). The two are adjacent; ibtn() emits the
        # control() onclick, lifecycleCluster() supplies the action ladder.
        i = html.find(b"function ibtn(repo,action")
        self.assertNotEqual(i, -1, "ibtn() lifecycle helper is not defined")
        j = html.find(b"function lifecycleCluster(", i)
        self.assertNotEqual(j, -1, "lifecycleCluster() is not defined")
        # structural end (the CONFIRM map follows the cluster helpers), not a
        # fixed byte window -- a fixed j+900 broke on innocent comment growth
        # (#147 lane params), the same trap the prior lifecycleCluster window
        # test fell into (memory: fixed-byte-window tests break on growth).
        k = html.find(b"const CONFIRM", j)
        self.assertNotEqual(k, -1, "CONFIRM map is not defined after the cluster")
        return html[i:k]

    def test_lifecycle_cluster_defined(self):
        self.assertIn(b"function lifecycleCluster(", self._page())

    def test_cluster_wires_all_four_lifecycle_actions_via_control(self):
        # reuses the EXISTING control(repo,action,label) endpoint -- no new
        # action string, no new endpoint. The full status ladder is offered:
        # pause + stop (working/idle), resume + stop (paused/stopping), start
        # (stopped). (CP1 finding 1: these are the ACTION strings; graceful-stop
        # is only a label.)
        body = self._cluster_body(self._page())
        for action in (b'"pause"', b'"resume"', b'"stop"', b'"start"'):
            self.assertIn(action, body, "cluster missing control action %r" % action)
        # reuses the existing control() endpoint (emitted by the ibtn helper),
        # not a bespoke fetch.
        self.assertIn(b"control(", body)
        self.assertIn(b"ibtn", body)

    def test_cluster_rendered_in_repo_header(self):
        # the cluster is emitted inside renderRepos' repo header markup (not the
        # center focus card) -- so it must be CALLED, not just defined. One
        # definition + at least one call site => >= 2 occurrences of the token.
        html = self._page()
        self.assertGreaterEqual(html.count(b"lifecycleCluster("), 2,
                                "lifecycleCluster() is defined but never called")
        # anchor the call inside the repo header: the marker sits next to the
        # header token cluster the repo-h row already emits.
        self.assertIn(b"repo-h", html)

    def test_scoped_ibtn_colour_variants_added_without_clobbering_base(self):
        # CP1 finding 2: `.ibtn` already exists globally (theme/config header
        # buttons). REUSE it; add only scoped colour variants for the lifecycle
        # semantics. The base rule must survive (no regression of header icons).
        html = self._page()
        self.assertIn(b".ibtn{", html, "base .ibtn rule was clobbered")
        self.assertIn(b".ibtn.danger", html)
        self.assertIn(b".ibtn.go", html)

    def test_selection_listener_still_ignores_button_clicks(self):
        # CP1 finding 6 / prevention-log: a click on a lifecycle icon button must
        # NOT trigger lane selection. The delegated #repos listener early-returns
        # on any button/anchor/control target -- assert that guard is intact.
        self.assertIn(b'closest("button,a,select,input,details,summary")', self._page())


class TestFleetRailRoleRows(unittest.TestCase):
    """#258 rail cleanup (operator: labels/text 'disjointed ... needs to be a lot
    cleaner'): each role renders as a fixed TWO-LINE row -- line 1 identity +
    status, line 2 (mono, dim) schedule + last-run -- so dense live data can
    never collide inline or wrap mid-token; and suggested-but-unconfigured roles
    collapse into one ghost +role chip (spec kill-list: they never render as
    roster rows). Structure/wiring pinned here; visual acceptance is the
    dashboard browser verify loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def _role_template(self, html):
        # slice the role-row template literal inside renderRepos so structural
        # assertions are scoped to it.
        i = html.find(b'<div class="role ${off?"off":""}')
        self.assertNotEqual(i, -1, "role row template not found")
        return html[i:i + 700]

    def test_role_row_is_two_lines(self):
        body = self._role_template(self._page())
        self.assertIn(b'class="r1"', body, "line 1 (identity) wrapper missing")
        self.assertIn(b'class="r2"', body, "line 2 (schedule) wrapper missing")
        # status token stays on line 1's right edge, outside r2
        self.assertLess(body.find(b'class="rst"'), body.find(b'class="r2"'))

    def test_ticker_cells_stay_inside_line_two(self):
        # the qreset/agox ticking cells (#238) live in trig/lastRun, which move
        # into r2 -- the 1s ticker + the skip-unchanged guard normalization key
        # on those class names, so they must survive the restructure.
        html = self._page()
        body = self._role_template(html)
        self.assertIn(b'<span class="trig">', body)
        self.assertIn(b"lastRun", body)
        self.assertIn(b"qreset", html)
        self.assertIn(b"agox", html)

    def test_two_line_css_rules_exist(self):
        html = self._page()
        self.assertIn(b".role .r1{", html)
        self.assertIn(b".role .r2{", html)

    def test_unconfigured_roles_collapse_to_ghost_chip(self):
        html = self._page()
        # client filter: placeholder rows (status 'not configured' or neither
        # configured nor enabled) never render as roster rows...
        self.assertIn(b"ghostRoles", html)
        # the server's placeholder status token (dashboard_state.build_roles
        # emits the HYPHENATED "not-configured"; the space form is only the
        # SLABEL display text) -- Codex CP2 caught the space-form mismatch.
        self.assertIn(b'"not-configured"', html)
        # ...and the ghost chip replaces them, linking to the config page.
        self.assertIn('class="role ghost"'.encode(), html)
        self.assertIn("＋ role".encode("utf-8"), html)
        i = html.find(b'class="role ghost"')
        self.assertIn(b'href="/config"', html[i - 60:i + 200])


class TestCenterFocusCollapse(unittest.TestCase):
    """#258 slice 2b: the center focus band collapses from the per-repo NOW-card
    grid to the SELECTED lane's single card. Lifecycle controls, relocated to the
    fleet-rail cluster in slice 2a, are removed from the focus card (no longer
    duplicated); model/effort stay on the card until their own rail sub-slice
    (CP1 finding 3). These assertions pin the render structure; the behavioral
    acceptance (single card renders the selected lane, survives ticks, model
    picker still reachable) is the dashboard browser verify loop."""

    def _focus_body(self):
        # scope every assertion to renderFocus()'s body so an incidental
        # controls()/repos.map() elsewhere on the page can't mask a regression.
        html = dashboard._page_bytes(dashboard.PAGE)
        i = html.find(b"function renderFocus(")
        self.assertNotEqual(i, -1, "renderFocus() is not defined")
        j = html.find(b"function modelCtl(", i)
        self.assertNotEqual(j, -1, "modelCtl() is not defined after renderFocus()")
        return html[i:j]

    def test_focus_no_longer_maps_all_repos(self):
        # the NOW-card grid mapped every repo (`repos.map(...)`). The collapsed
        # center renders a single selected card, so that fleet-wide map is gone.
        self.assertNotIn(b"repos.map(", self._focus_body(),
                         "center focus still maps all repos — NOW-card grid not collapsed")

    def test_focus_resolves_the_selected_lane(self):
        # the single card shown is the selected lane's owning repo, resolved via
        # the shared selectedLane() accessor (self-healing default, never blank).
        self.assertIn(b"selectedLane(", self._focus_body(),
                      "center focus does not resolve the selected lane")

    def test_focus_drops_the_duplicated_lifecycle_controls(self):
        # slice 2a relocated lifecycle to the rail cluster; the focus card must no
        # longer emit controls(). With no remaining caller the controls()/cbtn()
        # renderer is dead and is removed entirely this slice (the rail's
        # lifecycleCluster() independently mirrors the status ladder).
        self.assertNotIn(b"controls(r,st)", self._focus_body(),
                         "focus card still emits the duplicated lifecycle controls()")

    def test_dead_center_control_renderer_removed(self):
        # the now-unused text-button lifecycle renderer (controls()/cbtn()) is
        # deleted, not left dangling; the icon-cluster rail is the sole lifecycle
        # surface. (.cbtn CSS stays -- modelCtl uses it for the save buttons.)
        page = dashboard._page_bytes(dashboard.PAGE)
        self.assertNotIn(b"function controls(", page,
                         "dead controls() renderer still defined")
        self.assertNotIn(b"function cbtn(", page,
                         "dead cbtn() helper still defined")
        self.assertIn(b".cbtn{", page, "modelCtl's .cbtn CSS was wrongly removed")

    def test_focus_keeps_the_model_effort_control(self):
        # CP1 finding 3: 2b removes ONLY the lifecycle duplicate. Model/effort
        # stay on the card until their own rail sub-slice lands.
        self.assertIn(b"modelCtl(r", self._focus_body(),
                      "focus card dropped the model/effort control (2b over-reached)")

    def test_selectLane_rerenders_the_center_focus(self):
        # CP2 (Codex): renderFocus now depends on selectedLane(), so a lane click
        # must re-render the center immediately -- else the card/header lags the
        # click until the next /api/state tick. selectLane re-renders both the
        # rail and the focus.
        page = dashboard._page_bytes(dashboard.PAGE)
        i = page.find(b"function selectLane(")
        self.assertNotEqual(i, -1, "selectLane() is not defined")
        body = page[i:i + 200]
        self.assertIn(b"renderFocus(", body,
                      "selectLane does not re-render the center focus on selection")


class TestCenterActivityScoped(unittest.TestCase):
    """#258 slice 3a: the center ACTIVITY panel scopes to the SELECTED lane's
    repo (its live tool-trace when streaming, its own heartbeat narration when
    idle) instead of stacking every repo -- the spec kills the "jumbled,
    scrolls off the page" shared multi-repo panel; cross-repo lives on the fleet
    rail + org feed by design. RECENT SESSIONS -> lane-history popover stays for
    slice 3b (design-coupled). Structure assertions; behaviour = browser loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def _fn_body(self, name, end):
        html = self._page()
        i = html.find(b"function " + name + b"(")
        self.assertNotEqual(i, -1, name.decode() + "() is not defined")
        j = html.find(b"function " + end + b"(", i)
        self.assertNotEqual(j, -1, end.decode() + "() is not defined after " + name.decode())
        return html[i:j]

    def test_shared_selected_repo_accessor_defined(self):
        # both renderFocus + renderActivity resolve the SAME repo via one
        # accessor (no divergent duplicate resolution).
        self.assertIn(b"function selectedRepoOf(", self._page(),
                      "shared selectedRepoOf() accessor is not defined")

    def test_activity_scopes_to_the_selected_repo(self):
        # renderActivity no longer feeds ALL repos into reposWithActivity -- it
        # resolves the selected repo first, so the panel shows one lane's work.
        body = self._fn_body(b"renderActivity", b"renderTimeline")
        self.assertIn(b"selectedRepoOf(", body,
                      "renderActivity does not scope to the selected repo")
        self.assertNotIn(b"reposWithActivity(repos)", body,
                         "renderActivity still stacks every repo's activity")

    def test_selectLane_rerenders_activity(self):
        # a lane click must refresh the scoped activity panel immediately, same
        # as the focus card (else it lags a click until the next tick).
        page = self._page()
        i = page.find(b"function selectLane(")
        self.assertNotEqual(i, -1, "selectLane() is not defined")
        self.assertIn(b"renderActivity(", page[i:i + 240],
                      "selectLane does not re-render the scoped activity panel")


class TestCenterCleanupSlice4(unittest.TestCase):
    """#258 slice 4 (final): the center is a single selected-lane card since slice
    2b, so the pre-2b multi-card NOW grid on .focus (auto-fill / 360px tracks) is
    dead + off-design -- it left the lone card at ~360px with empty tracks beside
    it, whereas the redesign mockup's center is a full-width lane detail. .focus
    becomes a plain block container so the card fills the center zone. The
    empty/degraded states are already handled by the self-healing selectedLane/
    selectedRepoOf accessors (slices 1-3b). Structure assertion; visual = browser."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_dead_now_card_grid_retired(self):
        # the dead pre-2b grid lived on the .focus rule itself (auto-fill /
        # 360px tracks capping the lone card). #190's compare tiles later
        # reintroduced a LEGITIMATE auto-fill grid -- but on a .tilegrid CHILD
        # rendered only when 2+ lanes are pinned (spec: "OR compare tiles when
        # 2+ lanes pinned"), never on .focus. So the guard pins the .focus
        # rule specifically, not a page-wide auto-fill ban.
        html = self._page()
        m = re.search(rb"\.focus\{[^}]*\}", html)
        self.assertIsNotNone(m, ".focus rule not found")
        self.assertNotIn(b"auto-fill", m.group(0),
                         "dead pre-2b multi-card .focus grid (auto-fill) still present")
        self.assertNotIn(b"360px", m.group(0),
                         "dead pre-2b 360px track cap still on .focus")

    def test_focus_is_a_plain_block_container(self):
        # CP2: assert the exact replacement rule, not merely the absence of
        # auto-fill -- a different grid (auto-fit / fixed columns) would otherwise
        # slip through and re-cap the single lane card.
        html = self._page()
        self.assertIn(b".focus{padding:0 12px}", html,
                      "the .focus rule is not the expected plain block container")


class TestLaneHistoryPopover(unittest.TestCase):
    """#258 slice 3b: the inline "Recent sessions" center section moves behind a
    click-triggered lane-history popover anchored on the selected-lane focus card
    (mockup #pop pattern, #148 data). The inline section + renderHistory +
    HIST_OPEN are deleted; the popover renders the SELECTED repo's sessions (CP1
    P1-a: header names the REPO, not the lane -- sessions carry no lane field, so
    a "lane" header over cross-lane rows would be a display lie). Structure
    assertions; behaviour = browser loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_inline_recent_sessions_section_removed(self):
        # the center no longer stacks an inline RECENT SESSIONS <details> list --
        # the section header, its #history mount, renderHistory, and the now-dead
        # HIST_OPEN expand-state must all be gone.
        html = self._page()
        self.assertNotIn(b">Recent sessions<", html,
                         "inline Recent sessions section header still present")
        self.assertNotIn(b'id="history"', html,
                         "#history inline mount still present")
        self.assertNotIn(b"function renderHistory(", html,
                         "dead renderHistory() still defined")
        self.assertNotIn(b"HIST_OPEN", html,
                         "dead HIST_OPEN inline expand-state still present")

    def test_popover_element_and_renderers_present(self):
        # the fixed popover element + its body renderer + open handler + CSS.
        html = self._page()
        self.assertIn(b'id="pop"', html, "history popover #pop element missing")
        self.assertIn(b'class="pop"', html, "history popover .pop element missing")
        self.assertIn(b"function laneHist(", html, "laneHist() body renderer missing")
        self.assertIn(b"function openLaneHist(", html, "openLaneHist() handler missing")
        self.assertIn(b".pop{", html, ".pop popover CSS missing")
        self.assertIn(b".hrow{", html, ".hrow row CSS missing")

    def test_popover_header_names_repo_not_lane(self):
        # CP1 P1-a: sessions have no lane field, so laneHist labels by repo
        # (dispName), never a lane name -- no #234-class display lie.
        html = self._page()
        i = html.find(b"function laneHist(")
        self.assertNotEqual(i, -1, "laneHist() is not defined")
        j = html.find(b"function ", i + 1)
        body = html[i:j]
        self.assertIn(b"dispName(", body,
                      "laneHist header does not name the repo via dispName()")

    def test_card_trigger_wired(self):
        # the clock icon lives on the focus card and passes the event so the
        # handler can stopPropagation (CP1 P1-c).
        html = self._page()
        self.assertIn(b"ibtn hist", html, "clock trigger button class missing")
        self.assertIn(b"openLaneHist(event,", html,
                      "clock trigger does not pass the event to openLaneHist")

    def test_close_paths_present(self):
        # outside-click + Escape + tick-refresh (render re-fills an OPEN #pop from
        # fresh state every SSE tick, closing only if the repo vanished, so it
        # never shows stale DOM nor flashes shut while read -- CP1 P1-b).
        html = self._page()
        self.assertIn(b'"Escape"', html, "Escape close wiring missing")
        self.assertIn(b"function refreshLaneHist(", html,
                      "tick refresher refreshLaneHist() missing (CP1 P1-b)")
        i = html.find(b"function render(")
        self.assertNotEqual(i, -1, "render() is not defined")
        j = html.find(b"function ", i + 1)
        render_body = html[i:j]
        self.assertIn(b"refreshLaneHist(", render_body,
                      "render() does not refresh the popover on tick (CP1 P1-b)")

    def test_open_blurs_the_trigger(self):
        # CP2: the clock is a <button> in #focus, so leaving it focused makes its
        # card the "held" node in renderFocus's partial-update path -- with one
        # center card that freezes the card + resyncs _sig.focus to stale markup.
        # openLaneHist must blur the anchor so the next tick full-renders the card.
        html = self._page()
        i = html.find(b"function openLaneHist(")
        j = html.find(b"function ", i + 1)
        body = html[i:j]
        self.assertIn(b".blur(", body,
                      "openLaneHist does not blur the trigger (CP2 held-node freeze)")

    def test_selectLane_refreshes_open_popover(self):
        # CP2: picking another lane while the popover is open must re-fill it with
        # the new repo's sessions, not leave the prior repo's history until a tick.
        html = self._page()
        i = html.find(b"function selectLane(")
        self.assertNotEqual(i, -1, "selectLane() is not defined")
        self.assertIn(b"refreshLaneHist(", html[i:i + 200],
                      "selectLane does not refresh an open history popover (CP2)")

    def test_open_handler_is_total(self):
        # CP1 P2: openLaneHist guards LAST before dereferencing repos, and no-ops
        # on a null selected repo rather than throwing on a fresh/empty state.
        html = self._page()
        i = html.find(b"function openLaneHist(")
        self.assertNotEqual(i, -1, "openLaneHist() is not defined")
        j = html.find(b"function ", i + 1)
        body = html[i:j]
        self.assertIn(b"LAST", body, "openLaneHist does not reference LAST")
        self.assertIn(b"return", body,
                      "openLaneHist has no guard/no-op return path (CP1 P2)")


class TestModelEffortPendingEdit(unittest.TestCase):
    """#306: a chosen-but-unsaved model/effort pick must survive an SSE tick
    that REBUILDS the working repo's focus card. Persisted in PENDING_EDIT
    (keyed by repo), re-applied by modelCtl every render independent of focus,
    cleared on a confirmed save. Structure pinned here; the behavioral
    acceptance (pick survives blur + rebuild, model+effort, revert-clears,
    save-clears, idle 0-rebuild) is the browser verify loop."""

    def _page(self):
        return dashboard._page_bytes(dashboard.PAGE)

    def test_pending_edit_store_and_marker_defined(self):
        html = self._page()
        self.assertIn(b"const PENDING_EDIT=", html)
        self.assertIn(b"function markEdit(", html)

    def test_selects_wire_markEdit_not_inline_toggle(self):
        # the onchange must record into PENDING_EDIT (markEdit), not the old
        # focus-dependent inline classList toggle that lost the pick on rebuild.
        html = self._page()
        i = html.find(b"function modelCtl(")
        j = html.find(b"\nfunction ", i + 1)
        body = html[i:j]
        self.assertEqual(body.count(b'onchange="markEdit(this)"'), 2,
                         "both selects must wire markEdit")
        self.assertIn(b"PENDING_EDIT[r.path]", body,
                      "modelCtl must re-apply the pending pick on render")

    def test_save_clears_pending_on_success_only(self):
        html = self._page()
        i = html.find(b"function setModel(")
        j = html.find(b"\nfunction ", i + 1)
        body = html[i:j]
        # cleared inside the ok&&j.ok branch (a failed save keeps the pick)
        self.assertIn(b"delete PENDING_EDIT[repo]", body)
        k = body.find(b"if(ok&&j.ok)")
        self.assertNotEqual(k, -1, "clear must be gated on a confirmed save")
        self.assertLess(k, body.find(b"delete PENDING_EDIT[repo]"),
                        "delete must sit inside the success guard")


_PLIST_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>%(label)s</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/eng/bin/supervisor.sh</string>
    <string>--repo</string>
    <string>%(repo)s</string>
%(lane_args)s  </array>
</dict></plist>
"""


class TestLaneControl(unittest.TestCase):
    """#147: execute_control(repo, action, lane=...) routes the action to THAT
    lane's service + worktree. The lane is gated against the repo's config
    (lanes_valid + lane_names -- the supervisor's own authority) BEFORE any
    filesystem use; unknown / unprovisioned lanes REFUSE, and there is never
    a fallback to the default service (fail-safe, not fail-open)."""

    def _plist(self, label, repo, lane):
        lane_args = ""
        if lane:
            lane_args = ("    <string>--lane</string>\n"
                         "    <string>%s</string>\n" % lane)
        with open(os.path.join(self.la, label + ".plist"), "w") as fh:
            fh.write(_PLIST_TMPL % {"label": label, "repo": repo,
                                    "lane_args": lane_args})

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

    def _sentinel(self, wt):
        return os.path.join(wt, "var", "autonomy-logs", "autonomy-PAUSE")

    def test_lane_pause_touches_the_lane_worktrees_sentinel(self):
        r = dashboard.execute_control(self.repo, "pause", lane="qa")
        self.assertTrue(r.get("ok"), r)
        self.assertTrue(os.path.exists(self._sentinel(self.qa_wt)))
        self.assertFalse(os.path.exists(self._sentinel(self.repo)))

    def test_lane_resume_removes_the_lane_worktrees_sentinel(self):
        open(self._sentinel(self.qa_wt), "a").close()
        r = dashboard.execute_control(self.repo, "resume", lane="qa")
        self.assertTrue(r.get("ok"), r)
        self.assertFalse(os.path.exists(self._sentinel(self.qa_wt)))

    def test_default_lane_name_uses_the_repos_own_path(self):
        r = dashboard.execute_control(self.repo, "pause", lane="main")
        self.assertTrue(r.get("ok"), r)
        self.assertTrue(os.path.exists(self._sentinel(self.repo)))
        self.assertFalse(os.path.exists(self._sentinel(self.qa_wt)))

    def test_no_lane_keeps_todays_behaviour(self):
        r = dashboard.execute_control(self.repo, "pause")
        self.assertTrue(r.get("ok"), r)
        self.assertTrue(os.path.exists(self._sentinel(self.repo)))

    def test_unknown_lane_refuses(self):
        r = dashboard.execute_control(self.repo, "pause", lane="prod")
        self.assertFalse(r.get("ok"))
        # prove nothing happened: no sentinel appeared in EITHER worktree
        # (execute_control never returns plan keys, so asserting on the
        # result dict alone proves nothing -- Codex CP1 Low-7).
        for wt in (self.repo, self.qa_wt):
            self.assertFalse(os.path.exists(self._sentinel(wt)))

    def test_bad_lane_shape_refuses(self):
        r = dashboard.execute_control(self.repo, "pause", lane="../x")
        self.assertFalse(r.get("ok"))
        for wt in (self.repo, self.qa_wt):
            self.assertFalse(os.path.exists(self._sentinel(wt)))

    def test_unprovisioned_lane_refuses_never_falls_back(self):
        os.remove(os.path.join(self.la, "com.autonomy.myrepo.qa.supervisor.plist"))
        r = dashboard.execute_control(self.repo, "stop", lane="qa")
        self.assertFalse(r.get("ok"))
        self.assertIn("setup_worktree", r["error"])

    def test_unreadable_config_refuses_lane_control(self):
        os.remove(os.path.join(self.repo, ".autonomy", "config.yaml"))
        r = dashboard.execute_control(self.repo, "pause", lane="qa")
        self.assertFalse(r.get("ok"))
        for wt in (self.repo, self.qa_wt):
            self.assertFalse(os.path.exists(self._sentinel(wt)))


if __name__ == "__main__":
    unittest.main()


class ConfigOrgBlockTest(unittest.TestCase):
    """#326 slice 1: config_read_model() carries a per-repo `org` block (the
    SD-33 pair + role roster read model from ds.build_org) so /config can
    render Org & Workflow. Best-effort: never fatal to the payload."""

    def setUp(self):
        self._orig_repos = dashboard.Handler.repos
        self._orig_run = dashboard._run
        dashboard._run = lambda args, **kw: None
        self._td = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self._td.name, ".autonomy"))
        with open(os.path.join(self._td.name, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n"
                     "roles:\n  coder:\n    enabled: true\n")
        dashboard.Handler.repos = [self._td.name]

    def tearDown(self):
        dashboard._run = self._orig_run
        dashboard.Handler.repos = self._orig_repos
        self._td.cleanup()

    def test_org_block_in_payload(self):
        repo = dashboard.config_read_model()["repos"][0]
        org = repo["org"]
        self.assertTrue(org["valid"])
        self.assertEqual(org["pair"]["coder"]["model"], "claude-sonnet-5")
        self.assertFalse(org["pair"]["planner"]["scaffolded"])
        names = [r["name"] for r in org["roles"]]
        for n in ("coder", "pm", "qa", "researcher"):
            self.assertIn(n, names)


class ConfigDriftBlockTest(unittest.TestCase):
    """Workstreams slice 2: config_read_model() carries per-repo live-config
    drift ({live, differs}) so the page can badge an uncommitted shadow."""

    def setUp(self):
        self._orig_repos = dashboard.Handler.repos
        self._orig_run = dashboard._run
        dashboard._run = lambda args, **kw: None
        self._td = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self._td.name, ".autonomy"))
        with open(os.path.join(self._td.name, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n")
        dashboard.Handler.repos = [self._td.name]

    def tearDown(self):
        dashboard._run = self._orig_run
        dashboard.Handler.repos = self._orig_repos
        self._td.cleanup()

    def test_no_shadow_no_drift(self):
        repo = dashboard.config_read_model()["repos"][0]
        self.assertEqual(repo["drift"], {"live": False, "differs": False})

    def test_shadow_reports_drift(self):
        d = os.path.join(self._td.name, "var", "autonomy")
        os.makedirs(d)
        with open(os.path.join(d, "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: live-model\n")
        repo = dashboard.config_read_model()["repos"][0]
        self.assertEqual(repo["drift"], {"live": True, "differs": True})


class WorkstreamActionsTest(unittest.TestCase):
    """Authoring slice: the ws_* control actions + repo_init executor wire
    dashboard_control's authoring ops; GET /api/ws-prompt is read-only."""

    def setUp(self):
        self._orig_repos = dashboard.Handler.repos
        self._td = tempfile.TemporaryDirectory()
        self.repo = self._td.name
        os.makedirs(os.path.join(self.repo, ".autonomy", "roles"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("agent:\n  model:\n    primary: claude-sonnet-5\n"
                     "roles:\n  coder:\n    enabled: true\n")
        import subprocess
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")
        dashboard.Handler.repos = [self.repo]

    def tearDown(self):
        dashboard.Handler.repos = self._orig_repos
        self._td.cleanup()

    def test_ws_add_and_set_through_control_layer(self):
        r = dashboard.dcx.ws_add(self.repo, "pm", "pm", dashboard.ENGINE_HOME)
        self.assertTrue(r["ok"], r)
        r = dashboard.dcx.ws_set(self.repo, "pm", {"enabled": True,
            "trigger": {"type": "cron", "schedule": "0 */2 * * *"}})
        self.assertTrue(r["ok"], r)

    def test_repo_init_scaffolds_pack(self):
        bare = tempfile.TemporaryDirectory()
        import subprocess
        subprocess.run(["git", "init", "-q", bare.name], check=True)
        res = dashboard.execute_repo_init(bare.name)
        self.assertTrue(res["ok"], res)
        self.assertTrue(os.path.isfile(
            os.path.join(bare.name, ".autonomy", "config.yaml")))
        # idempotent second run
        res2 = dashboard.execute_repo_init(bare.name)
        self.assertTrue(res2["ok"], res2)
        bare.cleanup()

    def test_ws_prompt_get_reads(self):
        dashboard.dcx.ws_add(self.repo, "pm", "pm", dashboard.ENGINE_HOME)
        got = dashboard.dcx.ws_prompt_get(self.repo, "pm")
        self.assertTrue(got["ok"])
        self.assertTrue(got["path"].startswith("var/autonomy/roles/"))


class TestPipelineRoutes(unittest.TestCase):
    """P3a (#357): GET /pipeline (page) + GET /api/pipeline (read model).
    Repo param is the managed ABSOLUTE PATH, identity-checked against
    Handler.repos -- the /api/ws-prompt contract (a NAME would be ambiguous
    across same-basename managed repos). No write surface."""

    FIXTURE = os.path.join(HERE, "fixtures", "repo-alpha")

    def setUp(self):
        import shutil
        self._orig_repos = dashboard.Handler.repos
        self._td = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self._td.name, "repo-alpha")
        shutil.copytree(self.FIXTURE, self.repo)
        dashboard.Handler.repos = [os.path.abspath(self.repo)]

    def tearDown(self):
        dashboard.Handler.repos = self._orig_repos
        self._td.cleanup()

    def _get(self, path):
        h = dashboard.Handler.__new__(dashboard.Handler)
        h.path = path
        captured = {}
        h._send = lambda code, body, ctype="application/json": captured.update(
            code=code, body=body, ctype=ctype)
        h.do_GET()
        return captured

    def _api(self, repo, role):
        import urllib.parse
        return self._get("/api/pipeline?repo=%s&role=%s"
                         % (urllib.parse.quote(repo, safe=""), role))

    def test_view_route_returns_doc_and_spec(self):
        got = self._api(self.repo, "coder")
        self.assertEqual(got["code"], 200)
        payload = json.loads(got["body"].decode("utf-8"))
        self.assertEqual(payload["source"]["name"], "fixture-flow")
        self.assertEqual(payload["errors"], [])
        self.assertIn("agent_task", payload["spec"])
        self.assertIn("loop", payload["spec"])

    def test_unmanaged_repo_is_400(self):
        got = self._api("/definitely/not/managed", "coder")
        self.assertEqual(got["code"], 400)
        payload = json.loads(got["body"].decode("utf-8"))
        self.assertIn("not managed", payload["error"])

    def test_unknown_role_is_200_with_error(self):
        got = self._api(self.repo, "ghost")
        self.assertEqual(got["code"], 200)
        payload = json.loads(got["body"].decode("utf-8"))
        self.assertIn("unknown role", payload["error"])

    def test_corrupt_doc_degrades_not_500(self):
        pj = os.path.join(self.repo, ".autonomy", "pipelines", "fixture-flow",
                          "pipeline.json")
        with open(pj, "w") as fh:
            fh.write("{nope")
        got = self._api(self.repo, "coder")
        self.assertEqual(got["code"], 200)
        payload = json.loads(got["body"].decode("utf-8"))
        self.assertIsNone(payload["doc"])
        self.assertTrue(payload["errors"])

    def test_pipeline_page_served(self):
        got = self._get("/pipeline")
        self.assertEqual(got["code"], 200)
        self.assertIn("text/html", got["ctype"])
        self.assertIn(b"pipeline", got["body"].lower())


class TestPipelineSaveRoute(unittest.TestCase):
    """P3b (#365): POST /api/control action=pipeline_save. Inherits the token
    gauntlet (Host allowlist + Origin + compare_digest token) and the managed-
    repo gate; oversize bodies allowed for this action like ws_prompt_set."""

    HOST = "127.0.0.1:0"

    def setUp(self):
        import shutil
        self._orig_repos = dashboard.Handler.repos
        self._orig_hosts = getattr(dashboard.Handler, "allowed_hosts", set())
        dashboard.Handler.allowed_hosts = {self.HOST}
        self._td = tempfile.TemporaryDirectory()
        self.repo = os.path.abspath(os.path.join(self._td.name, "repo"))
        shutil.rmtree(self.repo, ignore_errors=True)
        self._build_repo()
        dashboard.Handler.repos = [self.repo]

    def tearDown(self):
        dashboard.Handler.repos = self._orig_repos
        dashboard.Handler.allowed_hosts = self._orig_hosts
        self._td.cleanup()

    def _build_repo(self):
        import subprocess
        os.makedirs(self.repo)
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        with open(os.path.join(self.repo, ".gitignore"), "w") as fh:
            fh.write("var/\n")
        pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(pdir)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    pipeline: flow\n")
        doc = {"name": "flow", "version": 1,
               "caps": {"max_sessions_per_run": 16},
               "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
               "edges": []}
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(pdir, "a.md"), "w") as fh:
            fh.write("brief a\n")

    def _post(self, body, token="__REAL__", host=None):
        import io
        h = dashboard.Handler.__new__(dashboard.Handler)
        h.path = "/api/control"
        body = dict(body)
        if token == "__REAL__":
            body["token"] = dashboard._CONTROL_TOKEN
        elif token is not None:
            body["token"] = token
        raw = json.dumps(body).encode("utf-8")
        h.headers = {"Host": host or self.HOST, "Content-Length": str(len(raw))}
        h.rfile = io.BytesIO(raw)
        h.close_connection = False
        captured = {}
        h._send = lambda code, b=b"", ctype="application/json": captured.update(
            code=code, body=b, ctype=ctype)
        h.do_POST()
        return captured

    def _valid_doc(self, version=3):
        return {"name": "flow", "version": version,
                "caps": {"max_sessions_per_run": 16},
                "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
                "edges": []}

    def test_pipeline_save_writes_shadow_200(self):
        r = self._post({"action": "pipeline_save", "repo": self.repo,
                        "name": "flow", "doc": self._valid_doc(), "briefs": {}})
        self.assertEqual(r["code"], 200)
        self.assertTrue(json.loads(r["body"])["ok"])
        self.assertTrue(os.path.isfile(os.path.join(
            self.repo, "var", "autonomy", "pipelines", "flow", "pipeline.json")))

    def test_pipeline_save_bad_token_403(self):
        r = self._post({"action": "pipeline_save", "repo": self.repo,
                        "name": "flow", "doc": self._valid_doc(), "briefs": {}},
                       token="wrong")
        self.assertEqual(r["code"], 403)

    def test_pipeline_save_unmanaged_repo_400(self):
        r = self._post({"action": "pipeline_save", "repo": "/nope",
                        "name": "flow", "doc": self._valid_doc(), "briefs": {}})
        self.assertEqual(r["code"], 400)

    def test_pipeline_save_invalid_doc_409(self):
        r = self._post({"action": "pipeline_save", "repo": self.repo,
                        "name": "flow", "doc": {"name": "flow"}, "briefs": {}})
        self.assertEqual(r["code"], 409)
        self.assertFalse(json.loads(r["body"])["ok"])

    def test_oversize_body_allowed_only_for_pipeline_save(self):
        big = "x" * 9000
        ok = self._post({"action": "pipeline_save", "repo": self.repo,
                         "name": "flow", "doc": self._valid_doc(),
                         "briefs": {"a.md": big}})
        self.assertNotEqual(ok["code"], 400)             # oversize allowed
        bad = self._post({"action": "config_set", "repo": self.repo,
                          "key": "k", "value": big})
        self.assertEqual(bad["code"], 400)               # oversize rejected


class TestTriggerRoutes(unittest.TestCase):
    """Phase D1 (#383): GET /api/triggers + /api/pipeline name=/token= +
    the trigger_fire/trigger_stop/trigger_resume control actions.
    Marker writes must land where the CONSUMING supervisor reads them
    (lane routing mirrors execute_control's find_lane_service precedent)."""

    HOST = "127.0.0.1:0"
    FIXTURE = os.path.join(HERE, "fixtures", "repo-alpha")

    def setUp(self):
        import shutil
        self._orig_repos = dashboard.Handler.repos
        self._orig_hosts = getattr(dashboard.Handler, "allowed_hosts", set())
        dashboard.Handler.allowed_hosts = {self.HOST}
        self._td = tempfile.TemporaryDirectory()
        self.repo = os.path.abspath(os.path.join(self._td.name, "repo-alpha"))
        shutil.copytree(self.FIXTURE, self.repo)
        dashboard.Handler.repos = [self.repo]

    def tearDown(self):
        dashboard.Handler.repos = self._orig_repos
        dashboard.Handler.allowed_hosts = self._orig_hosts
        self._td.cleanup()

    def _get(self, path):
        h = dashboard.Handler.__new__(dashboard.Handler)
        h.path = path
        captured = {}
        h._send = lambda code, body, ctype="application/json": captured.update(
            code=code, body=body, ctype=ctype)
        h.do_GET()
        return captured

    def _post(self, body, token="__REAL__"):
        import io
        h = dashboard.Handler.__new__(dashboard.Handler)
        h.path = "/api/control"
        body = dict(body)
        if token == "__REAL__":
            body["token"] = dashboard._CONTROL_TOKEN
        elif token is not None:
            body["token"] = token
        raw = json.dumps(body).encode("utf-8")
        h.headers = {"Host": self.HOST, "Content-Length": str(len(raw))}
        h.rfile = io.BytesIO(raw)
        h.close_connection = False
        captured = {}
        h._send = lambda code, b=b"", ctype="application/json": captured.update(
            code=code, body=b, ctype=ctype)
        h.do_POST()
        return captured

    def _payload(self, got):
        return json.loads(got["body"].decode("utf-8"))

    # ---- reads -------------------------------------------------------

    def test_api_triggers_happy(self):
        import urllib.parse
        got = self._get("/api/triggers?repo=%s"
                        % urllib.parse.quote(self.repo, safe=""))
        self.assertEqual(got["code"], 200)
        p = self._payload(got)
        self.assertEqual(sorted(t["name"] for t in p["triggers"]),
                         ["adhoc-digest", "coder", "pr-sweep"])
        self.assertEqual(p["rollup"], {"fixture-flow": "watch"})

    def test_api_triggers_unmanaged_400(self):
        got = self._get("/api/triggers?repo=/definitely/not/managed")
        self.assertEqual(got["code"], 400)

    def test_api_pipeline_by_name_and_token(self):
        import urllib.parse
        q = urllib.parse.quote(self.repo, safe="")
        byname = self._payload(self._get(
            "/api/pipeline?repo=%s&name=fixture-flow" % q))
        self.assertEqual(byname["source"]["kind"], "pipeline")
        self.assertNotIn("error", byname)
        bytok = self._payload(self._get(
            "/api/pipeline?repo=%s&token=adhoc-digest.c0.qa" % q))
        self.assertEqual(bytok["source"]["kind"], "run")
        self.assertEqual(bytok["run"]["parent_token"], "adhoc-digest")
        both = self._payload(self._get(
            "/api/pipeline?repo=%s&role=coder&name=fixture-flow" % q))
        self.assertIn("error", both)

    # ---- lifecycle writes --------------------------------------------

    def _marker(self, sub, base, repo=None):
        return os.path.join(repo or self.repo, "var", "trigger-ctl",
                            sub, base)

    def test_fire_manual_trigger_creates_marker(self):
        r = self._post({"action": "trigger_fire", "repo": self.repo,
                        "name": "adhoc-digest"})
        self.assertEqual(r["code"], 200)
        self.assertTrue(os.path.isfile(self._marker("fire", "adhoc-digest")))
        # empty file -- byte-parity with the hand-touched marker the
        # supervisor consumes today
        self.assertEqual(os.path.getsize(
            self._marker("fire", "adhoc-digest")), 0)

    def test_fire_non_manual_refused(self):
        for name in ("coder", "pr-sweep"):
            r = self._post({"action": "trigger_fire", "repo": self.repo,
                            "name": name})
            self.assertEqual(r["code"], 409)
            self.assertIn("manual", self._payload(r)["error"])
            self.assertFalse(os.path.exists(self._marker("fire", name)))

    def test_stop_resume_roundtrip(self):
        r = self._post({"action": "trigger_stop", "repo": self.repo,
                        "name": "coder"})
        self.assertEqual(r["code"], 200)
        self.assertTrue(os.path.isfile(self._marker("stop", "coder")))
        r = self._post({"action": "trigger_resume", "repo": self.repo,
                        "name": "coder"})
        self.assertEqual(r["code"], 200)
        self.assertFalse(os.path.exists(self._marker("stop", "coder")))
        # resume is idempotent
        r = self._post({"action": "trigger_resume", "repo": self.repo,
                        "name": "coder"})
        self.assertEqual(r["code"], 200)

    def test_unknown_trigger_refused(self):
        r = self._post({"action": "trigger_stop", "repo": self.repo,
                        "name": "ghost"})
        self.assertEqual(r["code"], 409)
        self.assertIn("unknown trigger", self._payload(r)["error"])

    def test_undeclared_lane_trigger_refused(self):
        with open(os.path.join(self.repo, ".autonomy", "triggers",
                               "offlane.json"), "w") as fh:
            json.dump({"name": "offlane", "pipeline": "fixture-flow",
                       "firing": {"mode": "manual"}, "lane": "ghost"}, fh)
        r = self._post({"action": "trigger_stop", "repo": self.repo,
                        "name": "offlane"})
        self.assertEqual(r["code"], 409)
        self.assertIn("undeclared lane", self._payload(r)["error"])
        self.assertFalse(os.path.exists(self._marker("stop", "offlane")))
        self.assertFalse(os.path.exists(
            self._marker("stop", "offlane--ghost")))

    def test_bad_token_403_before_any_write(self):
        r = self._post({"action": "trigger_stop", "repo": self.repo,
                        "name": "coder"}, token="wrong")
        self.assertEqual(r["code"], 403)
        self.assertFalse(os.path.exists(self._marker("stop", "coder")))

    # ---- lane routing (CP1: the wrong-repo write is the bug this
    # suite must catch) ------------------------------------------------

    def _add_lane_trigger(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "a") as fh:
            fh.write("lanes:\n  main:\n    worktree: ../x-main\n"
                     "  qa:\n    worktree: ../x-qa\n")
        with open(os.path.join(self.repo, ".autonomy", "triggers",
                               "qa-sweep.json"), "w") as fh:
            json.dump({"name": "qa-sweep", "pipeline": "fixture-flow",
                       "firing": {"mode": "manual"}, "lane": "qa"}, fh)

    def test_lane_service_worktree_receives_the_marker(self):
        self._add_lane_trigger()
        worktree = os.path.join(self._td.name, "qa-worktree")
        os.makedirs(worktree)
        real = dashboard.dcx.find_lane_service
        dashboard.dcx.find_lane_service = lambda *a, **k: {
            "label": "com.autonomy.x.qa.supervisor", "plist": "/la/x.plist",
            "repo": worktree}
        try:
            r = self._post({"action": "trigger_stop", "repo": self.repo,
                            "name": "qa-sweep"})
        finally:
            dashboard.dcx.find_lane_service = real
        self.assertEqual(r["code"], 200)
        self.assertTrue(os.path.isfile(
            self._marker("stop", "qa-sweep--qa", repo=worktree)))
        self.assertFalse(os.path.exists(
            self._marker("stop", "qa-sweep--qa")))     # NOT the registered repo

    def test_own_service_running_lane_keeps_marker_here_with_suffix(self):
        self._add_lane_trigger()
        real = dashboard.dcx.find_lane_service
        dashboard.dcx.find_lane_service = lambda *a, **k: None
        try:
            r = self._post({"action": "trigger_stop", "repo": self.repo,
                            "name": "qa-sweep"})
        finally:
            dashboard.dcx.find_lane_service = real
        self.assertEqual(r["code"], 200)
        self.assertTrue(os.path.isfile(
            self._marker("stop", "qa-sweep--qa")))

    def test_shadow_config_lane_removal_refuses(self):
        # Codex CP2 (D1): lane authority reads the SD-34 EFFECTIVE config.
        # Committed config still declares lane qa, but the var-live shadow
        # (what the supervisor actually runs) has dropped the lanes block --
        # the trigger's qa lane is now undeclared, so the marker refuses.
        self._add_lane_trigger()
        shadow_dir = os.path.join(self.repo, "var", "autonomy")
        os.makedirs(shadow_dir, exist_ok=True)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml")) as fh:
            committed = fh.read()
        shadow = "".join(l for l in committed.splitlines(True)
                         if "lanes:" not in l and "worktree:" not in l
                         and l.strip() not in ("main:", "qa:"))
        with open(os.path.join(shadow_dir, "config.yaml"), "w") as fh:
            fh.write(shadow)
        r = self._post({"action": "trigger_stop", "repo": self.repo,
                        "name": "qa-sweep"})
        self.assertEqual(r["code"], 409)
        self.assertIn("undeclared lane", self._payload(r)["error"])
        self.assertFalse(os.path.exists(
            self._marker("stop", "qa-sweep--qa")))

    def test_unresolvable_lane_service_refuses_writes_nothing(self):
        self._add_lane_trigger()
        real = dashboard.dcx.find_lane_service
        dashboard.dcx.find_lane_service = lambda *a, **k: {
            "error": "no service installed for lane 'qa'"}
        try:
            r = self._post({"action": "trigger_stop", "repo": self.repo,
                            "name": "qa-sweep"})
        finally:
            dashboard.dcx.find_lane_service = real
        self.assertEqual(r["code"], 409)
        self.assertFalse(os.path.exists(
            self._marker("stop", "qa-sweep--qa")))
