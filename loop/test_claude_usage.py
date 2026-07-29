#!/usr/bin/env python3
"""Unit tests for loop/claude_usage.py -- the build loop's OWN 7-day quota reader
(#764).

Runs in CI on ubuntu-latest, so every seam is injected: no Keychain, no network,
no subprocess. The `security` runner, the URL opener and `sys.platform` are all
parameters, which is also what lets the darwin-only paths be exercised on Linux.

Stdlib only (`unittest`), consistent with the rest of the control plane.
"""
import io
import json
import math
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import claude_usage as cu  # noqa: E402


def blob(token="tok-abc"):
    """A Keychain payload shaped like the real `Claude Code-credentials` item."""
    return json.dumps({"claudeAiOauth": {"accessToken": token,
                                         "refreshToken": "r"}})


def payload(seven=48.0, five=12.0):
    """An endpoint payload. `utilization` is a PERCENT upstream (48.0 == 48%)."""
    return {"five_hour": {"utilization": five, "resets_at": "2026-07-30T00:00:00Z"},
            "seven_day": {"utilization": seven, "resets_at": "2026-08-02T00:00:00Z"}}


class FakeResp:
    """Minimal urlopen return: `.status`, `.read()`, `.close()`."""

    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self._body = body
        self.closed = False

    def read(self):
        return self._body

    def close(self):
        self.closed = True


class Completed:
    """Minimal subprocess.CompletedProcess stand-in."""

    def __init__(self, returncode=0, stdout=""):
        self.returncode = returncode
        self.stdout = stdout


# --- read_oauth_token --------------------------------------------------------
class TestReadOAuthToken(unittest.TestCase):
    def test_happy(self):
        self.assertEqual(
            cu.read_oauth_token(runner=lambda: blob("tok-1"), platform="darwin"),
            "tok-1")

    def test_non_darwin_returns_none_without_calling_the_runner(self):
        """The Keychain item is macOS-only. On any other platform the reader must
        not even attempt the read -- studio's own Docker image hits this path
        (#764), and a `security` invocation there would be pure noise."""
        calls = []

        def runner():
            calls.append(1)
            return blob()

        self.assertIsNone(cu.read_oauth_token(runner=runner, platform="linux"))
        self.assertEqual(calls, [])

    def test_platform_defaults_to_sys_platform(self):
        """Called with no `platform`, the real `sys.platform` decides. Asserted
        both ways so this holds on the ubuntu runner AND on the operator's Mac."""
        got = cu.read_oauth_token(runner=lambda: blob("tok-2"))
        self.assertEqual(got, "tok-2" if sys.platform == "darwin" else None)

    def test_runner_raising_returns_none(self):
        def boom():
            raise OSError("no security binary")

        self.assertIsNone(cu.read_oauth_token(runner=boom, platform="darwin"))

    def test_runner_none_or_empty_returns_none(self):
        for out in (None, "", "   "):
            self.assertIsNone(
                cu.read_oauth_token(runner=lambda: out, platform="darwin"))

    def test_non_json_blob_returns_none(self):
        self.assertIsNone(
            cu.read_oauth_token(runner=lambda: "not json", platform="darwin"))

    def test_non_dict_json_returns_none(self):
        for body in ("[1,2]", '"str"', "42", "null"):
            self.assertIsNone(
                cu.read_oauth_token(runner=lambda: body, platform="darwin"))

    def test_missing_or_wrongly_typed_oauth_section_returns_none(self):
        for body in ({}, {"claudeAiOauth": None}, {"claudeAiOauth": "x"},
                     {"claudeAiOauth": []}, {"claudeAiOauth": {}},
                     {"claudeAiOauth": {"accessToken": None}},
                     {"claudeAiOauth": {"accessToken": 42}},
                     {"claudeAiOauth": {"accessToken": ""}}):
            self.assertIsNone(
                cu.read_oauth_token(runner=lambda: json.dumps(body),
                                    platform="darwin"),
                msg=repr(body))


