"""Unit tests for lib/quota.py -- the single bash-callable account-utilization
reader (#150 Slice A). It reuses the SAME two sources the dashboard reads
(claude_usage.live_quota for the account-level live number, dashboard_state.
recent_quota_windows for the log-scan fallback) and combines them with the
dashboard's precedence: live is all-or-nothing and authoritative; the log-scan
is a single-repo degraded fallback consulted only when live is absent.

Every source is injected -- no real network, Keychain, or filesystem is touched.
Invariants under test: the reader never fabricates a number (every unreadable/
stale/malformed path -> None); live+log are never mixed; overage (>1) is passed
through, not capped; the default seams contain all exceptions."""
import io
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

import quota  # noqa: E402


def live(fh, sd, source="live"):
    """A live windows dict shaped like claude_usage._build's output."""
    return {"five_hour": {"utilization": fh, "resets_at": 1},
            "seven_day": {"utilization": sd, "resets_at": 1}, "source": source}


def logscan(fh=None, sd=None):
    """A log-scan windows dict shaped like recent_quota_windows' output."""
    out = {}
    if fh is not None:
        out["five_hour"] = {"utilization": fh, "resets_at": 1}
    if sd is not None:
        out["seven_day"] = {"utilization": sd, "resets_at": 1}
    return out


def util(window, live_val=None, logscan_val=None, logdir="x"):
    return quota.utilization(
        window, logdir=logdir,
        live_reader=lambda: live_val,
        logscan_reader=lambda ld: logscan_val if logscan_val is not None else {})


class TestWindowNormalization(unittest.TestCase):
    def test_aliases_map(self):
        for w in ("5h", "five_hour"):
            self.assertEqual(util(w, live_val=live(0.4, 0.7)), 0.4)
        for w in ("7d", "seven_day"):
            self.assertEqual(util(w, live_val=live(0.4, 0.7)), 0.7)

    def test_junk_window_is_none(self):
        self.assertIsNone(util("weekly", live_val=live(0.4, 0.7)))
        self.assertIsNone(util("", live_val=live(0.4, 0.7)))
        self.assertIsNone(util(None, live_val=live(0.4, 0.7)))


class TestPrecedence(unittest.TestCase):
    def test_live_wins_and_logscan_ignored(self):
        # all-or-nothing: a present live dict is authoritative; the log-scan is
        # not consulted even though it holds a (different) value.
        self.assertEqual(
            util("5h", live_val=live(0.4, 0.7), logscan_val=logscan(0.9, 0.9)),
            0.4)

    def test_live_none_falls_back_to_logscan(self):
        self.assertEqual(
            util("5h", live_val=None, logscan_val=logscan(0.55, 0.66)), 0.55)
        self.assertEqual(
            util("7d", live_val=None, logscan_val=logscan(0.55, 0.66)), 0.66)

    def test_both_absent_is_none(self):
        self.assertIsNone(util("5h", live_val=None, logscan_val={}))

    def test_window_absent_in_logscan_is_none(self):
        self.assertIsNone(
            util("7d", live_val=None, logscan_val=logscan(fh=0.5)))

    def test_live_present_but_window_malformed_is_none_no_mixing(self):
        # a present live dict whose target window is malformed must NOT fall
        # through to the log-scan (would be live+log mixing).
        self.assertIsNone(
            util("5h", live_val=live("bad", 0.7), logscan_val=logscan(0.9, 0.9)))


class TestSeamResolution(unittest.TestCase):
    def test_module_globals_honored_without_repassing(self):
        # utilization resolves _live/_logscan at CALL time, so rebinding the
        # module globals is honored even when the caller passes no readers
        # (the property main() relies on; a def-time default would miss it).
        old_live, old_logscan = quota._live, quota._logscan
        quota._live = lambda: live(0.42, 0.84)
        quota._logscan = lambda ld: {}
        try:
            self.assertEqual(quota.utilization("5h"), 0.42)
            self.assertEqual(quota.utilization("7d"), 0.84)
        finally:
            quota._live, quota._logscan = old_live, old_logscan


class TestFractionValidation(unittest.TestCase):
    def test_overage_passed_through_not_capped(self):
        self.assertEqual(util("5h", live_val=live(1.05, 0.2)), 1.05)

    def test_zero_is_valid(self):
        self.assertEqual(util("5h", live_val=live(0, 0.2)), 0.0)

    def test_malformed_values_are_absent(self):
        for bad in (True, False, "0.5", -0.1, None):
            self.assertIsNone(util("5h", live_val=None,
                                   logscan_val={"five_hour": {"utilization": bad}}))

    def test_non_finite_rejected(self):
        # json.loads accepts NaN/Infinity tokens; they must NOT read as a valid
        # fraction (would print 'nan'/'inf' + exit 0, fabricating quota data).
        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertIsNone(util("5h", live_val=live(bad, 0.2)))


class TestExceptionContainment(unittest.TestCase):
    def test_live_reader_raising_falls_to_logscan(self):
        def boom():
            raise RuntimeError("keychain hang")
        self.assertEqual(
            quota.utilization("5h", logdir="x", live_reader=boom,
                              logscan_reader=lambda ld: logscan(0.33, 0.44)),
            0.33)

    def test_logscan_reader_raising_is_none(self):
        def boom(ld):
            raise OSError("disk")
        self.assertIsNone(
            quota.utilization("5h", logdir="x", live_reader=lambda: None,
                              logscan_reader=boom))

    def test_default_logscan_reader_handles_none_logdir(self):
        # os.listdir(None) raises TypeError (not the OSError recent_quota_windows
        # catches); the default seam must guard it -> {} -> None.
        self.assertIsNone(
            quota.utilization("5h", logdir=None, live_reader=lambda: None))


class TestCli(unittest.TestCase):
    def _run(self, argv, live_val=None, logscan_val=None):
        out, err = io.StringIO(), io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        old_live, old_logscan = quota._live, quota._logscan
        sys.stdout, sys.stderr = out, err
        quota._live = lambda: live_val
        quota._logscan = lambda ld: logscan_val if logscan_val is not None else {}
        try:
            rc = quota.main(argv)
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            quota._live, quota._logscan = old_live, old_logscan
        return rc, out.getvalue(), err.getvalue()

    def test_available_prints_fraction_exit0(self):
        rc, out, _ = self._run(["quota.py", "7d", "x"], live_val=live(0.4, 0.72))
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "0.72")

    def test_unavailable_empty_stdout_exit1(self):
        rc, out, _ = self._run(["quota.py", "7d", "x"], live_val=None,
                               logscan_val={})
        self.assertEqual(rc, 1)
        self.assertEqual(out.strip(), "")

    def test_bad_args_exit2(self):
        rc, _, err = self._run(["quota.py"])
        self.assertEqual(rc, 2)
        self.assertIn("usage", err)

    def test_bad_window_exit2(self):
        # a bogus window is a usage error (operator typo), distinct from
        # 'available data says None' (exit 1).
        rc, out, err = self._run(["quota.py", "weekly", "x"],
                                 live_val=live(0.4, 0.7))
        self.assertEqual(rc, 2)
        self.assertEqual(out.strip(), "")
        self.assertIn("usage", err)


if __name__ == "__main__":
    unittest.main()
