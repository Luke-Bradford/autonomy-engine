"""Unit tests for lib/settings.py -- machine-local engine settings (the port)."""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

import settings  # noqa: E402


class TestSettings(unittest.TestCase):
    def _write(self, text):
        fd, path = tempfile.mkstemp()
        self.addCleanup(os.remove, path)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        return path

    def test_read_parses_key_value_ignoring_comments_and_junk(self):
        d = settings.read(self._write(
            "# a comment\nport = 9090\n\nname=alice\nno-equals-line\n= empty key\n"))
        self.assertEqual(d["port"], "9090")
        self.assertEqual(d["name"], "alice")
        self.assertNotIn("no-equals-line", d)
        self.assertNotIn("", d)               # empty-key line dropped

    def test_absent_file_is_empty(self):
        self.assertEqual(settings.read("/no/such/settings/file"), {})

    def test_port_from_settings(self):
        self.assertEqual(settings.port(path=self._write("port = 9099")), 9099)

    def test_port_default_when_unset(self):
        self.assertEqual(settings.port(path=self._write("name = x")), 8787)

    def test_port_default_on_non_integer(self):
        self.assertEqual(settings.port(path=self._write("port = abc")), 8787)

    def test_port_default_out_of_range(self):
        self.assertEqual(settings.port(path=self._write("port = 99999")), 8787)
        self.assertEqual(settings.port(path=self._write("port = 0")), 8787)

    def test_get_returns_default(self):
        self.assertEqual(settings.get("missing", "d", path=self._write("")), "d")


if __name__ == "__main__":
    unittest.main()
