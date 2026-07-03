"""Unit tests for the dashboard logic-module hot-reload (#166).

Merged fixes to the dashboard's logic modules must go live in the running
process without a restart. The reload uses build-fresh (module_from_spec +
exec_module into a brand-new object) + atomic name-rebind publish, NOT in-place
importlib.reload -- so concurrent readers see one coherent epoch, a failing
build rolls back cleanly, and names deleted in the new source do not persist.

These tests drive the real `dashboard._reload_tracked` against temp module
files they write / edit / re-stat -- genuine exec_module semantics, no mocks.
"""
import importlib
import os
import sys
import tempfile
import textwrap
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))

import dashboard  # noqa: E402


def _write(path, body):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(textwrap.dedent(body))
    # bump mtime so a same-second edit still registers a new signature
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


class HotReloadCore(unittest.TestCase):
    """Exercise the injected-namespace core _reload_tracked(specs, sigs, ns, hook)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hotreload-")
        # a unique module name per test so sys.modules doesn't leak between them
        self.name = "hotreload_probe_%d" % (int(time.time() * 1e6) % 10_000_000)
        self.path = os.path.join(self.dir, self.name + ".py")
        self.addCleanup(lambda: sys.modules.pop(self.name, None))

    def _install(self, body):
        """Write + import the probe module the way dashboard imports lib/*."""
        _write(self.path, body)
        spec = importlib.util.spec_from_file_location(self.name, self.path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[self.name] = mod
        spec.loader.exec_module(mod)
        return mod

    def test_new_code_goes_live_and_global_rebinds(self):
        mod = self._install("VALUE = 1\ndef v():\n    return VALUE\n")
        ns = {"probe": mod}
        sigs = {self.name: dashboard._file_sig(self.path)}
        specs = [(self.name, self.path, "probe")]
        # no change yet -> no-op
        self.assertFalse(dashboard._reload_tracked(specs, sigs, ns, lambda: None))
        self.assertIs(ns["probe"], mod)
        # edit source, reload -> new code live, global rebound to a NEW object
        _write(self.path, "VALUE = 2\ndef v():\n    return VALUE\n")
        self.assertTrue(dashboard._reload_tracked(specs, sigs, ns, lambda: None))
        self.assertIsNot(ns["probe"], mod)
        self.assertEqual(ns["probe"].v(), 2)

    def test_removed_name_does_not_persist(self):
        mod = self._install("X = 'gone'\nKEEP = 1\n")
        ns = {"probe": mod}
        sigs = {self.name: dashboard._file_sig(self.path)}
        specs = [(self.name, self.path, "probe")]
        _write(self.path, "KEEP = 2\n")           # X removed
        self.assertTrue(dashboard._reload_tracked(specs, sigs, ns, lambda: None))
        self.assertFalse(hasattr(ns["probe"], "X"),
                         "a name deleted in the new source must not persist")
        self.assertEqual(ns["probe"].KEEP, 2)

    def test_failed_build_is_atomic_and_retries(self):
        mod = self._install("VALUE = 1\n")
        ns = {"probe": mod}
        sigs = {self.name: dashboard._file_sig(self.path)}
        specs = [(self.name, self.path, "probe")]
        hits = []
        # new source raises at top level -> reload fails, old object stays live,
        # sig NOT advanced (so it retries), and sys.modules keeps the old object.
        _write(self.path, "raise RuntimeError('boom at import')\n")
        self.assertFalse(dashboard._reload_tracked(specs, sigs, ns, lambda: hits.append(1)))
        self.assertIs(ns["probe"], mod, "failed build must not publish")
        self.assertIs(sys.modules[self.name], mod, "sys.modules must roll back")
        self.assertEqual(hits, [], "on_reload hook must not fire on failure")
        # fix the source -> next reload recovers (proves sig was left pending)
        _write(self.path, "VALUE = 3\n")
        self.assertTrue(dashboard._reload_tracked(specs, sigs, ns, lambda: hits.append(1)))
        self.assertEqual(ns["probe"].VALUE, 3)
        self.assertEqual(hits, [1], "on_reload hook fires once, on success")

    def test_whole_set_all_or_nothing(self):
        a = self._install("A = 1\n")
        # a second probe module in the same set
        name_b = self.name + "_b"
        path_b = os.path.join(self.dir, name_b + ".py")
        self.addCleanup(lambda: sys.modules.pop(name_b, None))
        _write(path_b, "B = 1\n")
        spec_b = importlib.util.spec_from_file_location(name_b, path_b)
        b = importlib.util.module_from_spec(spec_b)
        sys.modules[name_b] = b
        spec_b.loader.exec_module(b)

        ns = {"a": a, "b": b}
        sigs = {self.name: dashboard._file_sig(self.path),
                name_b: dashboard._file_sig(path_b)}
        specs = [(self.name, self.path, "a"), (name_b, path_b, "b")]
        # first builds fine, SECOND raises -> neither is published
        _write(self.path, "A = 2\n")
        _write(path_b, "raise ValueError('second fails')\n")
        self.assertFalse(dashboard._reload_tracked(specs, sigs, ns, lambda: None))
        self.assertIs(ns["a"], a, "first module must not publish if a later one fails")
        self.assertIs(ns["b"], b)
        self.assertIs(sys.modules[self.name], a)
        self.assertIs(sys.modules[name_b], b)

    def test_none_global_key_publishes_to_sys_modules_only(self):
        # roles has no dashboard global -> gkey None: republished into
        # sys.modules but no namespace entry touched.
        mod = self._install("R = 1\n")
        ns = {}
        sigs = {self.name: dashboard._file_sig(self.path)}
        specs = [(self.name, self.path, None)]
        _write(self.path, "R = 2\n")
        self.assertTrue(dashboard._reload_tracked(specs, sigs, ns, lambda: None))
        self.assertEqual(ns, {}, "gkey None must not add a namespace entry")
        self.assertEqual(sys.modules[self.name].R, 2)


class HotReloadWiring(unittest.TestCase):
    """The production wiring points at the real tracked set + singleton reset."""

    def test_tracked_set_covers_the_logic_modules(self):
        names = [s[0] for s in dashboard._HOT_SPECS]
        for expected in ("config_parser", "roles", "credentials", "claude_usage",
                         "concierge", "dashboard_control", "dashboard_state",
                         "accounts"):
            self.assertIn(expected, names)
        # dependency order: a dependent never precedes its top-level dep
        self.assertLess(names.index("config_parser"), names.index("dashboard_state"))
        self.assertLess(names.index("roles"), names.index("dashboard_state"))
        self.assertLess(names.index("credentials"), names.index("accounts"))

    def test_reset_singletons_clears_stateful_caches(self):
        dashboard._accts_singleton[0] = object()
        dashboard._creds_singleton[0] = object()
        dashboard._reset_logic_singletons()
        self.assertIsNone(dashboard._accts_singleton[0])
        self.assertIsNone(dashboard._creds_singleton[0])

    def test_reload_logic_modules_is_a_noop_when_unchanged(self):
        # nothing edited on disk -> no reload, returns False, never raises.
        self.assertFalse(dashboard._reload_logic_modules())


if __name__ == "__main__":
    unittest.main()
