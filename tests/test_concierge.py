"""Unit tests for lib/concierge.py -- the local-LLM system-Q&A module. Pure
parts (context build, reply parse) tested directly; the one HTTP edge is tested
by mocking urlopen at the boundary (no real network)."""
import io
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

import concierge  # noqa: E402


class TestReplyText(unittest.TestCase):
    def test_wellformed(self):
        body = {"choices": [{"message": {"role": "assistant", "content": " hi "}}]}
        self.assertEqual(concierge._reply_text(body), "hi")

    def test_malformed_shapes_return_empty(self):
        for bad in ({}, {"choices": []}, {"choices": [{}]},
                    {"choices": [{"message": {"content": None}}]}, None, "x"):
            self.assertEqual(concierge._reply_text(bad), "")


class TestBuildContext(unittest.TestCase):
    def test_empty_repos(self):
        ctx = concierge.build_context([])
        self.assertIn("no repos registered", ctx)

    def test_summarises_loop_ticket_and_quota(self):
        repos = [{
            "repo": "/w/engine",
            "loop": {"state": "running"},
            "session": {"ticket": "87", "step": "editing config"},
            "quota": {"five_hour": {"utilization": 0.0},
                      "seven_day": {"utilization": 0.63}},
            "open_issues": 11,
        }]
        ctx = concierge.build_context(repos)
        self.assertIn("/w/engine", ctx)
        self.assertIn("loop running", ctx)
        self.assertIn("#87", ctx)
        self.assertIn("5h 0%", ctx)
        self.assertIn("7d 63%", ctx)
        self.assertIn("open issues: 11", ctx)

    def test_now_note_appended(self):
        self.assertIn("clock: X", concierge.build_context([], now_note="clock: X"))

    def test_defensive_on_odd_shapes(self):
        # missing/None fields must not raise -- the concierge can't be the thing
        # that breaks the dashboard.
        concierge.build_context([{"repo": "x"}, {}, {"loop": None, "quota": None}])


class TestChat(unittest.TestCase):
    def _fake_resp(self, obj):
        cm = mock.MagicMock()
        cm.__enter__.return_value = io.BytesIO(json.dumps(obj).encode())
        return cm

    def test_posts_to_chat_completions_and_returns_reply(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data.decode())
            return self._fake_resp(
                {"choices": [{"message": {"content": "the loop is running"}}]})

        with mock.patch.object(concierge.urllib.request, "urlopen", fake_urlopen):
            reply = concierge.chat("http://localhost:11434/v1", "qwen3:14b",
                                   "CTX", "is the loop alive?",
                                   history=[{"role": "user", "content": "hi"},
                                            {"role": "assistant", "content": "hello"}])
        self.assertEqual(reply, "the loop is running")
        self.assertTrue(captured["url"].endswith("/chat/completions"))
        roles = [m["role"] for m in captured["body"]["messages"]]
        # system context first, prior turns, then the new user message last
        self.assertEqual(roles[0], "system")
        self.assertEqual(roles[-1], "user")
        self.assertEqual(captured["body"]["messages"][-1]["content"],
                         "is the loop alive?")
        self.assertEqual(captured["body"]["model"], "qwen3:14b")

    def test_drops_bad_history_turns(self):
        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode())
            # a junk history turn (no content) must be filtered out
            self.assertNotIn(None, [m.get("content") for m in body["messages"]])
            return self._fake_resp({"choices": [{"message": {"content": "ok"}}]})

        with mock.patch.object(concierge.urllib.request, "urlopen", fake_urlopen):
            concierge.chat("http://x/v1", "m", "c", "q",
                           history=[{"role": "user", "content": None},
                                    {"role": "system", "content": "nope"}])


if __name__ == "__main__":
    unittest.main()