class TestKeychainRunner(unittest.TestCase):
    """The default runner's CONTRACT, with subprocess.run itself injected."""

    def test_reads_the_credentials_item_and_never_puts_the_token_on_argv(self):
        seen = {}

        def fake_run(argv, **kw):
            seen["argv"] = argv
            seen["kw"] = kw
            return Completed(0, blob("tok-secret"))

        out = cu._keychain_runner(runner=fake_run)
        self.assertEqual(out, blob("tok-secret"))
        self.assertEqual(seen["argv"],
                         ["security", "find-generic-password",
                          "-s", cu.KEYCHAIN_SERVICE, "-w"])
        # The item NAME rides argv; the SECRET must only ever come back on stdout.
        self.assertNotIn("tok-secret", " ".join(seen["argv"]))
        # A Keychain prompt or hang must not wedge a fire.
        self.assertEqual(seen["kw"].get("timeout"), cu.KEYCHAIN_TIMEOUT)

    def test_nonzero_exit_returns_none(self):
        self.assertIsNone(
            cu._keychain_runner(runner=lambda a, **k: Completed(44, "")))

    def test_subprocess_failure_returns_none(self):
        def boom(argv, **kw):
            raise subprocess.TimeoutExpired(argv, 4.0)

        self.assertIsNone(cu._keychain_runner(runner=boom))


# --- fetch_usage -------------------------------------------------------------
class TestFetchUsage(unittest.TestCase):
    def test_happy_and_request_shape(self):
        seen = {}

        def opener(req, timeout=None):
            seen["url"] = req.full_url
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            seen["timeout"] = timeout
            return FakeResp(200, json.dumps(payload()).encode())

        got = cu.fetch_usage("tok-9", opener=opener)
        self.assertEqual(got, payload())
        self.assertEqual(seen["url"], cu.USAGE_URL)
        self.assertEqual(seen["headers"]["authorization"], "Bearer tok-9")
        self.assertEqual(seen["headers"]["anthropic-beta"], cu.USAGE_BETA)
        self.assertEqual(seen["timeout"], cu.HTTP_TIMEOUT)

    def test_empty_token_attempts_no_http(self):
        """No token means no request -- never an unauthenticated poll of a
        rate-limited endpoint that all three quota sources share."""
        calls = []

        def opener(req, timeout=None):
            calls.append(1)
            return FakeResp()

        for tok in (None, ""):
            self.assertIsNone(cu.fetch_usage(tok, opener=opener))
        self.assertEqual(calls, [])

    def test_non_200_returns_none(self):
        # 429 is the observed failure: the endpoint rate-limits direct polling
        # (#765, #770). It must read as UNREADABLE, never as a number.
        for status in (401, 429, 500, 302):
            self.assertIsNone(cu.fetch_usage(
                "t", opener=lambda r, timeout=None: FakeResp(
                    status, json.dumps(payload()).encode())))

    def test_getcode_only_response_is_honoured(self):
        class Old:
            def getcode(self):
                return 200

            def read(self):
                return json.dumps(payload()).encode()

            def close(self):
                pass

        self.assertEqual(cu.fetch_usage("t", opener=lambda r, timeout=None: Old()),
                         payload())

    def test_opener_raising_returns_none(self):
        def boom(req, timeout=None):
            raise OSError("connection reset")

        self.assertIsNone(cu.fetch_usage("t", opener=boom))

    def test_read_raising_returns_none(self):
        class Bad(FakeResp):
            def read(self):
                raise OSError("truncated")

        self.assertIsNone(cu.fetch_usage("t", opener=lambda r, timeout=None: Bad()))

    def test_response_is_closed(self):
        resp = FakeResp(200, json.dumps(payload()).encode())
        cu.fetch_usage("t", opener=lambda r, timeout=None: resp)
        self.assertTrue(resp.closed)

    def test_non_json_body_returns_none(self):
        self.assertIsNone(cu.fetch_usage(
            "t", opener=lambda r, timeout=None: FakeResp(200, b"<html>nope")))

    def test_non_dict_body_returns_none(self):
        for body in (b"[1,2]", b'"s"', b"42", b"null"):
            self.assertIsNone(cu.fetch_usage(
                "t", opener=lambda r, timeout=None: FakeResp(200, body)))


