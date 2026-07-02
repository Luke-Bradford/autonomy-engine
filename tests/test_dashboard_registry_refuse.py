"""#59: the config-page write handlers must surface a corrupt account/
credential registry as a clean {ok: False} refusal -- NOT a traceback.

The registry modules raise RegistryError (a RuntimeError, not ValueError/
OSError) on a corrupt index; several handlers previously caught only OSError,
so without the added catch a corrupt-index delete/unassign would escape the
handler and 500 the request. These tests import the real bin/dashboard.py and
inject registries backed by a corrupt temp index via the singleton seams."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import accounts as accts  # noqa: E402
import credentials as creds  # noqa: E402
import dashboard  # noqa: E402


class _MemStore:
    def __init__(self):
        self._d = {}
    def get(self, label):
        return self._d.get(label)
    def set(self, label, secret):
        self._d[label] = secret
    def delete(self, label):
        self._d.pop(label, None)


class _FakeCreds:
    def get_secret(self, label):
        return None


class TestCorruptRegistryHandlers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.acct_index = os.path.join(self.tmp, "accounts")
        self.cred_index = os.path.join(self.tmp, "credentials.json")
        # A corrupt (unparseable) index on both.
        Path(self.acct_index).write_text('{"accounts": broken')
        Path(self.cred_index).write_text('{"credentials": broken')
        # Inject via the dashboard's singleton seams.
        dashboard._accts_singleton[0] = accts.Accounts(
            index_path=self.acct_index, credentials=_FakeCreds())
        dashboard._creds_singleton[0] = creds.Credentials(
            store=_MemStore(), index_path=self.cred_index)

    def tearDown(self):
        dashboard._accts_singleton[0] = None
        dashboard._creds_singleton[0] = None

    def _assert_refused(self, result):
        self.assertFalse(result["ok"])
        self.assertIn("unreadable", result["error"])

    def test_acct_set_refuses(self):
        self._assert_refused(
            dashboard.execute_acct_set("work", "claude_subscription", None))

    def test_acct_delete_refuses(self):
        self._assert_refused(dashboard.execute_acct_delete("work"))

    def test_cred_set_refuses(self):
        self._assert_refused(
            dashboard.execute_cred_set("work", "anthropic", "s3cret"))

    def test_cred_delete_refuses(self):
        self._assert_refused(dashboard.execute_cred_delete("work"))

    def test_cred_assign_refuses(self):
        self._assert_refused(dashboard.execute_cred_assign("pm", "work"))

    def test_cred_unassign_refuses(self):
        self._assert_refused(dashboard.execute_cred_unassign("pm"))


if __name__ == "__main__":
    unittest.main()
