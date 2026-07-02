"""Unit tests for lib/accounts.py -- the named-account registry (#agent-org increment 1).
An account classifies an auth instance: a subscription (no secret) or an API kind
that points at a credentials.py Keychain label. The index holds names/kinds/labels
only -- never a secret. Tests inject a fake credentials object + a temp index."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import accounts as ac  # noqa: E402


class FakeCreds:
    """Stand-in for credentials.Credentials -- only get_secret is used."""
    def __init__(self, secrets=None):
        self._s = secrets or {}
    def get_secret(self, label):
        return self._s.get(label)


class TestAccountsCrud(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.a = ac.Accounts(index_path=self.index, credentials=FakeCreds())

    def test_set_subscription_then_list(self):
        self.a.set("claude-sub", "claude_subscription")
        entries = self.a.list()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["name"], "claude-sub")
        self.assertEqual(e["kind"], "claude_subscription")
        self.assertIsNone(e["credential"])
        self.assertFalse(e["has_credential"])

    def test_set_api_kind_requires_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("work", "anthropic_api")            # no credential -> reject
        self.a.set("work", "anthropic_api", credential="work-key")
        self.assertEqual(self.a.get("work"), {"kind": "anthropic_api", "credential": "work-key"})

    def test_subscription_kind_forbids_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("claude-sub", "claude_subscription", credential="oops")

    def test_bad_name_and_kind_rejected(self):
        with self.assertRaises(ValueError):
            self.a.set("has space", "claude_subscription")
        with self.assertRaises(ValueError):
            self.a.set("x", "not_a_kind")

    def test_set_upserts(self):
        self.a.set("work", "anthropic_api", credential="k1")
        self.a.set("work", "openai_api", credential="k2")   # re-point same name
        self.assertEqual(self.a.get("work"), {"kind": "openai_api", "credential": "k2"})
        self.assertEqual(len(self.a.list()), 1)

    def test_delete_is_idempotent(self):
        self.a.set("work", "claude_subscription")
        self.a.delete("work")
        self.assertEqual(self.a.list(), [])
        self.a.delete("work")   # no raise

    def test_index_is_600_and_has_no_secret(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        mode = stat.S_IMODE(os.stat(self.index).st_mode)
        self.assertEqual(mode, 0o600)
        raw = Path(self.index).read_text()
        self.assertIn("work", raw)          # name + label are fine
        self.assertIn("anthropic_api", raw)
        self.assertNotIn("sk-", raw)        # no secret material ever

    def test_missing_index_is_empty(self):
        a = ac.Accounts(index_path=os.path.join(self.tmp, "absent"), credentials=FakeCreds())
        self.assertEqual(a.list(), [])
        self.assertIsNone(a.get("nope"))


class TestResolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.creds = FakeCreds({"work-key": "sk-ant-SECRET", "oai": "sk-openai-SECRET"})
        self.a = ac.Accounts(index_path=self.index, credentials=self.creds)

    def test_subscription_exports_nothing(self):
        self.a.set("claude-sub", "claude_subscription")
        r = self.a.resolve("claude-sub")
        self.assertEqual(r, {"kind": "claude_subscription", "env": {}})

    def test_anthropic_api_exports_key(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        r = self.a.resolve("work")
        self.assertEqual(r["kind"], "anthropic_api")
        self.assertEqual(r["env"], {"ANTHROPIC_API_KEY": "sk-ant-SECRET"})

    def test_openai_api_exports_key(self):
        self.a.set("side", "openai_api", credential="oai")
        self.assertEqual(self.a.resolve("side")["env"], {"OPENAI_API_KEY": "sk-openai-SECRET"})

    def test_unknown_account_raises_keyerror(self):
        with self.assertRaises(KeyError):
            self.a.resolve("ghost")

    def test_api_with_missing_secret_raises_lookuperror(self):
        # credential label present in the index but the Keychain has no secret
        self.a.set("stale", "anthropic_api", credential="gone")
        with self.assertRaises(LookupError):
            self.a.resolve("stale")


class TestCli(unittest.TestCase):
    """_main returns clean exit codes and prints resolve env as VAR=value
    lines for bash consumers. Patch Accounts to a temp index + fake creds so
    the CLI never touches the real Keychain."""
    def _run(self, argv, secrets=None):
        import io
        tmp = tempfile.mkdtemp()
        orig = ac.Accounts.__init__
        def patched(self, index_path=None, credentials=None):
            orig(self, index_path=os.path.join(tmp, "accounts"),
                 credentials=FakeCreds(secrets or {}))
        ac.Accounts.__init__ = patched
        out, err = io.StringIO(), io.StringIO()
        so, se = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            rc = ac._main(argv)
        finally:
            ac.Accounts.__init__ = orig
            sys.stdout, sys.stderr = so, se
        return rc, out.getvalue(), err.getvalue(), tmp

    def test_set_then_resolve_subscription_prints_nothing(self):
        # reuse one temp dir across two _main calls by pinning the index path
        import io
        tmp = tempfile.mkdtemp()
        idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds())
        try:
            self.assertEqual(ac._main(["set", "claude-sub", "claude_subscription"]), 0)
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "claude-sub"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "")   # subscription: no env lines

    def test_resolve_api_prints_var_line(self):
        import io
        tmp = tempfile.mkdtemp(); idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds({"k": "sk-ant-X"}))
        try:
            ac._main(["set", "work", "anthropic_api", "k"])
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "work"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "ANTHROPIC_API_KEY=sk-ant-X")

    def test_resolve_unknown_exits_1(self):
        rc, _out, _err, _tmp = self._run(["resolve", "ghost"])
        self.assertEqual(rc, 1)

    def test_bad_kind_exits_1(self):
        rc, _out, err, _tmp = self._run(["set", "x", "bogus_kind"])
        self.assertEqual(rc, 1)
        self.assertIn("kind", err)


if __name__ == "__main__":
    unittest.main()
