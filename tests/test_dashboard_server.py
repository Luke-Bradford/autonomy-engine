"""Unit test for the dashboard server's benign-disconnect classifier -- the
guard that stops a browser resetting an SSE/keep-alive connection from spewing
a traceback that looks like the app crashing -- and the served-page templating
that single-sources the model-picker roster (#134)."""
import json
import os
import re
import sys
import tempfile
import unittest

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

    def test_overlay_write_merges_and_preserves(self):
        ov = self._overlay()
        dashboard._write_overlay(ov, {"model": "claude-opus-4-8"})
        dashboard._write_overlay(ov, {"effort": "high"})
        text = open(ov).read()
        self.assertIn("model=claude-opus-4-8", text)
        self.assertIn("effort=high", text)
        dashboard._write_overlay(ov, {"model": "claude-sonnet-5"})
        text = open(ov).read()
        self.assertIn("model=claude-sonnet-5", text)
        self.assertIn("effort=high", text)           # untouched key preserved
        self.assertNotIn("claude-opus-4-8", text)

    def test_execute_set_model_default_writes_overlay_not_config(self):
        cfg = self._write_config()
        before = open(cfg).read()
        r = dashboard.execute_set_model(self.repo, "claude-opus-4-8", "high", "default")
        self.assertTrue(r["ok"], r)
        self.assertEqual(open(cfg).read(), before)    # committed config untouched
        self.assertIn("model=claude-opus-4-8", open(self._overlay()).read())

    def test_execute_config_set_model_key_writes_overlay(self):
        cfg = self._write_config()
        before = open(cfg).read()
        r = dashboard.execute_config_set(self.repo, "agent.model.primary",
                                         "claude-opus-4-8")
        self.assertTrue(r["ok"], r)
        self.assertEqual(open(cfg).read(), before)
        self.assertIn("model=claude-opus-4-8", open(self._overlay()).read())

    def test_overlay_write_does_not_normalize_dirty_line(self):
        # A stray-space line the supervisor ignores must NOT be resurrected into
        # an effective `model=...` by an unrelated save (fail-safe parity).
        ov = self._overlay()
        os.makedirs(os.path.dirname(ov))
        with open(ov, "w") as fh:
            fh.write(" model=claude-opus-4-8\n")     # leading space -> ignored by bash
        dashboard._write_overlay(ov, {"effort": "high"})
        text = open(ov).read()
        self.assertIn(" model=claude-opus-4-8", text)   # preserved verbatim, still dirty
        self.assertNotIn("\nmodel=claude-opus-4-8", text)  # never normalized to a clean key
        self.assertIn("effort=high", text)


class TestBenignDisconnect(unittest.TestCase):
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

    def test_config_page_model_roster_single_sourced(self):
        # the config page's model-field datalist is filled from the SAME
        # accounts curated roster the main page uses (#82 builds on #134), so
        # the authoring picker and the runtime override picker cannot drift.
        html = dashboard._page_bytes(dashboard.CONFIG_PAGE)
        roster = accounts.subscription_models("claude_subscription")
        injected = ("const MODEL_CHOICES=" + json.dumps(roster) + ";").encode()
        self.assertIn(injected, html)
        self.assertIn(b'"claude-opus-4-8"', html)


class TestControlRoomShell(unittest.TestCase):
    """UI-1 (#184): the control-room skin + shell. The reskin restructures the
    page into a full-viewport three-zone grid with an icon top bar, killing the
    grid background / accent stripes / max-width cage -- but it must NOT drop any
    render mount point, or the JS silently stops populating a panel. These assert
    the render contract survives the reskin (and future ones)."""

    # every id the page's render functions write into (render() in the page
    # script) -- dropping one silently breaks that panel.
    MOUNTS = [
        b'id="focus"', b'id="history"', b'id="repos"', b'id="quota"',
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


if __name__ == "__main__":
    unittest.main()
