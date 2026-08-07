"""Unit tests for lib/health.py -- the wedged-truth module (#81 / SD-32 §9).

The wedged rule: a WORKING session (heartbeat phase `session-running`) whose
newest session-log/heartbeat write is older than a threshold (default 15 min,
`health.wedged_after`) is wedged. Engine-owned artifacts only -- no process
introspection. Fail-safe: unreadable liveness storage reads as 'unknown' (the
caller WARNs), NEVER as healthy; a legitimately-idle loop (board-empty/pace-
wait/limit-backoff, which sleep up to EMPTY_IDLE) is never a false wedged.

The pure classify() matrix is fixture-free; loop_health() is exercised on real
temp files (genuine I/O, no mocks).
"""
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import health as h  # noqa: E402


def _hb(phase, ts):
    return {"ts": ts, "phase": phase, "until": 0, "reason": ""}


class TestClassifyMatrix(unittest.TestCase):
    """The pure decision -- parsed heartbeat + newest session epoch -> state."""

    def test_no_heartbeat_is_unknown(self):
        # can't read the phase -> never claim healthy (fail-safe, not fail-open).
        for hb in (None, {}):
            r = h.classify(hb, None, now=1_000_000)
            self.assertEqual(r["state"], "unknown")

    def test_idle_phase_never_wedged_even_when_stale(self):
        # CP1 finding 1/5: an alive loop legitimately sleeps up to EMPTY_IDLE in
        # these phases and writes nothing -- must NOT read as wedged at 15m.
        for phase in ("board-empty", "pace-wait", "limit-backoff",
                      "polling-events", "cron-check", "dispatching coder",
                      "preflight-hold", "idle", "paused"):
            r = h.classify(_hb(phase, ts=0), newest_session_epoch=0,
                           now=10_000)  # ~2.7h stale
            self.assertEqual(r["state"], "idle", phase)

    def test_working_fresh_is_ok(self):
        r = h.classify(_hb("session-running coder", ts=100),
                       newest_session_epoch=900, now=1000, wedged_after=900)
        self.assertEqual(r["state"], "ok")

    def test_working_stale_is_wedged(self):
        r = h.classify(_hb("session-running coder", ts=0),
                       newest_session_epoch=0, now=1000, wedged_after=900)
        self.assertEqual(r["state"], "wedged")
        self.assertEqual(r["age"], 1000)

    def test_boundary_equal_threshold_is_ok(self):
        # age == threshold is not yet wedged; age > threshold is.
        r = h.classify(_hb("session-running coder", ts=0),
                       newest_session_epoch=0, now=900, wedged_after=900)
        self.assertEqual(r["state"], "ok")
        r2 = h.classify(_hb("session-running coder", ts=0),
                        newest_session_epoch=0, now=901, wedged_after=900)
        self.assertEqual(r2["state"], "wedged")

    def test_session_log_mtime_dominates_stale_heartbeat_ts(self):
        # the session-running heartbeat ts is written ONCE at session start; a
        # long healthy session keeps its session log fresh -> not wedged.
        r = h.classify(_hb("session-running coder", ts=0),
                       newest_session_epoch=1500, now=1600, wedged_after=900)
        self.assertEqual(r["state"], "ok")

    def test_working_no_timestamp_is_unknown(self):
        r = h.classify({"phase": "session-running coder"},  # no ts key
                       newest_session_epoch=None, now=1000)
        self.assertEqual(r["state"], "unknown")

    def test_bad_threshold_coerces_to_default(self):
        # a misconfig (<=0 or non-int) must not make everything wedged.
        for bad in (0, -5, "nope", None):
            r = h.classify(_hb("session-running coder", ts=0),
                           newest_session_epoch=0,
                           now=h.DEFAULT_WEDGED_AFTER,  # == default -> ok
                           wedged_after=bad)
            self.assertEqual(r["state"], "ok", repr(bad))
            self.assertEqual(r["wedged_after"], h.DEFAULT_WEDGED_AFTER)

    def test_result_shape(self):
        r = h.classify(_hb("session-running coder", ts=0), 0, now=2000,
                       wedged_after=900)
        self.assertEqual(set(r), {"state", "phase", "age", "wedged_after",
                                  "reason"})
        self.assertEqual(r["phase"], "session-running coder")
        self.assertTrue(r["reason"])


class TestReadHeartbeat(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _write(self, text):
        with open(os.path.join(self.tmp, "heartbeat"), "w") as fh:
            fh.write(text)

    def test_absent_is_none(self):
        self.assertIsNone(h.read_heartbeat(self.tmp))

    def test_valid_line(self):
        self._write("1720000000\tsession-running coder\t0\trunning\n")
        r = h.read_heartbeat(self.tmp)
        self.assertEqual(r["ts"], 1720000000)
        self.assertEqual(r["phase"], "session-running coder")

    def test_torn_line_is_none(self):
        self._write("not\tenough\n")           # < 4 fields
        self.assertIsNone(h.read_heartbeat(self.tmp))

    def test_non_int_ts_is_none(self):
        self._write("xx\tsession-running\t0\tr\n")
        self.assertIsNone(h.read_heartbeat(self.tmp))


class TestNewestSessionEpoch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _touch(self, name, mtime):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh:
            fh.write("x")
        os.utime(p, (mtime, mtime))

    def test_none_when_no_session_logs(self):
        self._touch("supervisor.log", 500)     # not a session-*.log
        self.assertIsNone(h.newest_session_epoch(self.tmp))

    def test_picks_newest(self):
        self._touch("session-20260101T000000.log", 1000)
        self._touch("session-20260102T000000.log", 5000)
        self.assertEqual(h.newest_session_epoch(self.tmp), 5000)

    def test_absent_dir_is_none(self):
        self.assertIsNone(h.newest_session_epoch(os.path.join(self.tmp, "nope")))


class TestLoopHealthIntegration(unittest.TestCase):
    """End-to-end on real temp files -- no mocks."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _heartbeat(self, phase, ts):
        with open(os.path.join(self.tmp, "heartbeat"), "w") as fh:
            fh.write("%d\t%s\t0\trunning\n" % (ts, phase))

    def _session(self, name, mtime):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh:
            fh.write("x")
        os.utime(p, (mtime, mtime))

    def test_absent_logdir_is_unknown(self):
        r = h.loop_health(os.path.join(self.tmp, "nope"), now=time.time())
        self.assertEqual(r["state"], "unknown")

    def test_idle_loop_not_wedged(self):
        self._heartbeat("board-empty", ts=0)
        r = h.loop_health(self.tmp, now=1_000_000)
        self.assertEqual(r["state"], "idle")

    def test_working_stale_session_is_wedged(self):
        self._heartbeat("session-running coder", ts=1000)
        self._session("session-20260101T000000.log", 1000)
        r = h.loop_health(self.tmp, now=1000 + 2000, wedged_after=900)
        self.assertEqual(r["state"], "wedged")

    def test_working_fresh_session_is_ok(self):
        self._heartbeat("session-running coder", ts=1000)
        self._session("session-20260101T000000.log", 2900)
        r = h.loop_health(self.tmp, now=3000, wedged_after=900)
        self.assertEqual(r["state"], "ok")


if __name__ == "__main__":
    unittest.main()