# --- seven_day_pct -----------------------------------------------------------
class TestSevenDayPct(unittest.TestCase):
    def test_percent_is_returned_as_a_percent(self):
        """THE load-bearing unit test. Upstream reports `utilization` as a
        PERCENT (48.0 == 48%). The two OTHER readers of this endpoint
        (lib/claude_usage.py::_map_window, studio's claude-quota.ts) divide by
        100 to store a fraction, and drive.sh's `quota_read_url` multiplies by
        100 again to undo it. This reader is called directly by drive.sh, so it
        must NOT do that round-trip. A stray /100 here would report 0 for any
        utilization under 150% -- a fail-open reading on the one guard that must
        never fail open."""
        self.assertEqual(cu.seven_day_pct(payload(seven=48.0)), 48)

    def test_reads_the_seven_day_window_not_the_five_hour_one(self):
        """QUOTA_STOP_PCT is a 7-day threshold. The 5h window is typically much
        higher, so reading the wrong one would stop the loop constantly -- and,
        worse, could read LOW when 7d is high."""
        self.assertEqual(cu.seven_day_pct(payload(seven=13.0, five=97.0)), 13)

    def test_rounds_to_an_integer(self):
        """drive.sh does arithmetic on this, so it must be an integer. Python's
        round-half-to-even applies (48.5 -> 48, 49.5 -> 50)."""
        for pct, want in ((48.4, 48), (48.5, 48), (49.5, 50), (79.5, 80),
                          (12.7, 13)):
            self.assertEqual(cu.seven_day_pct(payload(seven=pct)), want,
                             msg=str(pct))
            self.assertEqual(int(round((pct / 100.0) * 100)), want, msg=str(pct))

    def test_may_disagree_with_the_http_sources_by_one_at_half_percents(self):
        """The BOUND on the two surviving post-C3 sources disagreeing, pinned
        because an earlier version of this file claimed they could never
        disagree, and that was wrong.

        This reader rounds the raw percent; `quota_read_url` rounds
        `fraction * 100` after the HTTP sources divided by 100. `pct/100*100` is
        not an exact float round-trip, so at an exact half-percent the two can
        land on either side of round-half-to-even. A 0-200 sweep in 0.5 steps
        finds exactly 8 such points.

        Asserted as a bound (<= 1 percentage point, half-percents only) rather
        than as equality, so the real behaviour is documented and a future change
        that widened the gap would fail here."""
        disagreements = []
        pct = 0.0
        while pct <= 200.0001:
            mine = cu.seven_day_pct(payload(seven=pct))
            theirs = int(round((pct / 100.0) * 100))
            if mine != theirs:
                disagreements.append(pct)
                self.assertEqual(abs(mine - theirs), 1, msg=str(pct))
                self.assertEqual(pct % 1, 0.5, msg=str(pct))
            pct += 0.5
        # Named explicitly: a change in count means the rounding relationship
        # moved and the +/-1 bound documented in drive.sh needs re-checking.
        self.assertEqual(disagreements,
                         [54.5, 57.5, 101.5, 103.5, 122.5, 124.5, 125.5, 127.5])
        # And the threshold band the guard actually decides on is NOT affected.
        for pct in (79.0, 79.5, 80.0, 80.5):
            self.assertEqual(cu.seven_day_pct(payload(seven=pct)),
                             int(round((pct / 100.0) * 100)), msg=str(pct))

    def test_a_real_zero_is_a_reading_not_an_absence(self):
        """0% means the window is wide open; UNREADABLE means blind. #440 pins
        these as distinct outcomes, so 0.0 must come back as the integer 0 and
        NOT as None."""
        self.assertEqual(cu.seven_day_pct(payload(seven=0.0)), 0)

    def test_overage_passes_through_uncapped(self):
        """An overage window legitimately reports >100% and is the STRONGEST
        stop signal. Capping it at 100 would still stop the loop today, but it
        discards the evidence; there is no reading above the threshold that
        benefits from being made smaller."""
        self.assertEqual(cu.seven_day_pct(payload(seven=120.0)), 120)
        self.assertEqual(cu.seven_day_pct(payload(seven=100.0)), 100)

    def test_integer_utilization_is_accepted(self):
        self.assertEqual(cu.seven_day_pct(payload(seven=48)), 48)

    def test_missing_or_malformed_window_returns_none(self):
        for data in (None, {}, [], "s", 42,
                     {"seven_day": None}, {"seven_day": "x"}, {"seven_day": []},
                     {"seven_day": {}},
                     {"seven_day": {"utilization": None}},
                     {"seven_day": {"utilization": "48"}},
                     {"seven_day": {"utilization": True}},
                     {"seven_day": {"utilization": False}},
                     {"seven_day": {"utilization": -1}}):
            self.assertIsNone(cu.seven_day_pct(data), msg=repr(data))

    def test_non_finite_utilization_returns_none(self):
        """`json.loads` ACCEPTS the bare tokens NaN/Infinity (verified: it
        yields a real float nan), so a malformed payload could otherwise make
        this print 'nan' or overflow. lib/quota.py::_fraction records the same
        trap."""
        for raw in ('{"seven_day": {"utilization": NaN}}',
                    '{"seven_day": {"utilization": Infinity}}',
                    '{"seven_day": {"utilization": -Infinity}}'):
            data = json.loads(raw)
            self.assertFalse(math.isfinite(data["seven_day"]["utilization"]))
            self.assertIsNone(cu.seven_day_pct(data), msg=raw)

    def test_a_missing_five_hour_window_does_not_veto_the_reading(self):
        """A deliberate divergence from lib/claude_usage.py, which requires BOTH
        windows (its all-or-nothing rule exists so the dashboard PANEL never
        shows a live+stale mix -- the dashboard's reason, not ours). Nothing here
        reads 5h, and discarding a good 7-day figure over an unrelated field
        would cost availability on the guard for no benefit."""
        self.assertEqual(cu.seven_day_pct({"seven_day": {"utilization": 48.0}}), 48)

    def test_an_unparseable_resets_at_does_not_veto_the_reading(self):
        """Same reasoning: lib/claude_usage.py rejects a window whose
        `resets_at` will not parse because it RENDERS that timestamp. This reader
        returns one integer and never looks at it."""
        self.assertEqual(
            cu.seven_day_pct({"seven_day": {"utilization": 48.0,
                                            "resets_at": "not-a-date"}}), 48)


