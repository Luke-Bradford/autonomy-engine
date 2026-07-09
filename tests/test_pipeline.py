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

    # P2a (#349) lifted the P1 edges-must-be-[] refusal; the acceptance
    # matrix lives in EdgeValidationTest below.

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


class EdgeValidationTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("do\n")

    def _doc(self, edges, containers=None, extra_nodes=()):
        doc = minimal_doc()
        for nid in ("b", "c") + tuple(extra_nodes):
            doc["nodes"].append({"id": nid, "type": "check", "brief_ref": "act.md"})
        doc["edges"] = edges
        if containers is not None:
            doc["containers"] = containers
        return doc

    def test_typed_edges_accepted(self):
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "act", "to": "c", "on": "failure"},
                 {"from": "b", "to": "c", "on": "completion"}]
        doc = self._doc(edges)
        doc["nodes"][2]["join"] = "any"   # c: failure OR completion path
        self.assertEqual(pipeline.validate_doc(doc, self.dir), [])

    def test_unknown_endpoint_rejected(self):
        edges = [{"from": "act", "to": "ghost", "on": "success"}]
        self.assertTrue(pipeline.validate_doc(self._doc(edges), self.dir))

    def test_bad_on_rejected(self):
        edges = [{"from": "act", "to": "b", "on": "sometimes"}]
        self.assertTrue(pipeline.validate_doc(self._doc(edges), self.dir))

    def test_unknown_edge_key_rejected(self):
        edges = [{"from": "act", "to": "b", "on": "success", "when": "maybe"}]
        self.assertTrue(pipeline.validate_doc(self._doc(edges), self.dir))

    def test_bad_join_rejected(self):
        doc = minimal_doc(); doc["nodes"][0]["join"] = "some"
        self.assertTrue(pipeline.validate_doc(doc, self.dir))

    def test_cycle_without_back_flag_rejected(self):
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "b", "to": "act", "on": "success"}]
        errs = pipeline.validate_doc(self._doc(edges), self.dir)
        self.assertTrue(any("cycle" in e for e in errs))

    def test_back_edge_requires_container_target_and_cap(self):
        con = [{"id": "L", "kind": "loop", "children": ["b"],
                "exit_when": "done", "max_rounds": 3}]
        ok = [{"from": "act", "to": "L", "on": "success"},
              {"from": "c", "to": "L", "on": "failure", "back": True,
               "max_bounces": 3},
              {"from": "L", "to": "c", "on": "success"}]
        self.assertEqual(pipeline.validate_doc(self._doc(ok, con), self.dir), [])
        no_cap = dict(ok[1]); del no_cap["max_bounces"]
        errs = pipeline.validate_doc(self._doc([ok[0], no_cap, ok[2]], con),
                                     self.dir)
        self.assertTrue(any("max_bounces" in e for e in errs))
        to_node = [ok[0],
                   {"from": "c", "to": "act", "on": "failure", "back": True,
                    "max_bounces": 2},
                   ok[2]]
        errs = pipeline.validate_doc(self._doc(to_node, con), self.dir)
        self.assertTrue(any("loop or stage" in e for e in errs))

    def test_forward_back_edge_rejected(self):
        # a back:true edge whose target is NOT an ancestor of its from-node
        # is invisible to the DAG check and would stall the walk -- refuse.
        con = [{"id": "L", "kind": "loop", "children": ["c"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "act", "to": "b", "on": "success"},
                 {"from": "act", "to": "L", "on": "failure", "back": True,
                  "max_bounces": 2}]
        errs = pipeline.validate_doc(self._doc(edges, con), self.dir)
        self.assertTrue(any("ancestor" in e for e in errs))

    def test_intra_container_edge_rejected(self):
        con = [{"id": "L", "kind": "loop", "children": ["b", "c"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "b", "to": "c", "on": "success"}]
        errs = pipeline.validate_doc(self._doc(edges, con), self.dir)
        self.assertTrue(any("inside" in e for e in errs))

    def test_container_endpoints_accepted(self):
        con = [{"id": "L", "kind": "loop", "children": ["b"],
                "exit_when": "done", "max_rounds": 3}]
        edges = [{"from": "act", "to": "L", "on": "success"},
                 {"from": "L", "to": "c", "on": "success"}]
        self.assertEqual(pipeline.validate_doc(self._doc(edges, con), self.dir), [])


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

    def test_resolve_refuses_multinode_on_cron_role_in_any_lane(self):
        # Codex CP2: cron_roles(cfg) is default-lane-filtered -- a cron role
        # PINNED TO A NON-DEFAULT LANE must not slip past the multi-node
        # refusal (the stall-between-fires hazard is lane-independent).
        d = minimal_doc(); d["name"] = "p1"
        d["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("lanes:\n  side:\n    worktree: ../side\n"
                     "roles:\n  pm:\n    enabled: true\n"
                     "    lane: side\n"
                     "    trigger:\n      type: cron\n"
                     "      schedule: '0 * * * *'\n"
                     "    pipeline: p1\n")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "pm")

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


class CompileBriefTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("Do the thing.\n")

    def test_plain_node_brief(self):
        doc = minimal_doc()
        out = pipeline.compile_brief(self.dir, doc, "act")
        self.assertIn("<!-- pipeline:node act (agent_task) -->", out)
        self.assertIn("Do the thing.", out)
        self.assertNotIn("pipeline:loop", out)

    def test_loop_node_brief_carries_round_and_verdict_instructions(self):
        doc = minimal_doc()
        doc["containers"] = [{"id": "c1", "kind": "loop", "children": ["act"],
                              "exit_when": "all tests pass", "max_rounds": 5}]
        ctx = {"container": "c1", "round": 2, "max_rounds": 5,
               "exit_when": "all tests pass",
               "verdict_file": "var/autonomy-logs/.pipeline-run-coder.verdict.json"}
        out = pipeline.compile_brief(self.dir, doc, "act", ctx)
        self.assertIn("round 2 of at most 5", out)
        self.assertIn("all tests pass", out)
        self.assertIn(".pipeline-run-coder.verdict.json", out)
        self.assertIn("enforced by the engine", out)   # honesty tag

    def test_missing_brief_raises(self):
        doc = minimal_doc()
        doc["nodes"][0]["brief_ref"] = "ghost.md"
        with self.assertRaises(pipeline.PipelineError):
            pipeline.compile_brief(self.dir, doc, "act")

    def test_verdict_footer_when_failure_edge_leaves_the_node(self):
        # a node whose outgoing failure edge makes its verdict load-bearing
        # must be TOLD where to write it -- otherwise the branch can never
        # fire and the failure lane is dead prose.
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "notify", "brief_ref": "act.md"})
        doc["edges"] = [{"from": "act", "to": "b", "on": "failure"}]
        out = pipeline.compile_brief(
            self.dir, doc, "act",
            verdict_ctx={"verdict_file": "var/autonomy-logs/x.verdict.json"})
        self.assertIn("pipeline:verdict", out)
        self.assertIn("x.verdict.json", out)
        self.assertIn('"outcome"', out)


class StateMachineTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        for b in ("a.md", "b.md", "c.md"):
            with open(os.path.join(self.pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        self.state = os.path.join(self.repo, "state.json")
        self.brief_out = os.path.join(self.repo, "brief.md")
        self.verdict = os.path.join(self.repo, "verdict.json")

    def _bind(self, doc):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: flow\n")

    def _three_node_doc(self):
        return {"name": "flow", "version": 2,
                "caps": {"max_sessions_per_run": 10},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                    {"id": "c", "type": "summarize", "brief_ref": "c.md"}],
                "edges": [], "containers": []}

    def test_linear_walk_and_completion(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        for expect in ("a", "b", "c"):
            step = pipeline.next_node(self.state, self.brief_out)
            self.assertEqual(step["status"], "node")
            self.assertEqual(step["node"], expect)
            self.assertEqual(step["kind"], "compiled")
            self.assertEqual(step["prompt"], self.brief_out)
            with open(self.brief_out) as fh:
                self.assertIn("brief %s.md" % expect, fh.read())
            res = pipeline.record_outcome(self.state, expect, "success")
            if expect == "c":
                self.assertEqual(res, "DONE success")
            else:
                self.assertEqual(res, "CONTINUE")
        self.assertFalse(os.path.exists(self.state))   # cleaned up on DONE

    def test_run_id_carries_role_ts_pid(self):
        self._bind(self._three_node_doc())
        state = pipeline.start_run(self.repo, "coder", self.state, lane="alpha")
        self.assertTrue(state["run_id"].startswith("coder--alpha-"))
        self.assertTrue(state["run_id"].endswith("-%d" % os.getpid()))

    def test_usage_limit_means_no_record_same_node_again(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(pipeline.next_node(self.state, self.brief_out)["node"], "a")
        # supervisor does NOT call record on usage_limit
        self.assertEqual(pipeline.next_node(self.state, self.brief_out)["node"], "a")

    def test_node_error_fails_the_run(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(pipeline.record_outcome(self.state, "a", "error"),
                         "DONE failure")
        self.assertFalse(os.path.exists(self.state))

    def test_mismatched_node_id_raises(self):
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, self.brief_out)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.record_outcome(self.state, "c", "success")

    def _loop_doc(self, max_rounds=3):
        return {"name": "flow", "version": 1,
                "caps": {"max_sessions_per_run": 20},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                    {"id": "c", "type": "check", "brief_ref": "c.md"}],
                "edges": [],
                "containers": [{"id": "L", "kind": "loop",
                                "children": ["b", "c"],
                                "exit_when": "done", "max_rounds": max_rounds}]}

    def _run_round(self, nodes):
        res = None
        for n in nodes:
            step = pipeline.next_node(self.state, self.brief_out)
            self.assertEqual(step["node"], n)
            res = pipeline.record_outcome(self.state, n, "success",
                                          verdict_path=self.verdict)
        return res

    def test_loop_repeats_until_verdict_exit(self):
        self._bind(self._loop_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(self._run_round(["a"]), "CONTINUE")
        self.assertEqual(self._run_round(["b", "c"]), "CONTINUE")   # round 1, no verdict
        with open(self.verdict, "w") as fh:
            json.dump({"exit": True}, fh)
        # round 2: verdict read after last child -> exits loop -> run done
        self.assertEqual(self._run_round(["b", "c"]), "DONE success")

    def test_loop_verdict_garbage_is_no_exit(self):
        self._bind(self._loop_doc(max_rounds=2))
        pipeline.start_run(self.repo, "coder", self.state)
        self._run_round(["a"])
        with open(self.verdict, "w") as fh:
            fh.write("not json {{{")
        self._run_round(["b", "c"])                      # garbage -> round 2
        with open(self.verdict, "w") as fh:
            fh.write("not json {{{")
        self.assertEqual(self._run_round(["b", "c"]), "DONE capped")  # cap floor

    def test_loop_round_ctx_in_brief(self):
        self._bind(self._loop_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self._run_round(["a"])
        pipeline.next_node(self.state, self.brief_out)
        with open(self.brief_out) as fh:
            self.assertIn("round 1 of at most 3", fh.read())

    def test_session_cap_finishes_capped_at_record_time(self):
        # The cap decision happens in record_outcome (which holds the journal
        # path) -- deciding it in next_node would lose the run's journal line.
        doc = self._loop_doc(max_rounds=99)
        doc["caps"]["max_sessions_per_run"] = 3
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(self._run_round(["a"]), "CONTINUE")
        self.assertEqual(self._run_round(["b", "c"]), "DONE capped")  # 3rd session
        self.assertFalse(os.path.exists(self.state))

    def test_wrapped_role_state_machine_passthrough(self):
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")
        pipeline.start_run(self.repo, "coder", self.state)
        step = pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(step["kind"], "legacy")
        self.assertEqual(step["prompt"], ".autonomy/loop_prompt.md")
        self.assertFalse(os.path.exists(self.brief_out))   # no compile for legacy
        self.assertEqual(pipeline.record_outcome(self.state, "act", "success"),
                         "DONE success")

    def test_corrupt_state_raises_never_deletes(self):
        with open(self.state, "w") as fh:
            fh.write("garbage")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.next_node(self.state, self.brief_out)
        self.assertTrue(os.path.exists(self.state))

    def test_finish_cleanup_double_failure_raises_after_journal(self):
        # Codex CP2: if the state file can neither be unlinked NOR rewritten
        # as a done-marker, returning success would let the next tick rerun
        # the completed node and double-journal -- fail-open. Must raise.
        subdir = os.path.join(self.repo, "locked")
        os.makedirs(subdir)
        state = os.path.join(subdir, "state.json")
        journal = os.path.join(self.repo, "journal.jsonl")
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")
        pipeline.start_run(self.repo, "coder", state)
        pipeline.next_node(state, self.brief_out)
        os.chmod(subdir, 0o500)                      # unlink + rewrite both fail
        self.addCleanup(os.chmod, subdir, 0o700)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.record_outcome(state, "act", "success",
                                    journal_path=journal)
        with open(journal) as fh:
            self.assertEqual(len(fh.read().splitlines()), 1)   # journalled once

    def test_unknown_status_refuses_not_success(self):
        # prevention-log #18: the reassuring verdict must be earned -- a
        # garbage status lands on the REFUSE side, never finish-success.
        self._bind(self._three_node_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        with open(self.state) as fh:
            state = json.load(fh)
        state["status"] = "wtf"
        with open(self.state, "w") as fh:
            json.dump(state, fh)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.next_node(self.state, self.brief_out)
        self.assertTrue(os.path.exists(self.state))


class GraphWalkTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        for b in ("a.md", "b.md", "c.md", "d.md", "e.md"):
            with open(os.path.join(self.pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        self.state = os.path.join(self.repo, "state.json")
        self.brief_out = os.path.join(self.repo, "brief.md")
        self.verdict = os.path.join(self.repo, "verdict.json")

    def _bind(self, doc):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: flow\n")

    def _graph_doc(self):
        return {"name": "flow", "version": 3,
                "caps": {"max_sessions_per_run": 10},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "b", "type": "check", "brief_ref": "b.md"},
                    {"id": "ok", "type": "summarize", "brief_ref": "c.md"},
                    {"id": "bad", "type": "notify", "brief_ref": "d.md"},
                    {"id": "always", "type": "journal", "brief_ref": "e.md",
                     "join": "any"}],
                "edges": [
                    {"from": "a", "to": "b", "on": "success"},
                    {"from": "b", "to": "ok", "on": "success"},
                    {"from": "b", "to": "bad", "on": "failure"},
                    {"from": "ok", "to": "always", "on": "completion"},
                    {"from": "bad", "to": "always", "on": "completion"}],
                "containers": []}

    def _drive(self, outcomes=None):
        """Walk to DONE. outcomes maps node id -> success|error (default
        success). Returns (picks, done_line)."""
        outcomes = outcomes or {}
        picks = []
        for _ in range(40):
            step = pipeline.next_node(self.state, self.brief_out)
            if step["status"] == "done":
                return picks, "DONE %s" % step["outcome"]
            nid = step["node"]
            picks.append(nid)
            res = pipeline.record_outcome(self.state, nid,
                                          outcomes.get(nid, "success"),
                                          verdict_path=self.verdict)
            if res.startswith("DONE"):
                return picks, res
        self.fail("walk did not terminate")

    def test_success_path_skips_failure_lane(self):
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        picks, done = self._drive()
        self.assertEqual(picks, ["a", "b", "ok", "always"])
        self.assertEqual(done, "DONE success")
        self.assertFalse(os.path.exists(self.state))

    def test_failure_edge_consumes_failure(self):
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        picks, done = self._drive({"b": "error"})
        self.assertEqual(picks, ["a", "b", "bad", "always"])
        self.assertEqual(done, "DONE success")   # the failure was HANDLED

    def test_unhandled_failure_fails_run(self):
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        picks, done = self._drive({"a": "error"})
        self.assertEqual(picks, ["a"])
        self.assertEqual(done, "DONE failure")

    def test_completion_does_not_fire_from_skipped(self):
        # always hangs ONLY off ok (join all); b fails handled by bad ->
        # ok skipped -> always skipped; run still success (failure handled).
        doc = self._graph_doc()
        doc["nodes"][4] = {"id": "always", "type": "journal",
                           "brief_ref": "e.md"}
        doc["edges"] = [
            {"from": "a", "to": "b", "on": "success"},
            {"from": "b", "to": "ok", "on": "success"},
            {"from": "b", "to": "bad", "on": "failure"},
            {"from": "ok", "to": "always", "on": "completion"}]
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        picks, done = self._drive({"b": "error"})
        self.assertEqual(picks, ["a", "b", "bad"])
        self.assertEqual(done, "DONE success")

    def test_join_all_fanin_strict(self):
        # d needs BOTH b and c (S33 semantics); c errors unhandled ->
        # d skipped, run failure.
        doc = {"name": "flow", "version": 3,
               "caps": {"max_sessions_per_run": 10},
               "nodes": [
                   {"id": "a", "type": "pick", "brief_ref": "a.md"},
                   {"id": "b", "type": "check", "brief_ref": "b.md"},
                   {"id": "c", "type": "check", "brief_ref": "c.md"},
                   {"id": "d", "type": "summarize", "brief_ref": "d.md"}],
               "edges": [
                   {"from": "a", "to": "b", "on": "success"},
                   {"from": "a", "to": "c", "on": "success"},
                   {"from": "b", "to": "d", "on": "success"},
                   {"from": "c", "to": "d", "on": "success"}],
               "containers": []}
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        picks, done = self._drive({"c": "error"})
        self.assertEqual(picks, ["a", "b", "c"])
        self.assertEqual(done, "DONE failure")

    def test_implicit_chain_synthesized_into_state(self):
        doc = {"name": "flow", "version": 1,
               "caps": {"max_sessions_per_run": 5},
               "nodes": [
                   {"id": "a", "type": "pick", "brief_ref": "a.md"},
                   {"id": "b", "type": "check", "brief_ref": "b.md"},
                   {"id": "c", "type": "summarize", "brief_ref": "c.md"}],
               "edges": [], "containers": []}
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        with open(self.state) as fh:
            st = json.load(fh)
        self.assertEqual(st["fmt"], 2)
        self.assertEqual(len(st["doc"]["edges"]), 2)   # a->b, b->c

    def test_verdict_outcome_steers_failure_edge(self):
        # session SUCCEEDS but its structured verdict says failure -> the
        # failure path runs (the branch mechanism).
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        picks = []
        for _ in range(10):
            step = pipeline.next_node(self.state, self.brief_out)
            if step["status"] == "done":
                break
            picks.append(step["node"])
            if step["node"] == "b":
                with open(self.verdict, "w") as fh:
                    json.dump({"outcome": "failure"}, fh)
            else:
                try:
                    os.unlink(self.verdict)
                except OSError:
                    pass
            res = pipeline.record_outcome(self.state, step["node"], "success",
                                          verdict_path=self.verdict)
            if res.startswith("DONE"):
                break
        self.assertEqual(picks, ["a", "b", "bad", "always"])
        self.assertEqual(res, "DONE success")

    def test_errored_session_verdict_never_rescues(self):
        # error + verdict {"outcome": "success"} stays a failure (fail-safe).
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, self.brief_out)
        pipeline.record_outcome(self.state, "a", "success",
                                verdict_path=self.verdict)
        pipeline.next_node(self.state, self.brief_out)
        with open(self.verdict, "w") as fh:
            json.dump({"outcome": "success"}, fh)
        pipeline.record_outcome(self.state, "b", "error",
                                verdict_path=self.verdict)
        step = pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(step["node"], "bad")   # the failure edge fired

    def test_p1_format_state_refused(self):
        self._bind(self._graph_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        with open(self.state) as fh:
            st = json.load(fh)
        del st["fmt"]
        with open(self.state, "w") as fh:
            json.dump(st, fh)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.next_node(self.state, self.brief_out)
        self.assertTrue(os.path.exists(self.state))


class ReadySetTest(unittest.TestCase):
    """P2b (#351): the batch dispatch protocol -- ready marks units
    dispatched, retry releases them, the batch blocks finish/skip."""
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        for b in ("a.md", "b.md", "c.md", "d.md", "e.md"):
            with open(os.path.join(self.pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        self.state = os.path.join(self.repo, "state.json")
        self.bdir = os.path.join(self.repo, "briefs")
        os.makedirs(self.bdir)
        self.verdict = os.path.join(self.repo, "verdict.json")

    def _bind(self, doc):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: flow\n")

    def _fan_doc(self, max_parallel=3):
        # the template's fan: g -> (x, y, z) -> j (join all), failure -> p (any)
        return {"name": "flow", "version": 3,
                "caps": {"max_sessions_per_run": 10,
                         "max_parallel": max_parallel},
                "nodes": [
                    {"id": "g", "type": "gather", "brief_ref": "a.md"},
                    {"id": "x", "type": "check", "brief_ref": "b.md"},
                    {"id": "y", "type": "check", "brief_ref": "c.md"},
                    {"id": "z", "type": "check", "brief_ref": "d.md"},
                    {"id": "j", "type": "summarize", "brief_ref": "e.md"},
                    {"id": "p", "type": "notify", "brief_ref": "e.md",
                     "join": "any"}],
                "edges": [
                    {"from": "g", "to": "x", "on": "success"},
                    {"from": "g", "to": "y", "on": "success"},
                    {"from": "g", "to": "z", "on": "success"},
                    {"from": "x", "to": "j", "on": "success"},
                    {"from": "y", "to": "j", "on": "success"},
                    {"from": "z", "to": "j", "on": "success"},
                    {"from": "x", "to": "p", "on": "failure"},
                    {"from": "y", "to": "p", "on": "failure"},
                    {"from": "z", "to": "p", "on": "failure"}],
                "containers": []}

    def test_max_parallel_validated(self):
        doc = minimal_doc(); doc["caps"]["max_parallel"] = 0
        self.assertTrue(pipeline.validate_doc(doc, None))
        doc["caps"]["max_parallel"] = 9
        self.assertTrue(pipeline.validate_doc(doc, None))
        doc["caps"]["max_parallel"] = 3
        del doc["nodes"][0]["brief_ref"]
        doc["nodes"][0]["legacy_prompt"] = ".autonomy/loop_prompt.md"
        self.assertEqual(pipeline.validate_doc(doc, None), [])

    def test_ready_set_marks_dispatched_and_excludes_them(self):
        self._bind(self._fan_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        first = pipeline.ready_set(self.state, self.bdir, 3)
        self.assertEqual([s["node"] for s in first], ["g"])   # only root ready
        pipeline.record_outcome(self.state, "g", "success")
        batch = pipeline.ready_set(self.state, self.bdir, 3)
        self.assertEqual([s["node"] for s in batch], ["x", "y", "z"])
        with open(self.state) as fh:
            st = json.load(fh)
        self.assertEqual(
            [st["units"][u]["status"] for u in ("x", "y", "z")],
            ["dispatched"] * 3)
        # each block carries its OWN brief + verdict paths
        self.assertEqual(len(set(s["prompt"] for s in batch)), 3)
        self.assertEqual(len(set(s["verdict"] for s in batch)), 3)

    def test_failure_record_cannot_skip_a_dispatched_sibling(self):
        self._bind(self._fan_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.ready_set(self.state, self.bdir, 1)
        pipeline.record_outcome(self.state, "g", "success")
        pipeline.ready_set(self.state, self.bdir, 3)          # x,y,z dispatched
        # x fails; y and z ALREADY RAN concurrently -- their records must
        # still be accepted afterwards (they were dispatched, not skipped).
        self.assertEqual(
            pipeline.record_outcome(self.state, "x", "error"), "CONTINUE")
        self.assertEqual(
            pipeline.record_outcome(self.state, "y", "success"), "CONTINUE")
        res = pipeline.record_outcome(self.state, "z", "success")
        # x's failure fired p (join any); j skipped (join all, dead edge)
        step = pipeline.next_node(self.state, os.path.join(self.bdir, "n.md"))
        self.assertEqual(step["node"], "p")

    def test_walk_cannot_finish_while_batch_outstanding(self):
        self._bind(self._fan_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.ready_set(self.state, self.bdir, 1)
        pipeline.record_outcome(self.state, "g", "success")
        pipeline.ready_set(self.state, self.bdir, 3)
        pipeline.record_outcome(self.state, "x", "error")
        pipeline.record_outcome(self.state, "y", "error")
        # z still dispatched: even though p is ready and j is doomed, the
        # run must NOT finish or cap-finish around z.
        res = pipeline.record_outcome(self.state, "z", "error")
        self.assertEqual(res, "CONTINUE")
        self.assertTrue(os.path.exists(self.state))

    def test_retry_releases_a_dispatched_unit(self):
        self._bind(self._fan_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.ready_set(self.state, self.bdir, 1)
        pipeline.record_outcome(self.state, "g", "success")
        pipeline.ready_set(self.state, self.bdir, 3)
        self.assertEqual(
            pipeline.record_outcome(self.state, "y", "retry"), "CONTINUE")
        with open(self.state) as fh:
            st = json.load(fh)
        self.assertEqual(st["units"]["y"]["status"], "pending")
        self.assertEqual(st["sessions"], 1)          # retry never counts
        self.assertEqual(len(st["nodes_done"]), 1)   # no entry for y

    def test_ready_clamps_to_session_cap(self):
        doc = self._fan_doc()
        doc["caps"]["max_sessions_per_run"] = 3      # g + two more
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.ready_set(self.state, self.bdir, 3)
        pipeline.record_outcome(self.state, "g", "success")
        batch = pipeline.ready_set(self.state, self.bdir, 3)
        self.assertEqual(len(batch), 2)              # clamped, never overshot

    def test_ready_reclaims_stale_dispatched_after_crash(self):
        self._bind(self._fan_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.ready_set(self.state, self.bdir, 1)
        pipeline.record_outcome(self.state, "g", "success")
        pipeline.ready_set(self.state, self.bdir, 3)
        # "crash": a fresh dispatcher asks again -- the dispatched units
        # come back (duplicate work beats a stranded run).
        batch = pipeline.ready_set(self.state, self.bdir, 3)
        self.assertEqual([s["node"] for s in batch], ["x", "y", "z"])


class BackEdgeTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        for b in ("a.md", "w.md", "v.md", "d.md", "p.md"):
            with open(os.path.join(self.pdir, b), "w") as fh:
                fh.write("brief %s\n" % b)
        self.state = os.path.join(self.repo, "state.json")
        self.brief_out = os.path.join(self.repo, "brief.md")
        self.verdict = os.path.join(self.repo, "verdict.json")

    def _bind(self, doc):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n    pipeline: flow\n")

    def _ref_doc(self, max_bounces=2):
        return {"name": "flow", "version": 3,
                "caps": {"max_sessions_per_run": 20},
                "nodes": [
                    {"id": "a", "type": "pick", "brief_ref": "a.md"},
                    {"id": "w", "type": "agent_task", "brief_ref": "w.md"},
                    {"id": "v", "type": "check", "brief_ref": "v.md"},
                    {"id": "done", "type": "summarize", "brief_ref": "d.md"}],
                "edges": [
                    {"from": "a", "to": "L", "on": "success"},
                    {"from": "L", "to": "v", "on": "success"},
                    {"from": "v", "to": "L", "on": "failure", "back": True,
                     "max_bounces": max_bounces},
                    {"from": "v", "to": "done", "on": "success"}],
                "containers": [{"id": "L", "kind": "loop", "children": ["w"],
                                "exit_when": "done", "max_rounds": 2}]}

    def _step(self, expect, outcome="success", verdict=None):
        # NB: every call reloads state from DISK -- the bounce/reload
        # persistence the plan demands is exercised inherently.
        step = pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(step["status"], "node")
        self.assertEqual(step["node"], expect)
        if verdict is None:
            try:
                os.unlink(self.verdict)
            except OSError:
                pass
        else:
            with open(self.verdict, "w") as fh:
                json.dump(verdict, fh)
        return pipeline.record_outcome(self.state, expect, outcome,
                                       verdict_path=self.verdict)

    def test_back_edge_never_gates_readiness(self):
        # the blocking-fix regression: L is ready after a despite the OPEN
        # back-edge v->L.
        self._bind(self._ref_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self.assertEqual(self._step("a"), "CONTINUE")
        step = pipeline.next_node(self.state, self.brief_out)
        self.assertEqual(step["node"], "w")   # L's child -- L is ready

    def test_bounce_resets_loop_and_downstream(self):
        self._bind(self._ref_doc())
        pipeline.start_run(self.repo, "coder", self.state)
        self._step("a")
        self._step("w", verdict={"exit": True})            # L succeeds
        self._step("v", verdict={"outcome": "failure"})    # bounce 1
        self._step("w", verdict={"exit": True})            # L re-ran fresh
        self._step("v", verdict={"outcome": "success"})
        res = self._step("done")
        self.assertEqual(res, "DONE success")
        # journal carries the bounce map
        with open(self.state) if os.path.exists(self.state) else open(os.devnull) as fh:
            pass
        self.assertFalse(os.path.exists(self.state))

    def test_bounce_cap_exhausted_fails_run(self):
        self._bind(self._ref_doc(max_bounces=1))
        pipeline.start_run(self.repo, "coder", self.state)
        self._step("a")
        self._step("w", verdict={"exit": True})
        self._step("v", verdict={"outcome": "failure"})    # bounce 1
        self._step("w", verdict={"exit": True})
        res = self._step("v", verdict={"outcome": "failure"})  # cap hit
        self.assertEqual(res, "DONE failure")

    def test_bounce_cap_exhausted_falls_back_to_failure_edge(self):
        # the template shape: back-edge until the cap, THEN the non-back
        # failure edge parks -- while bounces remain, the reset re-opens the
        # fallback edge so it never fires prematurely.
        doc = self._ref_doc(max_bounces=1)
        doc["nodes"].append({"id": "park", "type": "notify",
                             "brief_ref": "p.md"})
        doc["edges"].append({"from": "v", "to": "park", "on": "failure"})
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        self._step("a")
        self._step("w", verdict={"exit": True})
        self._step("v", verdict={"outcome": "failure"})    # bounce 1 (no park)
        self._step("w", verdict={"exit": True})
        self._step("v", verdict={"outcome": "failure"})    # cap denied
        res = self._step("park")                           # fallback fired
        self.assertEqual(res, "DONE success")              # handled = parked

    def test_child_error_fires_container_failure_edge(self):
        doc = {"name": "flow", "version": 3,
               "caps": {"max_sessions_per_run": 10},
               "nodes": [
                   {"id": "a", "type": "pick", "brief_ref": "a.md"},
                   {"id": "w", "type": "agent_task", "brief_ref": "w.md"},
                   {"id": "park", "type": "notify", "brief_ref": "p.md"},
                   {"id": "done", "type": "summarize", "brief_ref": "d.md"}],
               "edges": [
                   {"from": "a", "to": "L", "on": "success"},
                   {"from": "L", "to": "done", "on": "success"},
                   {"from": "L", "to": "park", "on": "failure"}],
               "containers": [{"id": "L", "kind": "loop", "children": ["w"],
                               "exit_when": "done", "max_rounds": 2}]}
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        self._step("a")
        self._step("w", outcome="error")                   # container fails
        res = self._step("park")                           # failure edge fired
        self.assertEqual(res, "DONE success")              # failure HANDLED

    def test_loop_cap_exit_with_failure_edge_continues(self):
        doc = {"name": "flow", "version": 3,
               "caps": {"max_sessions_per_run": 10},
               "nodes": [
                   {"id": "a", "type": "pick", "brief_ref": "a.md"},
                   {"id": "w", "type": "agent_task", "brief_ref": "w.md"},
                   {"id": "park", "type": "notify", "brief_ref": "p.md"}],
               "edges": [
                   {"from": "a", "to": "L", "on": "success"},
                   {"from": "L", "to": "park", "on": "failure"}],
               "containers": [{"id": "L", "kind": "loop", "children": ["w"],
                               "exit_when": "done", "max_rounds": 2}]}
        self._bind(doc)
        pipeline.start_run(self.repo, "coder", self.state)
        self._step("a")
        self._step("w")                                    # round 1, no exit
        self._step("w")                                    # round 2 -> cap
        res = self._step("park")
        self.assertEqual(res, "DONE success")              # cap CONSUMED


class JournalLedgerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        os.makedirs(os.path.join(self.repo, ".autonomy"))
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("engine:\n  label: t\n")   # no roles block -> coder wraps
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"), "w") as fh:
            fh.write("legacy prompt\n")
        self.state = os.path.join(self.repo, "state.json")
        self.journal = os.path.join(self.repo, "journal.jsonl")

    def _finish_wrapped_run(self, outcome="success"):
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, os.path.join(self.repo, "brief.md"))
        pipeline.record_outcome(self.state, "act",
                                "success" if outcome == "success" else "error",
                                session_log="/x/session-1.log",
                                journal_path=self.journal)

    def test_done_run_appends_journal_line_with_trust_fields(self):
        self._finish_wrapped_run()
        with open(self.journal) as fh:
            lines = fh.read().splitlines()
        self.assertEqual(len(lines), 1)
        rec = json.loads(lines[0])
        self.assertEqual(rec["role"], "coder")
        self.assertEqual(rec["pipeline"], "legacy-coder")
        self.assertTrue(rec["wrapped"])
        self.assertEqual(rec["outcome"], "success")
        self.assertIs(rec["pass"], True)
        self.assertEqual(rec["sessions"], 1)
        self.assertEqual(rec["nodes"][0]["session_log"], "session-1.log")
        self.assertIn("merge_affecting", rec)
        self.assertIn("lane", rec)
        self.assertIsInstance(rec["started"], int)
        self.assertIsInstance(rec["finished"], int)

    def test_failure_run_pass_false(self):
        self._finish_wrapped_run(outcome="error")
        with open(self.journal) as fh:
            rec = json.loads(fh.read().splitlines()[0])
        self.assertEqual(rec["outcome"], "failure")
        self.assertIs(rec["pass"], False)

    def _write_journal(self, role, n_pass, n_fail):
        with open(self.journal, "a") as fh:
            for _ in range(n_pass):
                fh.write(json.dumps({"role": role, "outcome": "success",
                                     "pass": True}) + "\n")
            for _ in range(n_fail):
                fh.write(json.dumps({"role": role, "outcome": "failure",
                                     "pass": False}) + "\n")

    def test_ledger_watch_below_20_runs(self):
        self._write_journal("coder", 19, 0)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")

    def test_ledger_auto_at_20_runs_95pct(self):
        self._write_journal("coder", 19, 1)
        led = pipeline.ledger(self.journal, "coder")
        self.assertEqual((led["runs"], led["passes"], led["tier"]),
                         (20, 19, "auto"))

    def test_ledger_demotes_below_95(self):
        self._write_journal("coder", 18, 2)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")

    def test_ledger_total_reader_skips_junk(self):
        with open(self.journal, "w") as fh:
            fh.write("garbage line\n")
            fh.write(json.dumps(["not", "a", "dict"]) + "\n")
            fh.write(json.dumps({"role": "coder", "outcome": "success",
                                 "pass": True}) + "\n")
        led = pipeline.ledger(self.journal, "coder")
        self.assertEqual((led["runs"], led["passes"]), (1, 1))

    def test_ledger_missing_journal_is_watch_zero(self):
        self.assertEqual(pipeline.ledger("/nope/journal.jsonl", "coder"),
                         {"runs": 0, "passes": 0, "tier": "watch"})

    def test_ledger_filters_by_role(self):
        self._write_journal("coder", 25, 0)
        self._write_journal("pm", 1, 5)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "auto")
        self.assertEqual(pipeline.ledger(self.journal, "pm")["tier"], "watch")

    def test_ledger_scopes_to_assignment_not_role(self):
        # v5 §10: trust is earned per ASSIGNMENT -- rebinding a role to a new
        # pipeline must not inherit the old pipeline's record.
        with open(self.journal, "a") as fh:
            for _ in range(25):
                fh.write(json.dumps({"role": "coder", "pipeline": "old-flow",
                                     "outcome": "success", "pass": True}) + "\n")
        led = pipeline.ledger(self.journal, "coder", pipeline_name="new-flow")
        self.assertEqual((led["runs"], led["tier"]), (0, "watch"))
        led = pipeline.ledger(self.journal, "coder", pipeline_name="old-flow")
        self.assertEqual(led["tier"], "auto")

    def test_ledger_windowed_demotion(self):
        # 40 passes then 2 recent failures: lifetime 40/42 ~= 0.952 (>=0.95)
        # but the last-20 window is 18/20 = 0.90 -> demoted. §10's decay
        # demotion must respond to RECENT decay.
        self._write_journal("coder", 40, 0)
        self._write_journal("coder", 0, 2)
        self.assertEqual(pipeline.ledger(self.journal, "coder")["tier"], "watch")


class StarterTemplateTest(unittest.TestCase):
    def test_ticket_to_merge_template_validates(self):
        pdir = os.path.join(os.path.dirname(__file__), "..", "templates",
                            "autonomy-pack", "pipelines", "ticket-to-merge")
        doc = pipeline.load_doc(os.path.join(pdir, "pipeline.json"))
        self.assertEqual(pipeline.validate_doc(doc, pdir), [])
        self.assertEqual(doc["name"], "ticket-to-merge")
        self.assertEqual(doc["version"], 2)
        kinds = [c["kind"] for c in doc["containers"]]
        self.assertIn("loop", kinds)
        self.assertTrue(any(e.get("back") for e in doc["edges"]))
        self.assertTrue(any(e.get("on") == "failure" for e in doc["edges"]))
        self.assertTrue(any(n.get("join") == "any" for n in doc["nodes"]))


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
