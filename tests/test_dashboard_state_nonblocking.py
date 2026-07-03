"""#80 -- /api/state must not block the render on serial gh calls.

Drives the REAL dashboard functions; the only stubs are `_run` (the established
subprocess seam) and, where a test isolates the cache-policy wrapper from the
snapshot builder, `_compute_in_flight` / `ds.build_repo_state` (real function
boundaries this change introduces / already exposes). No assertions on mocks --
each test asserts an observable property of the real control flow (concurrency,
what value a caller receives, whether the cache updated, guard cleanup)."""
import os
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import dashboard  # noqa: E402
import dashboard_state as ds  # noqa: E402


def _refresh_threads(repo):
    name = "gh-refresh:" + repo
    return [t for t in threading.enumerate() if t.name == name]


def _join_refresh(repo, timeout=3.0):
    for t in _refresh_threads(repo):
        t.join(timeout)


class _Recorder(object):
    """Counts overlapping gh calls so a test can prove they run concurrently."""
    def __init__(self):
        self.lock = threading.Lock()
        self.inflight = 0
        self.max_inflight = 0

    def enter(self):
        with self.lock:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)

    def leave(self):
        with self.lock:
            self.inflight -= 1


def _fake_run(rec=None, gh_sleep=0.0, open_prs=None):
    """A stand-in for dashboard._run: local git calls answer instantly; gh calls
    optionally sleep + record concurrency and return canned JSON."""
    open_prs = open_prs if open_prs is not None else []

    def run(args, cwd=None, timeout=12):
        if args and args[0] == "git":
            if "rev-parse" in args and "--abbrev-ref" in args:
                return "main"
            if "rev-parse" in args and "--short" in args:
                return "abc123"
            if "status" in args:
                return ""
            return ""
        # gh
        if rec is not None:
            rec.enter()
        try:
            if gh_sleep:
                time.sleep(gh_sleep)
            if args[1] == "repo":
                return "https://example.test/x/y"
            if args[1] == "pr" and "open" in args:
                import json
                return json.dumps(open_prs)
            if args[1] == "pr" and "merged" in args:
                return "[]"
            return ""
        finally:
            if rec is not None:
                rec.leave()
    return run


