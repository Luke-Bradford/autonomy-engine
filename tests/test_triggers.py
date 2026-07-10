import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "lib"))
import triggers                                            # noqa: E402
import pipeline                                            # noqa: E402


def _trig(**over):
    t = {"name": "coder-a", "pipeline": "ticket-to-merge",
         "params": {"repo": "/tmp/r", "coder_model": "claude-sonnet-5"},
         "firing": {"mode": "continuous"},
         "concurrency": {"policy": "skip", "max": 1},
         "enabled": True}
    t.update(over)
    return t


class ValidateTriggerTest(unittest.TestCase):
    def test_valid_trigger_accepted(self):
        self.assertEqual(triggers.validate_trigger(_trig(), "coder-a"), [])

    def test_not_a_dict_refused(self):
        self.assertTrue(triggers.validate_trigger([], "x"))

    def test_unknown_key_refused(self):
        errs = triggers.validate_trigger(_trig(schedule="* * * * *"), "coder-a")
        self.assertTrue(any("unknown key" in e for e in errs))

    def test_name_must_match_filename_stem(self):
        errs = triggers.validate_trigger(_trig(), "other-name")
        self.assertTrue(any("stem" in e for e in errs))

    def test_name_charset_gated(self):
        errs = triggers.validate_trigger(_trig(name="../x"), "../x")
        self.assertTrue(errs)

    def test_pipeline_required_and_charset_gated(self):
        self.assertTrue(triggers.validate_trigger(_trig(pipeline=""), "coder-a"))
        self.assertTrue(triggers.validate_trigger(_trig(pipeline="a/b"), "coder-a"))

    def test_params_must_be_flat_scalar_map(self):
        self.assertTrue(triggers.validate_trigger(_trig(params=[]), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(params={"x": {"nested": 1}}), "coder-a"))
        self.assertEqual(triggers.validate_trigger(
            _trig(params={"n": 3, "b": True, "s": "x"}), "coder-a"), [])

    def test_firing_required_mode_closed_set(self):
        self.assertTrue(triggers.validate_trigger(_trig(firing=None), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(firing={"mode": "sometimes"}), "coder-a"))

    def test_event_mode_deferred_refusal_names_phase(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "event"}), "coder-a")
        self.assertTrue(any("Phase C" in e for e in errs))

    def test_schedule_mode_requires_valid_cron(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "schedule"}), "coder-a")
        self.assertTrue(any("schedule" in e for e in errs))
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "schedule", "schedule": "not cron"}), "coder-a")
        self.assertTrue(any("cron" in e for e in errs))
        self.assertEqual(triggers.validate_trigger(
            _trig(firing={"mode": "schedule", "schedule": "0 6 * * *"}),
            "coder-a"), [])

    def test_schedule_key_refused_outside_schedule_mode(self):
        errs = triggers.validate_trigger(
            _trig(firing={"mode": "continuous", "schedule": "0 6 * * *"}),
            "coder-a")
        self.assertTrue(errs)      # accepted-and-ignored knob = fail-open

    def test_concurrency_policy_closed_set_and_bounds(self):
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "pile-up", "max": 1}), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "parallel", "max": 0}), "coder-a"))
        self.assertTrue(triggers.validate_trigger(
            _trig(concurrency={"policy": "parallel",
                               "max": triggers.MAX_TRIGGER_PARALLEL + 1}),
            "coder-a"))

    def test_queue_depth_bounded_at_one(self):
        # Spec S11: queue is ADF-like concurrency=1; deeper queues risk stale runs.
        errs = triggers.validate_trigger(
            _trig(concurrency={"policy": "queue", "max": 2}), "coder-a")
        self.assertTrue(any("queue" in e for e in errs))

    def test_concurrency_absent_defaults_skip_one(self):
        t = _trig()
        del t["concurrency"]
        self.assertEqual(triggers.validate_trigger(t, "coder-a"), [])

    def test_enabled_must_be_bool_when_present(self):
        self.assertTrue(triggers.validate_trigger(_trig(enabled="yes"), "coder-a"))

    def test_lane_optional_charset_gated(self):
        self.assertEqual(triggers.validate_trigger(_trig(lane="qa"), "coder-a"), [])
        self.assertTrue(triggers.validate_trigger(_trig(lane="a b"), "coder-a"))


class EffectiveTriggerPathTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.committed = os.path.join(self.repo, ".autonomy", "triggers")
        self.shadow = os.path.join(self.repo, "var", "autonomy", "triggers")
        os.makedirs(self.committed)
        os.makedirs(self.shadow)

    def test_committed_when_no_shadow(self):
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"),
                         os.path.join(self.committed, "t.json"))

    def test_shadow_file_wins(self):
        p = os.path.join(self.shadow, "t.json")
        with open(p, "w") as fh:
            fh.write("{}")
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"), p)

    def test_symlinked_shadow_ignored(self):
        target = os.path.join(self.repo, "outside.json")
        with open(target, "w") as fh:
            fh.write("{}")
        os.symlink(target, os.path.join(self.shadow, "t.json"))
        self.assertEqual(triggers.effective_trigger_path(self.repo, "t"),
                         os.path.join(self.committed, "t.json"))


class LoadTriggerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "triggers"))

    def _write(self, name, obj, where=".autonomy"):
        d = os.path.join(self.repo, where, "triggers")
        if not os.path.isdir(d):
            os.makedirs(d)
        with open(os.path.join(d, "%s.json" % name), "w") as fh:
            json.dump(obj, fh)

    def test_load_valid(self):
        self._write("coder-a", _trig())
        t = triggers.load_trigger(self.repo, "coder-a")
        self.assertEqual(t["pipeline"], "ticket-to-merge")
        self.assertEqual(t["concurrency"], {"policy": "skip", "max": 1})

    def test_bad_name_refused_before_any_path_build(self):
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "../escape")

    def test_missing_refused(self):
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "ghost")

    def test_corrupt_json_refused(self):
        d = os.path.join(self.repo, ".autonomy", "triggers")
        with open(os.path.join(d, "bad.json"), "w") as fh:
            fh.write("{ not json")
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "bad")

    def test_invalid_shadow_refuses_never_falls_back(self):
        # The committed file is VALID; the shadow is INVALID. SD-34 discipline:
        # present-but-invalid shadow REFUSES -- a silent fallback to committed
        # would run a config the operator's edit replaced (prevention-log #3).
        self._write("coder-a", _trig())
        self._write("coder-a", {"name": "coder-a"}, where="var/autonomy")
        with self.assertRaises(pipeline.PipelineError):
            triggers.load_trigger(self.repo, "coder-a")

    def test_defaults_applied_on_load(self):
        t = _trig()
        del t["concurrency"]
        del t["enabled"]
        self._write("coder-a", t)
        got = triggers.load_trigger(self.repo, "coder-a")
        self.assertEqual(got["concurrency"], {"policy": "skip", "max": 1})
        self.assertIs(got["enabled"], True)


