"""Unit test for the dashboard server's benign-disconnect classifier -- the
guard that stops a browser resetting an SSE/keep-alive connection from spewing
a traceback that looks like the app crashing -- and the served-page templating
that single-sources the model-picker roster (#134)."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import dashboard  # noqa: E402
import accounts  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
