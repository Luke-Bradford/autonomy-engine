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


if __name__ == "__main__":
    unittest.main()