class ShimTriggersTest(unittest.TestCase):
    def _config(self):
        return {"roles": {
            "coder": {"enabled": True},
            "pm": {"enabled": True,
                   "trigger": {"type": "cron", "schedule": "0 6 * * *"}},
            "qa": {"enabled": True, "trigger": {"type": "event",
                                                "on": ["pr.opened"]}},
            "researcher": {"enabled": False}}}

    def test_loop_role_becomes_continuous_shim(self):
        shims = triggers.shim_triggers(self._config())
        coder = [t for t in shims if t["name"] == "coder"][0]
        self.assertEqual(coder["firing"], {"mode": "continuous"})
        self.assertEqual(coder["concurrency"], {"policy": "skip", "max": 1})
        self.assertEqual(coder["kind"], "shim")
        self.assertEqual(coder["params"], {})
        self.assertIs(coder["enabled"], True)

    def test_cron_role_becomes_schedule_shim(self):
        shims = triggers.shim_triggers(self._config())
        pm = [t for t in shims if t["name"] == "pm"][0]
        self.assertEqual(pm["firing"],
                         {"mode": "schedule", "schedule": "0 6 * * *"})

    def test_event_role_not_shimmed(self):
        # The event bus stays on the legacy role path until Phase C --
        # shimming would dispatch qa twice (once per path).
        names = [t["name"] for t in triggers.shim_triggers(self._config())]
        self.assertNotIn("qa", names)

    def test_disabled_role_not_shimmed(self):
        names = [t["name"] for t in triggers.shim_triggers(self._config())]
        self.assertNotIn("researcher", names)

    def test_shim_order_matches_dispatch_roles_order(self):
        # Parity invariant 3 depends on this ordering.
        import roles
        cfg = self._config()
        loop_shims = [t["name"] for t in triggers.shim_triggers(cfg)
                      if t["firing"]["mode"] == "continuous"]
        self.assertEqual(loop_shims, roles._all_loop_roles(cfg))

    def test_shim_carries_pipeline_binding_when_bound(self):
        cfg = {"roles": {"coder": {"enabled": True,
                                   "pipeline": "ticket-to-merge"}}}
        coder = [t for t in triggers.shim_triggers(cfg)
                 if t["name"] == "coder"][0]
        self.assertEqual(coder["pipeline"], "ticket-to-merge")

    def test_shim_carries_lane(self):
        # lanes: is a dict KEYED BY LANE NAME, first key = default lane
        # (roles._declared_lane_names/default_lane, lib/roles.py:110-122).
        cfg = {"lanes": {"main": {}, "qa-lane": {}},
               "roles": {"coder": {"enabled": True, "lane": "qa-lane"}}}
        coder = [t for t in triggers.shim_triggers(cfg)
                 if t["name"] == "coder"][0]
        self.assertEqual(coder["lane"], "qa-lane")

    def test_degenerate_config_yields_defaults_not_crash(self):
        # dispatch must degrade, never crash (roles.py convention).
        self.assertIsInstance(triggers.shim_triggers({}), list)
        self.assertIsInstance(triggers.shim_triggers({"roles": []}), list)


class EnumerateTriggersTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "triggers"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n")

    def _write(self, name, obj, where=".autonomy"):
        d = os.path.join(self.repo, where, "triggers")
        if not os.path.isdir(d):
            os.makedirs(d)
        with open(os.path.join(d, "%s.json" % name), "w") as fh:
            json.dump(obj, fh)

    def test_roles_only_config_enumerates_shims(self):
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertEqual([(t["name"], t["kind"]) for t in trigs],
                         [("coder", "shim")])
        self.assertEqual(warns, [])

    def test_native_trigger_included(self):
        self._write("qa-nightly", _trig(name="qa-nightly",
                                        firing={"mode": "continuous"}))
        trigs, _ = triggers.enumerate_triggers(self.repo)
        names = {t["name"]: t["kind"] for t in trigs}
        self.assertEqual(names["qa-nightly"], "native")

    def test_native_supersedes_same_name_shim_with_warning(self):
        self._write("coder", _trig(name="coder"))
        trigs, warns = triggers.enumerate_triggers(self.repo)
        kinds = [t["kind"] for t in trigs if t["name"] == "coder"]
        self.assertEqual(kinds, ["native"])          # exactly one, the file
        self.assertTrue(any("supersedes" in w for w in warns))

    def test_invalid_file_trigger_refused_and_never_falls_back_to_shim(self):
        # THE carried argument: a broken trigger shadowing a role must not
        # resurrect role dispatch. coder must NOT appear at all.
        self._write("coder", {"name": "coder", "firing": {"mode": "wat"}})
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertEqual([t for t in trigs if t["name"] == "coder"], [])
        self.assertTrue(any("coder" in w for w in warns))

    def test_disabled_trigger_excluded_from_dispatch_enumeration(self):
        self._write("qa-nightly", _trig(name="qa-nightly", enabled=False))
        trigs, _ = triggers.enumerate_triggers(self.repo)
        self.assertNotIn("qa-nightly", [t["name"] for t in trigs])

    def test_native_trigger_colliding_with_event_role_refused(self):
        # Event roles stay on the legacy bus until Phase C; a same-name
        # native trigger would double-dispatch that name (Codex CP1).
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  qa:\n    enabled: true\n"
                     "    trigger:\n      type: event\n"
                     "      on: [pr.opened]\n")
        self._write("qa", _trig(name="qa"))
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertNotIn("qa", [t["name"] for t in trigs])
        self.assertTrue(any("event" in w and "qa" in w for w in warns))

    def test_bad_filename_stem_refused_with_warning(self):
        d = os.path.join(self.repo, ".autonomy", "triggers")
        with open(os.path.join(d, "has space.json"), "w") as fh:
            fh.write("{}")
        trigs, warns = triggers.enumerate_triggers(self.repo)
        self.assertTrue(any("has space" in w for w in warns))

    def test_shadow_only_trigger_enumerates(self):
        self._write("hotfix", _trig(name="hotfix"), where="var/autonomy")
        trigs, _ = triggers.enumerate_triggers(self.repo)
        self.assertIn("hotfix", [t["name"] for t in trigs])

    def test_config_unreadable_raises(self):
        os.remove(os.path.join(self.repo, ".autonomy", "config.yaml"))
        with self.assertRaises(pipeline.PipelineError):
            triggers.enumerate_triggers(self.repo)


class CliTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "triggers"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n"
                     "  pm:\n    enabled: true\n"
                     "    trigger:\n      type: cron\n"
                     "      schedule: '0 6 * * *'\n")

    def _write(self, name, obj):
        d = os.path.join(self.repo, ".autonomy", "triggers")
        with open(os.path.join(d, "%s.json" % name), "w") as fh:
            json.dump(obj, fh)

    def _run(self, *argv):
        import contextlib
        import io
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = triggers.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def test_dispatch_emits_tab_line_for_continuous_shim(self):
        rc, out, _ = self._run("dispatch", self.repo)
        self.assertEqual(rc, 0)
        self.assertIn("coder\tshim\tskip\t1\n", out)
        self.assertNotIn("pm\t", out)          # cron shim not in dispatch

    def test_cron_emits_schedule_shim(self):
        rc, out, _ = self._run("cron", self.repo)
        self.assertEqual(rc, 0)
        self.assertIn("pm\t0 6 * * *\tshim\n", out)
        self.assertNotIn("coder\t", out)

    def test_show_round_trips_a_written_trigger(self):
        self._write("t9", _trig(name="t9", firing={"mode": "manual"}))
        rc, out, _ = self._run("show", self.repo, "t9")
        self.assertEqual(rc, 0)
        self.assertIn("NAME=t9\n", out)
        self.assertIn("PIPELINE=ticket-to-merge\n", out)
        self.assertIn("MODE=manual\n", out)
        self.assertIn("POLICY=skip\n", out)
        self.assertIn("MAX=1\n", out)
        self.assertIn("ENABLED=true\n", out)

    def test_validate_rc1_on_refused_trigger(self):
        self._write("bad", {"name": "bad", "firing": {"mode": "wat"}})
        rc, out, _ = self._run("validate", self.repo)
        self.assertEqual(rc, 1)
        self.assertIn("WARN", out)

    def test_validate_rc0_when_valid_native_supersedes_shim(self):
        # A supersession note is informational, not a refusal.
        self._write("coder", _trig(name="coder"))
        rc, out, _ = self._run("validate", self.repo)
        self.assertEqual(rc, 0)
        self.assertIn("OK coder (native, continuous)\n", out)

    def test_dispatch_unreadable_config_rc1(self):
        os.remove(os.path.join(self.repo, ".autonomy", "config.yaml"))
        rc, _, err = self._run("dispatch", self.repo)
        self.assertEqual(rc, 1)
        self.assertIn("dispatch", err)

    def test_unknown_subcommand_rc2(self):
        rc, _, _ = self._run("frobnicate", self.repo)
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