# --- read_seven_day_pct ------------------------------------------------------
class TestReadSevenDayPct(unittest.TestCase):
    def test_happy_path_threads_the_token_to_the_fetcher(self):
        seen = {}

        def fetcher(token):
            seen["token"] = token
            return payload(seven=42.0)

        self.assertEqual(
            cu.read_seven_day_pct(token_reader=lambda: "tok-x", fetcher=fetcher),
            42)
        self.assertEqual(seen["token"], "tok-x")

    def test_no_token_means_no_fetch(self):
        calls = []
        got = cu.read_seven_day_pct(token_reader=lambda: None,
                                    fetcher=lambda t: calls.append(1))
        self.assertIsNone(got)
        self.assertEqual(calls, [])

    def test_any_raise_anywhere_degrades_to_none(self):
        def boom(*a, **k):
            raise RuntimeError("unexpected")

        self.assertIsNone(cu.read_seven_day_pct(token_reader=boom))
        self.assertIsNone(cu.read_seven_day_pct(token_reader=lambda: "t",
                                                fetcher=boom))

    def test_failed_fetch_returns_none(self):
        self.assertIsNone(cu.read_seven_day_pct(token_reader=lambda: "t",
                                                fetcher=lambda t: None))


# --- main (the CLI contract drive.sh depends on) ------------------------------
class TestMain(unittest.TestCase):
    def run_main(self, reader):
        out, err = io.StringIO(), io.StringIO()
        rc = cu.main(reader=reader, out=out, err=err)
        return rc, out.getvalue(), err.getvalue()

    def test_a_reading_prints_the_integer_and_exits_zero(self):
        rc, out, _ = self.run_main(lambda: 42)
        self.assertEqual((rc, out), (0, "42\n"))

    def test_zero_prints_zero_and_exits_zero(self):
        """0% is a READING. It must be printed and must exit 0 -- the caller
        distinguishes it from unreadable by the empty stdout, not by the value."""
        rc, out, _ = self.run_main(lambda: 0)
        self.assertEqual((rc, out), (0, "0\n"))

    def test_unreadable_prints_NOTHING_and_exits_nonzero(self):
        """The #440 invariant: UNREADABLE must never be reported as 0. Two
        independent channels say so -- empty stdout AND a non-zero exit -- because
        drive.sh reads stdout in a command substitution and treats "" as blind."""
        rc, out, _ = self.run_main(lambda: None)
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertNotIn("0", out)

    def test_an_exception_in_the_reader_prints_nothing_and_exits_nonzero(self):
        def boom():
            raise RuntimeError("boom")

        rc, out, _ = self.run_main(boom)
        self.assertEqual((rc, out), (1, ""))

    def test_stdout_carries_the_value_alone(self):
        """drive.sh captures stdout AS the percent, so any diagnostic must go to
        stderr. A stray log line on stdout would be concatenated into the
        reading and land on the fail-open path."""
        rc, out, err = self.run_main(lambda: 7)
        self.assertEqual(out.strip(), "7")
        self.assertEqual(out.count("\n"), 1)

    def test_the_token_never_reaches_stdout_or_stderr(self):
        """Security: the OAuth token transits only the in-process Authorization
        header. It must not appear in output on ANY path, including failure."""
        secret = "tok-do-not-leak"
        out, err = io.StringIO(), io.StringIO()
        cu.main(reader=lambda: cu.read_seven_day_pct(
            token_reader=lambda: secret,
            fetcher=lambda t: payload(seven=5.0)), out=out, err=err)
        self.assertNotIn(secret, out.getvalue())
        self.assertNotIn(secret, err.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
