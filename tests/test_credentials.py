"""Unit tests for lib/credentials.py -- the named-credential store (#51).

Secrets live in a keystore (macOS Keychain in prod); a non-secret JSON index
holds only labels, providers, timestamps, and role assignments. Tests inject
an in-memory keystore + a temp index so they never touch the real login
keychain or the operator's real config."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import credentials as cr  # noqa: E402


class MemoryStore:
    """Test double for the keychain: a plain dict, same 3-method contract."""
    def __init__(self):
        self._d = {}
    def get(self, label):
        return self._d.get(label)
    def set(self, label, secret):
        self._d[label] = secret
    def delete(self, label):
        self._d.pop(label, None)


class TestCredentials(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "credentials.json")
        self.store = MemoryStore()
        self.c = cr.Credentials(store=self.store, index_path=self.index)

    # --- set / list -----------------------------------------------------------
    def test_set_then_list_hides_secret(self):
        self.c.set("work", "sk-ant-SECRET123", provider="anthropic", now=1000)
        entries = self.c.list()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["label"], "work")
        self.assertEqual(e["provider"], "anthropic")
        self.assertEqual(e["created_at"], 1000)
        self.assertTrue(e["is_set"])
        # the secret must not appear anywhere in the listing
        self.assertNotIn("SECRET123", json.dumps(entries))

    def test_get_secret_returns_value(self):
        self.c.set("work", "sk-ant-SECRET123", provider="anthropic")
        self.assertEqual(self.c.get_secret("work"), "sk-ant-SECRET123")
        self.assertIsNone(self.c.get_secret("nope"))

    def test_set_upserts_keeps_created_at_updates_secret_and_provider(self):
        self.c.set("work", "old", provider="anthropic", now=1000)
        self.c.set("work", "new", provider="openai", now=2000)
        e = self.c.list()[0]
        self.assertEqual(e["created_at"], 1000)   # create time preserved
        self.assertEqual(e["provider"], "openai")
        self.assertEqual(self.c.get_secret("work"), "new")

    def test_bad_label_rejected(self):
        for bad in ("", "has space", "a/b", "x" * 65, "semi;colon"):
            with self.assertRaises(ValueError, msg=bad):
                self.c.set(bad, "s")

    def test_empty_secret_rejected(self):
        with self.assertRaises(ValueError):
            self.c.set("work", "")
        with self.assertRaises(ValueError):
            self.c.set("work", "   ")

    def test_bad_provider_rejected(self):
        with self.assertRaises(ValueError):
            self.c.set("work", "s", provider="not a provider!")

    # --- delete ---------------------------------------------------------------
    def test_delete_removes_everywhere(self):
        self.c.set("work", "s", provider="anthropic")
        self.c.assign("pm", "work")
        self.c.delete("work")
        self.assertEqual(self.c.list(), [])
        self.assertIsNone(self.c.get_secret("work"))
        self.assertIsNone(self.c.resolve_for_role("pm"))  # assignment cascaded

    def test_delete_unknown_is_noop(self):
        self.c.delete("nope")  # must not raise

    # --- role assignment ------------------------------------------------------
    def test_assign_then_resolve(self):
        self.c.set("work", "sk-secret", provider="anthropic")
        self.c.assign("pm", "work")
        self.assertEqual(self.c.resolve_for_role("pm"), "sk-secret")
        self.assertEqual(self.c.assignments()["pm"], "work")

    def test_assign_unknown_label_rejected(self):
        with self.assertRaises(KeyError):
            self.c.assign("pm", "ghost")

    def test_unassign(self):
        self.c.set("work", "s")
        self.c.assign("pm", "work")
        self.c.unassign("pm")
        self.assertIsNone(self.c.resolve_for_role("pm"))

    def test_resolve_unassigned_role_is_none(self):
        self.assertIsNone(self.c.resolve_for_role("researcher"))

    # --- index file hygiene ---------------------------------------------------
    def test_index_file_never_contains_secret(self):
        self.c.set("work", "sk-ant-TOPSECRET", provider="anthropic")
        self.c.assign("pm", "work")
        raw = Path(self.index).read_text()
        self.assertNotIn("TOPSECRET", raw)
        self.assertIn("work", raw)          # label is fine
        self.assertIn("anthropic", raw)     # provider is fine

    def test_index_file_is_private(self):
        self.c.set("work", "s")
        mode = stat.S_IMODE(os.stat(self.index).st_mode)
        self.assertEqual(mode, 0o600)

    def test_reload_from_disk(self):
        self.c.set("work", "s", provider="anthropic", now=1000)
        self.c.assign("pm", "work")
        # fresh instance, same store + index -> state persists
        c2 = cr.Credentials(store=self.store, index_path=self.index)
        self.assertEqual(c2.list()[0]["label"], "work")
        self.assertEqual(c2.assignments()["pm"], "work")

    def test_missing_index_is_empty_not_error(self):
        c = cr.Credentials(store=MemoryStore(),
                           index_path=os.path.join(self.tmp, "absent.json"))
        self.assertEqual(c.list(), [])
        self.assertEqual(c.assignments(), {})

    def test_non_dict_index_degrades_to_empty_not_crash(self):
        # Valid JSON that isn't a dict (bare list/scalar) must degrade to an
        # empty index, NOT raise AttributeError out of _load()'s setdefault.
        Path(self.index).write_text("[]")
        self.assertEqual(self.c.list(), [])
        self.assertEqual(self.c.assignments(), {})
        Path(self.index).write_text("42")
        self.assertEqual(self.c.list(), [])
        # writes still work on top of the coerced-empty index
        self.c.set("work", "s", provider="anthropic", now=1000)
        self.assertEqual([e["label"] for e in self.c.list()], ["work"])


class TestCliErrors(unittest.TestCase):
    """PR #52 review: a failing `security` subprocess must exit 1 cleanly,
    not crash the CLI with a traceback."""
    def test_set_keychain_failure_is_clean_exit_1(self):
        import io
        import subprocess as sp

        class BoomStore:
            def get(self, label):
                return None
            def set(self, label, secret):
                raise sp.CalledProcessError(1, "security", stderr="keychain locked")
            def delete(self, label):
                pass

        tmp = tempfile.mkdtemp()
        orig_init = cr.Credentials.__init__

        def patched(self, store=None, index_path=None):
            orig_init(self, store=BoomStore(),
                      index_path=os.path.join(tmp, "credentials.json"))

        cr.Credentials.__init__ = patched
        orig_stdin, orig_stderr = sys.stdin, sys.stderr
        sys.stdin = io.StringIO("sk-secret\n")
        sys.stderr = io.StringIO()
        try:
            rc = cr._main(["set", "work"])
            err = sys.stderr.getvalue()
        finally:
            cr.Credentials.__init__ = orig_init
            sys.stdin, sys.stderr = orig_stdin, orig_stderr
        self.assertEqual(rc, 1)
        self.assertIn("keychain", err.lower())


if __name__ == "__main__":
    unittest.main()
