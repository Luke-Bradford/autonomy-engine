"""Unit tests for lib/agents.py -- the global agent-entity registry (#87 / SD-30).

An *agent entity* is a named bundle of defaults a repo binding points at: which
account it authenticates from, its default model + effort, the rail it plays,
and a human description. It is DISTINCT from the low-level adapter (`bin/agents/
claude.sh` -- which CLI runs); those keep their own `roles.<x>.agent` field.

Per SD-30 the index (~/.config/autonomy/agents) holds names/refs/labels only --
never a secret. Cross-registry existence (does `account` name a real account?)
is NOT checked here: a dangling ref degrades to a doctor WARNING (fail-safe,
never silently dropped, never fail-open). Tests inject a temp index only.
"""
import json
import os
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import agents as ag  # noqa: E402


class TestAgentsCrud(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "agents")
        self.a = ag.Agents(index_path=self.index)

    def test_set_minimal_then_get(self):
        # account is the only required field beyond the name.
        self.a.set("coder", account="claude-main")
        e = self.a.get("coder")
        self.assertIsNotNone(e)
        self.assertEqual(e["account"], "claude-main")
        # optional fields default to None / "" and never crash a read.
        self.assertIsNone(e["model"])
        self.assertIsNone(e["effort"])
        self.assertIsNone(e["rail"])
        self.assertEqual(e["description"], "")

    def test_set_full_roundtrip(self):
        self.a.set("planner", account="claude-main",
                   model="claude-opus-4-8", effort="high", rail="pm",
                   description="grooms + prioritises the board")
        e = self.a.get("planner")
        self.assertEqual(e["model"], "claude-opus-4-8")
        self.assertEqual(e["effort"], "high")
        self.assertEqual(e["rail"], "pm")
        self.assertEqual(e["description"], "grooms + prioritises the board")

    def test_get_missing_is_none(self):
        self.assertIsNone(self.a.get("nope"))

    def test_list_sorted_with_flags(self):
        self.a.set("zeta", account="a1")
        self.a.set("alpha", account="a2", model="m")
        names = [r["name"] for r in self.a.list()]
        self.assertEqual(names, ["alpha", "zeta"])  # sorted by name
        alpha = next(r for r in self.a.list() if r["name"] == "alpha")
        self.assertEqual(alpha["account"], "a2")
        self.assertEqual(alpha["model"], "m")

    def test_update_overwrites_same_name(self):
        self.a.set("coder", account="a1", effort="low")
        self.a.set("coder", account="a2", effort="max")
        e = self.a.get("coder")
        self.assertEqual(e["account"], "a2")
        self.assertEqual(e["effort"], "max")
        self.assertEqual(len(self.a.list()), 1)

    def test_delete(self):
        self.a.set("coder", account="a1")
        self.a.delete("coder")
        self.assertIsNone(self.a.get("coder"))
        self.assertEqual(self.a.list(), [])

    def test_delete_missing_is_noop(self):
        self.a.delete("ghost")   # must not raise / must not create a file
        self.assertEqual(self.a.list(), [])


class TestAgentsValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.a = ag.Agents(index_path=os.path.join(self.tmp, "agents"))

    def test_bad_name_rejected(self):
        for bad in ("", "has space", "a" * 65, "semi;colon", "sl/ash"):
            with self.assertRaises(ValueError):
                self.a.set(bad, account="a1")

    def test_account_required_and_shaped(self):
        with self.assertRaises(ValueError):
            self.a.set("coder", account="")          # empty
        with self.assertRaises(ValueError):
            self.a.set("coder", account="bad name")  # bad shape

    def test_bad_effort_rejected(self):
        with self.assertRaises(ValueError):
            self.a.set("coder", account="a1", effort="turbo")

    def test_valid_efforts_accepted(self):
        # SSOT: whatever dashboard_control blesses, the registry accepts.
        import dashboard_control as dcx
        for eff in dcx.VALID_EFFORTS:
            self.a.set("coder", account="a1", effort=eff)
            self.assertEqual(self.a.get("coder")["effort"], eff)

    def test_bad_rail_shape_rejected(self):
        with self.assertRaises(ValueError):
            self.a.set("coder", account="a1", rail="bad rail")

    def test_empty_model_rejected(self):
        # a present-but-empty model is a mistake, not "no default".
        with self.assertRaises(ValueError):
            self.a.set("coder", account="a1", model="   ")

    def test_dangling_account_is_stored_not_validated(self):
        # SD-30: existence is doctor's job; the registry stores the ref as-is.
        self.a.set("coder", account="does-not-exist-account")
        self.assertEqual(self.a.get("coder")["account"], "does-not-exist-account")


