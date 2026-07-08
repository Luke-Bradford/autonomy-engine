"""Pipeline document (P1, #345) tests: schema validation, wrap, compile,
state machine, journal, ledger. Stdlib only; the real module, no mocks."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import pipeline  # noqa: E402


def minimal_doc():
    return {
        "name": "demo", "version": 1,
        "caps": {"max_sessions_per_run": 5},
        "nodes": [{"id": "act", "type": "agent_task", "brief_ref": "act.md"}],
        "edges": [], "containers": [],
    }


class ValidateDocTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("do the work\n")

    def test_minimal_doc_valid(self):
        self.assertEqual(pipeline.validate_doc(minimal_doc(), self.dir), [])

    def test_not_a_mapping(self):
        self.assertTrue(pipeline.validate_doc([], self.dir))

    def test_bad_name_charset(self):
        doc = minimal_doc(); doc["name"] = "no spaces!"
        self.assertTrue(any("name" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_missing_caps_rejected(self):
        doc = minimal_doc(); del doc["caps"]
        self.assertTrue(any("caps" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_cap_out_of_range(self):
        doc = minimal_doc(); doc["caps"]["max_sessions_per_run"] = 0
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc["caps"]["max_sessions_per_run"] = 501
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_unknown_node_type(self):
        doc = minimal_doc(); doc["nodes"][0]["type"] = "teleport"
        self.assertTrue(any("type" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_deferred_types_rejected_with_phase_message(self):
        # Types whose spec sheet promises engine machinery P1 lacks must be
        # refused, never run as weaker plain sessions (honesty invariant).
        for t in ("wait_watch", "ask_human", "handoff", "run_command"):
            doc = minimal_doc(); doc["nodes"][0]["type"] = t
            errs = pipeline.validate_doc(doc, self.dir)
            self.assertTrue(any("machinery" in e for e in errs), t)

    def test_unknown_keys_rejected_never_ignored(self):
        doc = minimal_doc(); doc["nodes"][0]["on_fail"] = "retry"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc = minimal_doc(); doc["config"] = {}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "stage", "children": ["act"],
                              "on_fail": "stop"}]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_duplicate_node_id(self):
        doc = minimal_doc()
        doc["nodes"].append(dict(doc["nodes"][0]))
        self.assertTrue(any("duplicate" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_brief_ref_missing_file(self):
        doc = minimal_doc(); doc["nodes"][0]["brief_ref"] = "ghost.md"
        self.assertTrue(any("ghost.md" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_brief_ref_traversal_rejected(self):
        for bad in ("../x.md", "a/b.md", "..", ""):
            doc = minimal_doc(); doc["nodes"][0]["brief_ref"] = bad
            self.assertTrue(pipeline.validate_doc(doc, self.dir), bad)

    def test_brief_ref_xor_legacy_prompt(self):
        doc = minimal_doc()
        doc["nodes"][0]["legacy_prompt"] = ".autonomy/loop_prompt.md"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))   # both set
        del doc["nodes"][0]["brief_ref"]
        del doc["nodes"][0]["legacy_prompt"]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))   # neither

    def test_validator_rejects_escaping_legacy_prompt(self):
        for bad in ("/etc/passwd", "../outside.md", "a//b.md", ""):
            doc = minimal_doc()
            del doc["nodes"][0]["brief_ref"]
            doc["nodes"][0]["legacy_prompt"] = bad
            self.assertTrue(pipeline.validate_doc(doc, None), bad)

    def test_nonempty_edges_rejected_p1(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["edges"] = [{"from": "act", "to": "b", "on": "success"}]
        self.assertTrue(any("P2" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_context_own_rejected_p1(self):
        doc = minimal_doc(); doc["nodes"][0]["context"] = "own"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_loop_container_requires_cap_and_exit(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act", "b"]}]
        errs = pipeline.validate_doc(doc, self.dir)
        self.assertTrue(any("max_rounds" in e for e in errs))
        self.assertTrue(any("exit_when" in e for e in errs))

    def test_loop_max_rounds_range(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act"],
                              "exit_when": "done", "max_rounds": 100}]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_branch_container_rejected_p1(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "branch", "children": ["act"]}]
        self.assertTrue(any("P2" in e or "kind" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_container_children_must_be_contiguous(self):
        doc = minimal_doc()
        doc["nodes"] = [
            {"id": "a", "type": "pick", "brief_ref": "act.md"},
            {"id": "b", "type": "agent_task", "brief_ref": "act.md"},
            {"id": "c", "type": "check", "brief_ref": "act.md"},
        ]
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["a", "c"],
                              "exit_when": "done", "max_rounds": 3}]
        self.assertTrue(any("contiguous" in e for e in pipeline.validate_doc(doc, self.dir)))

    def test_node_in_two_containers_rejected(self):
        doc = minimal_doc()
        doc["containers"] = [
            {"id": "c1", "kind": "loop", "children": ["act"], "exit_when": "d", "max_rounds": 2},
            {"id": "c2", "kind": "stage", "children": ["act"]},
        ]
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_runs_as_effort_enum(self):
        doc = minimal_doc(); doc["nodes"][0]["runs_as"] = {"effort": "warp9"}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_runs_as_agent_charset(self):
        doc = minimal_doc(); doc["nodes"][0]["runs_as"] = {"agent": "../evil"}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_runs_as_account_charset(self):
        doc = minimal_doc(); doc["nodes"][0]["runs_as"] = {"account": "a b!"}
        self.assertTrue(pipeline.validate_doc(doc, self.dir))


class WrapResolveTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        os.makedirs(os.path.join(self.repo, ".autonomy", "pipelines", "p1"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")
        # resolve_pipeline refuses early when a legacy_prompt is missing
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")

    def _write_pipeline(self, doc, briefs=("act.md",)):
        pdir = os.path.join(self.repo, ".autonomy", "pipelines", "p1")
        for b in briefs:
            with open(os.path.join(pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        with open(os.path.join(pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)

    def test_wrap_role_is_valid_one_node_doc(self):
        settings = {"account": "", "agent": "", "model": "opus", "effort": "high",
                    "prompt": "", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "coder")
        self.assertEqual(pipeline.validate_doc(doc, None), [])
        self.assertEqual(len(doc["nodes"]), 1)
        node = doc["nodes"][0]
        self.assertEqual(node["legacy_prompt"], ".autonomy/loop_prompt.md")
        self.assertEqual(node["runs_as"]["model"], "opus")
        self.assertEqual(doc["caps"]["max_sessions_per_run"], 1)
        self.assertEqual(doc.get("wrapped_from_role"), "coder")

    def test_wrap_role_keeps_role_prompt(self):
        settings = {"account": "", "agent": "", "model": "", "effort": "",
                    "prompt": ".autonomy/roles/pm.md", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "pm")
        self.assertEqual(doc["nodes"][0]["legacy_prompt"], ".autonomy/roles/pm.md")

    def test_wrap_degrades_invalid_effort_like_legacy(self):
        # resolve_role_dispatch blanks invalid values and RUNS; the wrap must
        # not turn that degrade into a hard refusal (a config that ran
        # yesterday keeps running after the upgrade).
        settings = {"account": "", "agent": "../evil", "model": "opus",
                    "effort": "warp9", "prompt": "", "scope": "", "pipeline": ""}
        doc = pipeline.wrap_role(settings, "coder")
        self.assertEqual(pipeline.validate_doc(doc, None), [])
        self.assertNotIn("effort", doc["nodes"][0].get("runs_as", {}))
        self.assertNotIn("agent", doc["nodes"][0].get("runs_as", {}))

    def test_resolve_unbound_role_wraps(self):
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertTrue(meta["wrapped"])
        self.assertIsNone(meta["pipeline_dir"])
        self.assertEqual(doc["nodes"][0]["legacy_prompt"], ".autonomy/loop_prompt.md")

    def test_resolve_bound_role_loads_doc(self):
        d = minimal_doc(); d["name"] = "p1"
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: p1\n")
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertFalse(meta["wrapped"])
        self.assertEqual(meta["from"], "p1")
        self.assertEqual(doc["name"], "p1")

    def test_resolve_bound_but_invalid_REFUSES(self):
        d = minimal_doc(); d["name"] = "p1"; del d["caps"]
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: p1\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")   # NEVER falls back to wrap

    def test_resolve_bound_but_missing_REFUSES(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: ghost\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")

    def test_resolve_missing_legacy_prompt_REFUSES_early(self):
        # A run state for an unrunnable doc would strand in-flight -- refuse
        # BEFORE any state exists.
        os.unlink(os.path.join(self.repo, ".autonomy", "loop_prompt.md"))
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")

    def test_resolve_refuses_multinode_on_cron_role(self):
        # P1: one node per LOOP iteration; a cron fire would strand a
        # multi-node run until the next fire -- refuse honestly (P2 lifts).
        d = minimal_doc(); d["name"] = "p1"
        d["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  pm:\n    enabled: true\n"
                     "    trigger:\n      type: cron\n"
                     "      schedule: '0 * * * *'\n"
                     "    pipeline: p1\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "pm")


class LoadDocTest(unittest.TestCase):
    def test_load_missing_raises(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.load_doc("/nonexistent/pipeline.json")

    def test_load_bad_json_raises(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "pipeline.json")
        with open(p, "w") as fh:
            fh.write("{nope")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.load_doc(p)


if __name__ == "__main__":
    unittest.main()
