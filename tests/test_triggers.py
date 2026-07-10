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


if __name__ == "__main__":
    unittest.main()