class NonBlockingState(unittest.TestCase):
    def setUp(self):
        self._run = dashboard._run
        self._compute = dashboard._compute_in_flight
        self._build = ds.build_repo_state
        with dashboard._gh_lock:
            dashboard._gh_cache.clear()
            dashboard._gh_refreshing.clear()

    def tearDown(self):
        dashboard._run = self._run
        dashboard._compute_in_flight = self._compute
        ds.build_repo_state = self._build
        _join_refresh("/repo")
        with dashboard._gh_lock:
            dashboard._gh_cache.clear()
            dashboard._gh_refreshing.clear()

    def test_gh_calls_run_concurrently(self):
        # `max_inflight >= 2` is the structural proof of overlap; the gh_sleep
        # only holds the calls in-flight together long enough for the recorder
        # to observe it. No wall-clock threshold here on purpose (#108) -- an
        # `elapsed < X` assertion is the classic load-flake and adds nothing the
        # inflight counter doesn't already guarantee.
        rec = _Recorder()
        dashboard._run = _fake_run(rec=rec, gh_sleep=0.15)
        res = dashboard._compute_in_flight("/repo")
        self.assertGreaterEqual(rec.max_inflight, 2, "gh calls did not overlap")
        self.assertEqual(res["branch"], "main")

    def test_cold_load_blocks_and_returns_real_data(self):
        dashboard._run = _fake_run(open_prs=[{
            "number": 7, "title": "t", "headRefName": "b",
            "isDraft": False, "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED", "statusCheckRollup": [],
            "url": "u", "updatedAt": "2026-07-03T00:00:00Z"}])
        res = dashboard.git_in_flight("/repo")
        self.assertEqual(res["branch"], "main")
        self.assertEqual([p["number"] for p in res["prs"]], [7])
        # cold path populates the cache synchronously
        with dashboard._gh_lock:
            self.assertIn("/repo", dashboard._gh_cache)

    def test_stale_served_instantly_then_background_refresh(self):
        stale = {"branch": "old", "prs": [], "merged": [], "sha": "",
                 "dirty": False, "repo_url": "", "focus_ticket": None}
        with dashboard._gh_lock:
            dashboard._gh_cache["/repo"] = (time.time() - 20.0, stale)
        gate = threading.Event()

        def blocking_compute(repo):
            gate.wait(3.0)
            return {"branch": "fresh", "prs": [], "merged": [], "sha": "",
                    "dirty": False, "repo_url": "", "focus_ticket": None}
        dashboard._compute_in_flight = blocking_compute

        got = dashboard.git_in_flight("/repo")
        self.assertEqual(got["branch"], "old", "stale value not served instantly")
        self.assertEqual(len(_refresh_threads("/repo")), 1, "no bg refresh spawned")

        gate.set()
        _join_refresh("/repo")
        with dashboard._gh_lock:
            self.assertEqual(dashboard._gh_cache["/repo"][1]["branch"], "fresh")
            self.assertNotIn("/repo", dashboard._gh_refreshing)

    def test_concurrent_stale_callers_single_flight(self):
        stale = {"branch": "old", "prs": [], "merged": [], "sha": "",
                 "dirty": False, "repo_url": "", "focus_ticket": None}
        with dashboard._gh_lock:
            dashboard._gh_cache["/repo"] = (time.time() - 20.0, stale)
        gate = threading.Event()

        def blocking_compute(repo):
            gate.wait(3.0)
            return stale
        dashboard._compute_in_flight = blocking_compute

        for _ in range(4):
            dashboard.git_in_flight("/repo")
        self.assertEqual(len(_refresh_threads("/repo")), 1,
                         "single-flight violated: multiple refresh threads")
        gate.set()
        _join_refresh("/repo")

    def test_failed_refresh_clears_guard_and_allows_retry(self):
        stale = {"branch": "old", "prs": [], "merged": [], "sha": "",
                 "dirty": False, "repo_url": "", "focus_ticket": None}
        with dashboard._gh_lock:
            dashboard._gh_cache["/repo"] = (time.time() - 20.0, stale)

        def boom(repo):
            raise RuntimeError("gh exploded")
        dashboard._compute_in_flight = boom
        dashboard.git_in_flight("/repo")   # spawns a refresh that raises
        _join_refresh("/repo")
        with dashboard._gh_lock:
            self.assertNotIn("/repo", dashboard._gh_refreshing,
                             "guard not cleared after a failed refresh")
            self.assertIn("/repo", dashboard._gh_cache, "stale entry was dropped")

        # the guard is clear, so a later stale call can retry
        def ok(repo):
            return {"branch": "recovered", "prs": [], "merged": [], "sha": "",
                    "dirty": False, "repo_url": "", "focus_ticket": None}
        dashboard._compute_in_flight = ok
        dashboard.git_in_flight("/repo")
        _join_refresh("/repo")
        with dashboard._gh_lock:
            self.assertEqual(dashboard._gh_cache["/repo"][1]["branch"], "recovered")

    def test_cold_callers_coalesce_to_single_compute(self):
        # the single-writer guarantee (no concurrent/out-of-order cache writes):
        # a cold /api/state fetch + first SSE tick must share ONE compute, not
        # race two writers.
        calls = [0]
        started = threading.Event()
        release = threading.Event()

        def counting_compute(repo):
            calls[0] += 1
            started.set()
            release.wait(3.0)
            return {"branch": "fresh", "prs": [], "merged": [], "sha": "",
                    "dirty": False, "repo_url": "", "focus_ticket": None}
        dashboard._compute_in_flight = counting_compute

        outs = []
        threads = [threading.Thread(
            target=lambda: outs.append(dashboard.git_in_flight("/repo")))
            for _ in range(3)]
        for t in threads:
            t.start()
        started.wait(2.0)        # first compute is running; others must coalesce
        release.set()
        for t in threads:
            t.join(3.0)
        self.assertEqual(calls[0], 1, "cold callers did not coalesce (%d computes)" % calls[0])
        self.assertEqual([o["branch"] for o in outs], ["fresh"] * 3)

    def test_too_stale_blocks_instead_of_serving(self):
        old = {"branch": "ancient", "prs": [], "merged": [], "sha": "",
               "dirty": False, "repo_url": "", "focus_ticket": None}
        with dashboard._gh_lock:
            dashboard._gh_cache["/repo"] = (
                time.time() - (dashboard._GH_MAX_STALE + 10.0), old)

        def fresh(repo):
            return {"branch": "current", "prs": [], "merged": [], "sha": "",
                    "dirty": False, "repo_url": "", "focus_ticket": None}
        dashboard._compute_in_flight = fresh
        got = dashboard.git_in_flight("/repo")
        self.assertEqual(got["branch"], "current",
                         "data older than MAX_STALE was served instead of refreshed")
        self.assertEqual(len(_refresh_threads("/repo")), 0)

    def test_collect_parallelises_repos_and_preserves_order(self):
        dirs = [tempfile.mkdtemp() for _ in range(3)]
        self.addCleanup(lambda: [os.rmdir(d) for d in dirs])

        # Prove concurrency structurally, not by wall-clock (#108): a Barrier of
        # N parties can only be crossed once all N repo-builds are genuinely
        # in-flight at the same instant, so `max_inflight == N` is exact and
        # needs no timing threshold -- it cannot flake when a loaded box
        # schedules the threads unevenly. The generous barrier timeout only
        # bites on a real serial regression (builds that never overlap), which
        # then trips the max_inflight assertion below.
        rec = _Recorder()
        barrier = threading.Barrier(len(dirs), timeout=5.0)

        def slow_build(repo, git_in_flight=None):
            rec.enter()
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass  # serial regression: the builds never overlapped
            finally:
                rec.leave()
            return {"name": os.path.basename(repo), "path": repo,
                    "git": {}, "current_session": None,
                    "display_status": "idle"}
        ds.build_repo_state = slow_build
        # isolate repo-build parallelism from the (slow, ~1000-file) account scan
        with dashboard._acct_lock:
            dashboard._acct_cache[0] = time.time()
            dashboard._acct_cache[1] = {}

        snap = dashboard.collect(dirs)
        self.assertEqual(rec.max_inflight, len(dirs),
                         "repos built serially: %d of %d overlapped"
                         % (rec.max_inflight, len(dirs)))
        self.assertEqual([r["path"] for r in snap["repos"]], dirs,
                         "collect did not preserve repo order")


if __name__ == "__main__":
    unittest.main()