class TestAgentsPersistence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "agents")
        self.a = ag.Agents(index_path=self.index)

    def test_file_mode_0600(self):
        self.a.set("coder", account="a1")
        mode = stat.S_IMODE(os.stat(self.index).st_mode)
        self.assertEqual(mode, 0o600)

    def test_no_temp_file_left_behind(self):
        self.a.set("coder", account="a1")
        leftovers = [f for f in os.listdir(self.tmp) if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_persists_across_instances(self):
        self.a.set("coder", account="a1", model="m")
        other = ag.Agents(index_path=self.index)
        self.assertEqual(other.get("coder")["model"], "m")

    def test_read_of_absent_index_is_empty(self):
        self.assertEqual(self.a.list(), [])
        self.assertFalse(os.path.exists(self.index))  # a read never creates it


class TestAgentsCorruption(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "agents")
        self.a = ag.Agents(index_path=self.index)

    def _write_raw(self, text):
        with open(self.index, "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_read_degrades_corrupt_to_empty(self):
        self._write_raw("{ not json")
        self.assertEqual(self.a.list(), [])   # reads never destroy data
        self.assertTrue(self.a.is_corrupt())

    def test_non_dict_top_level_is_corrupt(self):
        self._write_raw("[1, 2, 3]")
        self.assertTrue(self.a.is_corrupt())

    def test_non_dict_agents_section_is_corrupt(self):
        self._write_raw(json.dumps({"agents": [1, 2]}))
        self.assertTrue(self.a.is_corrupt())

    def test_null_agents_section_is_corrupt(self):
        self._write_raw(json.dumps({"agents": None}))
        self.assertTrue(self.a.is_corrupt())

    def test_write_refuses_on_corrupt(self):
        # fail-safe: a write onto a corrupt index would silently drop the
        # unreadable entries -- refuse instead (#59 pattern).
        self._write_raw("{ not json")
        with self.assertRaises(ag.RegistryError):
            self.a.set("coder", account="a1")

    def test_delete_refuses_on_corrupt(self):
        self._write_raw("{ not json")
        with self.assertRaises(ag.RegistryError):
            self.a.delete("coder")


class TestDoctorReport(unittest.TestCase):
    """doctor_report() -- the doctor-WARNING half of SD-30: dangling
    entity->account refs and a corrupt index degrade to WARN lines, never a
    crash and never silence. Rail refs are deliberately NOT covered: rails
    resolve against a repo's roles: block and the binding key tying an entity
    to a repo is an open #87 design fork, so there is nothing repo-independent
    to validate them against yet."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.agents_idx = os.path.join(self.tmp, "agents")
        self.accounts_idx = os.path.join(self.tmp, "accounts")
        self.reg = ag.Agents(index_path=self.agents_idx)

    def _write_accounts(self, names):
        with open(self.accounts_idx, "w", encoding="utf-8") as fh:
            json.dump({"accounts": {n: {"kind": "claude_subscription"}
                                    for n in names}}, fh)

    def _report(self):
        return ag.doctor_report(agents_index=self.agents_idx,
                                accounts_index=self.accounts_idx)

    def test_absent_registry_reports_nothing(self):
        # No agents registry on this machine is the common, healthy case --
        # zero noise (mirrors doctor_lane_report's silent-when-absent shape).
        self._write_accounts(["main"])
        self.assertEqual(self._report(), [])

    def test_all_refs_resolve_is_one_ok_line(self):
        self._write_accounts(["main", "codex-1"])
        self.reg.set("coder", account="main")
        self.reg.set("researcher", account="codex-1")
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("OK "), lines[0])
        self.assertIn("2", lines[0])

    def test_dangling_account_ref_warns_naming_both(self):
        self._write_accounts(["main"])
        self.reg.set("coder", account="main")
        self.reg.set("ghost", account="gone-acct")
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("WARN "), lines[0])
        self.assertIn("ghost", lines[0])
        self.assertIn("gone-acct", lines[0])
        # the healthy verdict is EARNED -- no OK line alongside a WARN.
        self.assertFalse(any(ln.startswith("OK ") for ln in lines))

    def test_corrupt_agents_index_is_one_warn(self):
        with open(self.agents_idx, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        self._write_accounts(["main"])
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("WARN "), lines[0])
        self.assertIn("unreadable", lines[0])

    def test_corrupt_accounts_index_never_fabricates_dangling(self):
        # fail-safe, not fail-open: with an unreadable ACCOUNTS index the
        # naive set-lookup would accuse every agent of dangling. Degrade to
        # a single cannot-verify WARN instead -- neither OK nor accusations.
        self.reg.set("coder", account="main")
        with open(self.accounts_idx, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("WARN "), lines[0])
        self.assertIn("cannot verify", lines[0])
        self.assertNotIn("coder", lines[0])

    def test_malformed_account_ref_warns_not_crashes(self):
        # A hand-edited entry can carry a non-string account ref; the entry
        # dict passes is_corrupt() but `[] in set` would raise unhashable
        # TypeError -- through doctor.sh's best-effort guard that becomes
        # SILENCE, not a WARN (Codex CP2 finding). The reporter must be total
        # (prevention-log #12): malformed ref -> its own WARN line.
        with open(self.agents_idx, "w", encoding="utf-8") as fh:
            json.dump({"agents": {"bad": {"account": []},
                                  "coder": {"account": "main"}}}, fh)
        self._write_accounts(["main"])
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("WARN "), lines[0])
        self.assertIn("bad", lines[0])
        self.assertIn("malformed", lines[0])

    def test_missing_account_key_warns_malformed(self):
        with open(self.agents_idx, "w", encoding="utf-8") as fh:
            json.dump({"agents": {"orphan": {}}}, fh)
        self._write_accounts(["main"])
        lines = self._report()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("WARN "), lines[0])
        self.assertIn("orphan", lines[0])
        self.assertIn("malformed", lines[0])

    def test_empty_accounts_registry_warns_each_agent(self):
        # An ABSENT accounts registry is readable-and-empty, not corrupt:
        # every ref genuinely dangles and each agent gets its own WARN.
        self.reg.set("coder", account="main")
        self.reg.set("qa", account="main")
        lines = self._report()
        self.assertEqual(len(lines), 2)
        self.assertTrue(all(ln.startswith("WARN ") for ln in lines))


if __name__ == "__main__":
    unittest.main()
