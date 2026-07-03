"""Unit tests for lib/claude_usage.py -- the live Claude 5h/7d utilization
source (#160). Reads the OAuth token from the macOS Keychain and polls the
CLI's own api/oauth/usage endpoint; the SAMPLER thread owns all I/O, the
request path only reads a cache. Every seam (Keychain runner, platform, HTTP
opener, clock) is injected -- no real network or Keychain is ever touched.

Security-critical invariants under test: the token never appears in a return
value or a surfaced error; every failure degrades to None (log-scan fallback),
never an exception into the loop/display."""
import json
import os
import subprocess
import sys
import unittest
from urllib.error import URLError

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

import claude_usage as cu  # noqa: E402

TOKEN = "sk-oauth-SECRET-TOKEN-do-not-leak"
BLOB = json.dumps({"claudeAiOauth": {"accessToken": TOKEN}})
GOOD_PAYLOAD = {
    "five_hour": {"utilization": 48.0, "resets_at": "2026-07-03T19:10:00+00:00"},
    "seven_day": {"utilization": 7.0, "resets_at": "2026-07-08T02:00:00+00:00"},
}


class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body if isinstance(body, bytes) else body.encode()

    def read(self):
        return self._body

    def close(self):
        pass


class TestReadToken(unittest.TestCase):
    def test_valid_blob(self):
        self.assertEqual(
            cu._read_oauth_token(runner=lambda: BLOB, platform="darwin"), TOKEN)

    def test_non_darwin_skips(self):
        self.assertIsNone(
            cu._read_oauth_token(runner=lambda: BLOB, platform="linux"))

    def test_missing_field(self):
        blob = json.dumps({"claudeAiOauth": {}})
        self.assertIsNone(
            cu._read_oauth_token(runner=lambda: blob, platform="darwin"))

    def test_bad_json(self):
        self.assertIsNone(
            cu._read_oauth_token(runner=lambda: "not json", platform="darwin"))

    def test_runner_none(self):
        self.assertIsNone(
            cu._read_oauth_token(runner=lambda: None, platform="darwin"))

    def test_runner_raises_is_none(self):
        def boom():
            raise RuntimeError("keychain hung")
        self.assertIsNone(
            cu._read_oauth_token(runner=boom, platform="darwin"))

    def test_runner_timeout_is_none(self):
        # a Keychain prompt/hang surfaces as TimeoutExpired -> must degrade, not
        # raise (the hard subprocess timeout keeps the sampler from stalling)
        def timeout():
            raise subprocess.TimeoutExpired(cmd="security", timeout=4)
        self.assertIsNone(
            cu._read_oauth_token(runner=timeout, platform="darwin"))


class TestFetchUsage(unittest.TestCase):
    def test_200_returns_dict(self):
        opener = lambda req, timeout=None: _FakeResp(200, json.dumps(GOOD_PAYLOAD))
        self.assertEqual(cu.fetch_usage(TOKEN, opener=opener), GOOD_PAYLOAD)

    def test_non_200_is_none(self):
        opener = lambda req, timeout=None: _FakeResp(401, "nope")
        self.assertIsNone(cu.fetch_usage(TOKEN, opener=opener))

    def test_opener_raises_is_none(self):
        def opener(req, timeout=None):
            raise URLError("timed out")
        self.assertIsNone(cu.fetch_usage(TOKEN, opener=opener))

    def test_non_json_is_none(self):
        opener = lambda req, timeout=None: _FakeResp(200, "<html>oops")
        self.assertIsNone(cu.fetch_usage(TOKEN, opener=opener))

    def test_empty_token_is_none(self):
        called = []
        cu.fetch_usage("", opener=lambda *a, **k: called.append(1))
        self.assertEqual(called, [])

    def test_token_never_leaks(self):
        # a failing fetch must not surface the token in its result
        opener = lambda req, timeout=None: _FakeResp(500, "err")
        self.assertNotIn(TOKEN, json.dumps(cu.fetch_usage(TOKEN, opener=opener)))


class TestMapWindow(unittest.TestCase):
    def test_percent_to_fraction(self):
        w = cu._map_window({"utilization": 48.0,
                            "resets_at": "2026-07-03T19:10:00+00:00"})
        self.assertAlmostEqual(w["utilization"], 0.48)
        self.assertIsInstance(w["resets_at"], int)

    def test_non_dict_none(self):
        self.assertIsNone(cu._map_window("x"))

    def test_string_utilization_none(self):
        self.assertIsNone(cu._map_window({"utilization": "48",
                                          "resets_at": "2026-07-03T19:10:00+00:00"}))

    def test_negative_utilization_none(self):
        self.assertIsNone(cu._map_window({"utilization": -1.0,
                                          "resets_at": "2026-07-03T19:10:00+00:00"}))

    def test_garbage_reset_none(self):
        self.assertIsNone(cu._map_window({"utilization": 5.0, "resets_at": "nope"}))

    def test_z_suffix_reset_parses(self):
        # a trailing 'Z' (common JSON form) must parse on every Python version,
        # not silently null the window
        w = cu._map_window({"utilization": 10.0, "resets_at": "2026-07-03T19:10:00Z"})
        self.assertIsNotNone(w)
        self.assertEqual(cu._iso_to_epoch("2026-07-03T19:10:00Z"),
                         cu._iso_to_epoch("2026-07-03T19:10:00+00:00"))


class TestLiveQuota(unittest.TestCase):
    def setUp(self):
        cu.reset_cache()

    def test_happy_path_source_live(self):
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN,
                              fetcher=lambda t: GOOD_PAYLOAD)
        v = cu.live_quota()
        self.assertEqual(v["source"], "live")
        self.assertAlmostEqual(v["five_hour"]["utilization"], 0.48)
        self.assertAlmostEqual(v["seven_day"]["utilization"], 0.07)

    def test_fetch_none_caches_none(self):
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN,
                              fetcher=lambda t: None)
        self.assertIsNone(cu.live_quota())

    def test_one_window_missing_is_none(self):
        payload = {"five_hour": GOOD_PAYLOAD["five_hour"]}  # no seven_day
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN,
                              fetcher=lambda t: payload)
        self.assertIsNone(cu.live_quota())

    def test_self_throttle_within_ttl(self):
        calls = []
        reads = []
        fetch = lambda t: (calls.append(1) or GOOD_PAYLOAD)
        read = lambda: (reads.append(1) or TOKEN)
        cu.refresh_live_quota(now=1000, token_reader=read, fetcher=fetch)
        cu.refresh_live_quota(now=1030, token_reader=read, fetcher=fetch)  # <60s
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(reads), 1)  # token not even read while throttled

    def test_refetch_after_ttl(self):
        calls = []
        fetch = lambda t: (calls.append(1) or GOOD_PAYLOAD)
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN, fetcher=fetch)
        cu.refresh_live_quota(now=1061, token_reader=lambda: TOKEN, fetcher=fetch)
        self.assertEqual(len(calls), 2)

    def test_live_quota_is_pure_read(self):
        # live_quota must never do I/O -- cold cache returns None, no fetch
        self.assertIsNone(cu.live_quota())

    def test_token_never_in_outward_value(self):
        # the dashboard-facing value (live_quota) must never carry the token,
        # even when a token was read to produce it
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN,
                              fetcher=lambda t: GOOD_PAYLOAD)
        self.assertNotIn(TOKEN, json.dumps(cu.live_quota()))

    def test_exception_clears_stale_live(self):
        # fail-safe never fail-open: after a good live value is cached, a later
        # refresh whose fetcher RAISES must replace it with None (fallback),
        # not leave stale-live data, and must not propagate the exception
        cu.refresh_live_quota(now=1000, token_reader=lambda: TOKEN,
                              fetcher=lambda t: GOOD_PAYLOAD)
        self.assertIsNotNone(cu.live_quota())

        def boom(_t):
            raise RuntimeError("endpoint changed shape")
        cu.refresh_live_quota(now=1100, token_reader=lambda: TOKEN, fetcher=boom)
        self.assertIsNone(cu.live_quota())


if __name__ == "__main__":
    unittest.main()
