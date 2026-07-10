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

    # P2b lifted the lane-pinned cron refusal with the trigger-agnostic
    # in-flight dispatch (see test_resolve_accepts_multinode_on_cron_role_p2b).

    def test_resolve_missing_legacy_prompt_REFUSES_early(self):
        # A run state for an unrunnable doc would strand in-flight -- refuse
        # BEFORE any state exists.
        os.unlink(os.path.join(self.repo, ".autonomy", "loop_prompt.md"))
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_pipeline(self.repo, "coder")

    def test_resolve_accepts_multinode_on_cron_role_p2b(self):
        # P2b (#351): an in-flight run JOINS the main loop's dispatch list,
        # so a cron fire only STARTS the run -- the P1/P2a refusal lifts.
        d = minimal_doc(); d["name"] = "p1"
        d["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        self._write_pipeline(d)
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"), "w") as fh:
            fh.write("roles:\n  pm:\n    enabled: true\n"
                     "    trigger:\n      type: cron\n"
                     "      schedule: '0 * * * *'\n"
                     "    pipeline: p1\n")
        doc, meta = pipeline.resolve_pipeline(self.repo, "pm")
        self.assertEqual(len(doc["nodes"]), 2)


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


class SpecSheetTest(unittest.TestCase):
    """SPEC_SHEETS is the activity-catalog SSOT (P3a, #357): the validator
    vocabulary is DERIVED from it so palette/pane/validator cannot drift."""

    def test_catalog_covers_validator_vocabulary(self):
        sheet_nodes = set(k for k, v in pipeline.SPEC_SHEETS.items()
                          if v["group"] != "structure")
        self.assertEqual(
            sheet_nodes,
            set(pipeline.NODE_TYPES) | set(pipeline.DEFERRED_NODE_TYPES))

    def test_deferred_flag_matches_validator(self):
        for k in pipeline.DEFERRED_NODE_TYPES:
            self.assertTrue(pipeline.SPEC_SHEETS[k]["deferred"], k)
        for k in pipeline.NODE_TYPES:
            self.assertFalse(pipeline.SPEC_SHEETS[k]["deferred"], k)

    def test_deferred_reasons_stay_the_validator_refusal_strings(self):
        # DEFERRED_NODE_TYPES stays a dict[type -> reason] (validate_doc
        # indexes it for the refusal message) -- derived from the sheets.
        for k, reason in pipeline.DEFERRED_NODE_TYPES.items():
            self.assertTrue(isinstance(reason, str) and reason.strip())
            self.assertEqual(reason, pipeline.SPEC_SHEETS[k]["deferred_reason"])

    def test_entry_shape_total(self):
        for k, v in pipeline.SPEC_SHEETS.items():
            for key in ("label", "group", "icon", "required", "optional",
                        "emits", "deferred", "guarded"):
                self.assertIn(key, v, "%s missing %s" % (k, key))

    def test_containers_present(self):
        for k in ("loop", "stage", "branch", "for_each"):
            self.assertEqual(pipeline.SPEC_SHEETS[k]["group"], "structure")


class GarbageShapeTest(unittest.TestCase):
    """CP2 (P3a, #357): the viewer renders INVALID docs, so validate_doc is
    a display-boundary error source -- garbage shapes must come back as
    error strings, never exceptions."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        with open(os.path.join(self.dir, "act.md"), "w") as fh:
            fh.write("do\n")

    def test_garbage_children_shapes_error_not_crash(self):
        # CP2 (P3a): validate_doc is the DISPLAY boundary's error source --
        # a garbage shape must come back as an error STRING, never a
        # TypeError out of a set operation (unhashable dict children).
        doc = minimal_doc()
        doc["containers"] = [{"id": "L", "kind": "loop",
                              "children": [{}, 5, None],
                              "exit_when": "done", "max_rounds": 3}]
        errs = pipeline.validate_doc(doc, self.dir)
        self.assertTrue(any("children" in e for e in errs))

    def test_garbage_node_id_shapes_error_not_crash(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": {"weird": 1}, "type": "check",
                             "brief_ref": "act.md"})
        errs = pipeline.validate_doc(doc, self.dir)
        self.assertTrue(any("id required" in e for e in errs))

    def test_valid_pipeline_name(self):
        self.assertTrue(pipeline.valid_pipeline_name("ticket-to-merge"))
        self.assertFalse(pipeline.valid_pipeline_name("../outside"))
        self.assertFalse(pipeline.valid_pipeline_name(""))
        self.assertFalse(pipeline.valid_pipeline_name(None))


class EffectiveEdgesTest(unittest.TestCase):
    def test_declared_edges_returned_verbatim(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        doc["edges"] = [{"from": "act", "to": "b", "on": "failure"}]
        self.assertEqual(pipeline.effective_edges(doc), doc["edges"])

    def test_empty_edges_synthesize_success_chain(self):
        doc = minimal_doc()
        doc["nodes"].append({"id": "b", "type": "check", "brief_ref": "act.md"})
        edges = pipeline.effective_edges(doc)
        self.assertEqual(edges, [{"from": "act", "to": "b", "on": "success"}])

    def test_containers_are_chain_units(self):
        # the synthesized chain runs over TOP-LEVEL units: a container id
        # appears in the chain, its children do not.
        doc = minimal_doc()
        doc["nodes"] += [{"id": "b", "type": "check", "brief_ref": "act.md"},
                         {"id": "c", "type": "check", "brief_ref": "act.md"},
                         {"id": "d", "type": "journal", "brief_ref": "act.md"}]
        doc["containers"] = [{"id": "L", "kind": "loop", "children": ["b", "c"],
                              "exit_when": "done", "max_rounds": 3}]
        edges = pipeline.effective_edges(doc)
        self.assertEqual(edges, [{"from": "act", "to": "L", "on": "success"},
                                 {"from": "L", "to": "d", "on": "success"}])


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


class EffectivePipelineDirTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.committed = os.path.join(
            self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.committed)
        # A minimal VALID doc: validate_doc requires caps.max_sessions_per_run
        # AND an edges list (lib/pipeline.py:330,461) -- Codex CP1 finding #1.
        with open(os.path.join(self.committed, "pipeline.json"), "w") as fh:
            json.dump({"name": "flow", "version": 1,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "pick",
                                  "brief_ref": "a.md"}], "edges": []}, fh)

    def _shadow(self):
        d = os.path.join(self.repo, "var", "autonomy", "pipelines", "flow")
        os.makedirs(d)
        return d

    def test_no_shadow_returns_committed(self):
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"),
                         self.committed)

    def test_shadow_with_pipeline_json_wins(self):
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            fh.write("{}")
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"), d)

    def test_empty_shadow_dir_is_used_then_refuses(self):
        # dir present, pipeline.json missing -> a present-but-invalid shadow:
        # the resolver returns IT (never committed), so dispatch refuses
        # (fail-safe, Codex CP2) rather than silently running the committed pack.
        d = self._shadow()
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"), d)

    def test_symlinked_shadow_ignored(self):
        # a symlinked shadow is not a sanctioned shadow -> resolver returns
        # committed, never following the link out of var/ (Codex CP2).
        parent = os.path.join(self.repo, "var", "autonomy", "pipelines")
        os.makedirs(parent)
        os.symlink(self.committed, os.path.join(parent, "flow"))
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"),
                         self.committed)

    def test_invalid_shadow_still_wins_no_fallback(self):
        # a shadow whose pipeline.json is present-but-garbage is NOT a fallback
        # case: the resolver returns the shadow, dispatch then RAISES on it
        # (fail-safe, prevention-log #3) -- never a silent widen to committed.
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            fh.write("{ not json")
        self.assertEqual(pipeline.effective_pipeline_dir(self.repo, "flow"), d)

    def test_resolve_pipeline_reads_the_shadow(self):
        # bind the role, give the shadow a DIFFERENT valid doc, assert
        # resolve_pipeline returns the shadow's doc, not committed's.
        cfg = os.path.join(self.repo, ".autonomy", "config.yaml")
        with open(cfg, "w") as fh:
            fh.write("roles:\n  coder:\n    pipeline: flow\n")
        with open(os.path.join(self.committed, "a.md"), "w") as fh:
            fh.write("committed brief\n")
        d = self._shadow()
        with open(os.path.join(d, "pipeline.json"), "w") as fh:
            json.dump({"name": "flow", "version": 9,
                       "caps": {"max_sessions_per_run": 16},
                       "nodes": [{"id": "a", "type": "pick",
                                  "brief_ref": "a.md"}], "edges": []}, fh)
        with open(os.path.join(d, "a.md"), "w") as fh:
            fh.write("shadow brief\n")
        doc, meta = pipeline.resolve_pipeline(self.repo, "coder")
        self.assertEqual(doc["version"], 9)               # shadow, not committed
        self.assertEqual(meta["pipeline_dir"], d)


class ParamsOutputsValidationTest(unittest.TestCase):
    def _doc(self, **over):
        d = {"name": "flow", "version": 1,
             "caps": {"max_sessions_per_run": 16},
             "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
             "edges": []}
        d.update(over)
        return d

    def test_valid_params_and_outputs_accepted(self):
        d = self._doc(
            params=[{"name": "repo", "type": "repo", "required": True},
                    {"name": "model", "type": "model", "default": "claude-sonnet-5"},
                    {"name": "mode", "type": "enum", "choices": ["a", "b"], "default": "a"}],
            outputs=[{"name": "pr", "type": "number"}])
        self.assertEqual(pipeline.validate_doc(d, None), [])

    def test_unknown_param_type_refused(self):
        d = self._doc(params=[{"name": "x", "type": "wat"}])
        errs = pipeline.validate_doc(d, None)
        self.assertTrue(any("type" in e for e in errs))

    def test_param_bad_name_charset_refused(self):
        d = self._doc(params=[{"name": "../x", "type": "string"}])
        self.assertTrue(pipeline.validate_doc(d, None))

    def test_enum_requires_choices(self):
        d = self._doc(params=[{"name": "m", "type": "enum"}])
        self.assertTrue(any("choices" in e for e in pipeline.validate_doc(d, None)))

    def test_default_must_be_in_choices(self):
        d = self._doc(params=[{"name": "m", "type": "enum",
                               "choices": ["a"], "default": "z"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(d, None)))

    def test_non_enum_default_type_checked_at_declare(self):
        bad = self._doc(params=[{"name": "n", "type": "number", "default": "abc"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(bad, None)))
        badb = self._doc(params=[{"name": "b", "type": "bool", "default": "maybe"}])
        self.assertTrue(any("default" in e for e in pipeline.validate_doc(badb, None)))
        ok = self._doc(params=[{"name": "n", "type": "number", "default": 3}])
        self.assertEqual(pipeline.validate_doc(ok, None), [])

    def test_duplicate_param_names_refused(self):
        d = self._doc(params=[{"name": "x", "type": "string"},
                              {"name": "x", "type": "number"}])
        self.assertTrue(any("duplicate" in e for e in pipeline.validate_doc(d, None)))

    def test_output_needs_name_and_type(self):
        d = self._doc(outputs=[{"name": "pr"}])
        self.assertTrue(pipeline.validate_doc(d, None))

    def test_params_not_a_list_refused(self):
        self.assertTrue(pipeline.validate_doc(self._doc(params={}), None))

    def test_reference_in_activity_field_now_accepted(self):
        # Phase B wired substitution into prepare, so the Phase A wholesale
        # refusal is gone: a DECLARED param ref validates; an undeclared one
        # is a check_refs error; concrete garbage still refuses.
        d = self._doc(params=[{"name": "coder_agent", "type": "agent",
                               "default": "claude-code"}],
                      nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                              "runs_as": {"agent": "${params.coder_agent}"}}])
        self.assertEqual(pipeline.validate_doc(d, None), [])
        d_undeclared = self._doc(
            nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                    "runs_as": {"agent": "${params.coder_agent}"}}])
        self.assertTrue(pipeline.validate_doc(d_undeclared, None))
        d2 = self._doc(nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                               "runs_as": {"agent": "bad agent!"}}])
        self.assertTrue(pipeline.validate_doc(d2, None))

    def test_no_params_key_still_valid(self):    # back-compat: params optional
        self.assertEqual(pipeline.validate_doc(self._doc(), None), [])


class SubstituteRefsTest(unittest.TestCase):
    def setUp(self):
        self.ctx = {"params": {"repo": "/tmp/r", "n": 3, "flag": True},
                    "nodes": {"code": {"branch": "feat/x"}},
                    "run": {"id": "r1", "pipeline": "flow"}}

    def test_whole_value_keeps_type(self):
        self.assertEqual(pipeline.substitute("${params.n}", self.ctx), 3)   # int, not "3"
        self.assertIs(pipeline.substitute("${params.flag}", self.ctx), True)

    def test_whole_value_string(self):
        self.assertEqual(pipeline.substitute("${params.repo}", self.ctx), "/tmp/r")

    def test_node_output_ref(self):
        self.assertEqual(pipeline.substitute("${nodes.code.output.branch}", self.ctx),
                         "feat/x")

    def test_run_field_ref(self):
        self.assertEqual(pipeline.substitute("${run.id}", self.ctx), "r1")

    def test_interpolation_is_string(self):
        self.assertEqual(pipeline.substitute("release/${params.repo}/${run.id}", self.ctx),
                         "release//tmp/r/r1")
        self.assertEqual(pipeline.substitute("n=${params.n}", self.ctx), "n=3")

    def test_non_string_passthrough(self):
        self.assertEqual(pipeline.substitute(7, self.ctx), 7)
        self.assertEqual(pipeline.substitute(None, self.ctx), None)

    def test_unknown_param_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${params.missing}", self.ctx)

    def test_unknown_namespace_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${bogus.x}", self.ctx)

    def test_unknown_node_output_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${nodes.code.output.nope}", self.ctx)

    def test_escape_literal_dollar_brace(self):
        self.assertEqual(pipeline.substitute("cost $${params.n}", self.ctx),
                         "cost ${params.n}")


class SubstituteFuncsTest(unittest.TestCase):
    def setUp(self):
        self.ctx = {"params": {"model": "", "ticket": "AE-12", "a": "x"},
                    "nodes": {}, "run": {}}

    def test_default_uses_fallback_when_empty(self):
        self.assertEqual(pipeline.substitute(
            "${default(params.model, 'claude-sonnet-5')}", self.ctx), "claude-sonnet-5")

    def test_default_uses_value_when_set(self):
        self.ctx["params"]["model"] = "opus"
        self.assertEqual(pipeline.substitute(
            "${default(params.model, 'x')}", self.ctx), "opus")

    def test_concat(self):
        self.assertEqual(pipeline.substitute(
            "${concat('release/', params.ticket)}", self.ctx), "release/AE-12")

    def test_slug(self):
        self.assertEqual(pipeline.substitute(
            "${slug(concat(params.ticket, ' Fix Bug'))}", self.ctx), "ae-12-fix-bug")

    def test_nested_refs_and_literals(self):
        self.assertEqual(pipeline.substitute(
            "${concat(params.a, '-', params.ticket)}", self.ctx), "x-AE-12")

    def test_unknown_function_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${danger(params.a)}", self.ctx)

    def test_no_eval_arbitrary_expr_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${__import__('os').system('x')}", self.ctx)

    def test_wrong_arity_refuses(self):
        for expr in ("${slug()}", "${slug(params.a, 'x')}", "${default(params.a)}",
                     "${default(params.a, 'x', 'y')}"):
            with self.assertRaises(pipeline.PipelineError):
                pipeline.substitute(expr, self.ctx)

    def test_brace_in_literal_is_a_documented_limitation_refuses(self):
        # Low (Codex CP1): _REF_RE stops at the first '}', so a '}' inside a
        # quoted literal truncates the body -> it fails to parse and RAISES
        # (fail-safe, never a silent mis-resolve). Documented constraint:
        # string literals inside ${...} may not contain '}'.
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${concat('a}b', params.a)}", self.ctx)


class ResolveParamsTest(unittest.TestCase):
    def _decl(self):
        return [{"name": "repo", "type": "repo", "required": True},
                {"name": "model", "type": "model", "default": "claude-sonnet-5"},
                {"name": "retries", "type": "number", "default": 2},
                {"name": "mode", "type": "enum", "choices": ["fast", "safe"], "default": "safe"},
                {"name": "token", "type": "secret", "required": False}]

    def test_default_when_no_override(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r"})
        self.assertEqual(got["model"], "claude-sonnet-5")
        self.assertEqual(got["retries"], 2)

    def test_override_wins(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r", "model": "opus"})
        self.assertEqual(got["model"], "opus")

    def test_required_unset_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {})          # repo missing

    def test_unknown_override_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "nope": 1})

    def test_enum_override_must_be_a_choice(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "mode": "wild"})

    def test_number_type_coerced_and_checked(self):
        got = pipeline.resolve_params(self._decl(), {"repo": "/r", "retries": "5"})
        self.assertEqual(got["retries"], 5)                    # coerced to int
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params(self._decl(), {"repo": "/r", "retries": "abc"})

    def test_secret_resolves_via_lookup_and_is_not_the_name(self):
        seen = {}
        def fake_lookup(name):
            seen["asked"] = name
            return "s3cr3t"
        got = pipeline.resolve_params(
            [{"name": "token", "type": "secret", "required": True}],
            {"token": "PROD_KEY"}, secret_lookup=fake_lookup)
        self.assertEqual(got["token"], "s3cr3t")
        self.assertEqual(seen["asked"], "PROD_KEY")

    def test_secret_without_lookup_refuses(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.resolve_params([{"name": "t", "type": "secret", "required": True}],
                                    {"t": "K"})                # no secret_lookup seam


class OutputsFileTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)
        self.p = os.path.join(self.d, ".run-r1-outputs.json")

    def test_write_then_read_roundtrip(self):
        pipeline.write_output(self.p, "branch", "feat/x")
        pipeline.write_output(self.p, "pr", 42)
        self.assertEqual(pipeline.read_outputs(self.p), {"branch": "feat/x", "pr": 42})

    def test_read_missing_is_empty_total(self):
        self.assertEqual(pipeline.read_outputs(self.p + "-nope"), {})

    def test_read_corrupt_is_empty_total(self):
        with open(self.p, "w") as fh:
            fh.write("{ not json")
        self.assertEqual(pipeline.read_outputs(self.p), {})

    def test_project_outputs_keeps_only_declared(self):
        raw = {"pr": 42, "branch": "feat/x", "secret_junk": "x"}
        decl = [{"name": "pr", "type": "number"}]
        self.assertEqual(pipeline.project_outputs(decl, raw), {"pr": 42})

    def test_project_outputs_type_mismatch_raises(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.project_outputs([{"name": "pr", "type": "number"}], {"pr": "abc"})

    def test_project_outputs_missing_declared_is_absent(self):
        self.assertEqual(pipeline.project_outputs(
            [{"name": "pr", "type": "number"}, {"name": "x", "type": "string"}],
            {"pr": 7}), {"pr": 7})

    def test_write_is_atomic_and_bounded(self):
        pipeline.write_output(self.p, "a", "1")
        # a second writer never corrupts the file (tmp+replace); still valid JSON
        pipeline.write_output(self.p, "b", "2")
        self.assertEqual(sorted(pipeline.read_outputs(self.p)), ["a", "b"])


class SubstituteDocTest(unittest.TestCase):
    def test_deep_substitutes_strings_only(self):
        doc = {"name": "flow", "nodes": [
            {"id": "a", "runs_as": {"model": "${params.m}"}, "count": 3}]}
        ctx = {"params": {"m": "opus"}, "nodes": {}, "run": {}}
        out = pipeline.substitute_doc(doc, ctx)
        self.assertEqual(out["nodes"][0]["runs_as"]["model"], "opus")
        self.assertEqual(out["nodes"][0]["count"], 3)             # non-string untouched
        self.assertEqual(doc["nodes"][0]["runs_as"]["model"], "${params.m}")  # input intact


class Cp2HonestyHardeningTest(unittest.TestCase):
    """Codex CP2 findings on the Phase A diff: the ${...} honesty gate must
    cover EVERY activity string field (not just charset-gated agent/account),
    output types must not be fail-open, and a malformed ref must raise."""

    def _doc(self, **over):
        d = {"name": "flow", "version": 1,
             "caps": {"max_sessions_per_run": 16},
             "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
             "edges": []}
        d.update(over)
        return d

    def test_ref_in_runs_as_model_refused_in_phase_a(self):
        # runs_as.model has no charset gate (any non-empty string), so without
        # an explicit ${ gate this doc validates and dispatch would consume the
        # LITERAL "${params.model}" -- the fail-open the honesty invariant forbids.
        d = self._doc(nodes=[{"id": "a", "type": "agent_task", "brief_ref": "a.md",
                              "runs_as": {"model": "${params.model}"}}])
        self.assertTrue(any("Phase B" in e or "${" in e
                            for e in pipeline.validate_doc(d, None)))

    def test_ref_in_legacy_prompt_refused_in_phase_a(self):
        d = self._doc(nodes=[{"id": "a", "type": "agent_task",
                              "legacy_prompt": "${params.prompt}"}])
        self.assertTrue(any("${" in e for e in pipeline.validate_doc(d, None)))

    def test_ref_in_container_exit_when_refused_in_phase_a(self):
        d = self._doc(
            nodes=[{"id": "a", "type": "pick", "brief_ref": "a.md"}],
            containers=[{"id": "c", "kind": "loop", "children": ["a"],
                         "exit_when": "done per ${params.criteria}",
                         "max_rounds": 3}])
        self.assertTrue(any("${" in e for e in pipeline.validate_doc(d, None)))

    def test_enum_and_secret_output_types_refused(self):
        # enum outputs have no choices channel (fail-open type-check); a secret
        # output would land a secret VALUE in the plaintext run-outputs file.
        for typ in ("enum", "secret"):
            d = self._doc(outputs=[{"name": "x", "type": typ}])
            self.assertTrue(pipeline.validate_doc(d, None), typ)

    def test_project_outputs_unsupported_type_raises_not_passes(self):
        for typ in ("enum", "secret", "wat"):
            with self.assertRaises(pipeline.PipelineError):
                pipeline.project_outputs([{"name": "x", "type": typ}], {"x": "v"})

    def test_unterminated_ref_raises_not_literal(self):
        ctx = {"params": {"repo": "/r"}, "nodes": {}, "run": {}}
        for bad in ("x ${params.repo", "${params.repo", "a ${run.id b"):
            with self.assertRaises(pipeline.PipelineError):
                pipeline.substitute(bad, ctx)
        # the $${ escape still passes through untouched
        self.assertEqual(pipeline.substitute("$${literal", ctx), "${literal")


class SubstitutionWiringTest(unittest.TestCase):
    """Drives ready_set over a hand-built fmt-2 state with ${} fields.
    start_run_trigger lands in Task 6; state['params']/'run' default to {}
    when absent, so every pre-existing state fixture keeps passing."""
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        os.makedirs(self.pdir)
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        os.makedirs(self.logdir)
        self.state = os.path.join(self.logdir, ".pipeline-run-t1.json")

    def _doc(self, nodes, edges, params=None):
        return {"name": "flow", "version": 1,
                "params": params or [
                    {"name": "m", "type": "model",
                     "default": "claude-sonnet-5"},
                    {"name": "ticket", "type": "string", "default": "AE-1"},
                    {"name": "eff", "type": "string", "default": "high"}],
                "caps": {"max_sessions_per_run": 8},
                "nodes": nodes, "edges": edges}

    def _write(self, doc, briefs, state_params=None, done=None, units=None):
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        for name, text in briefs.items():
            with open(os.path.join(self.pdir, name), "w") as fh:
                fh.write(text)
        d = dict(doc)
        d["edges"] = pipeline.effective_edges(d)
        st = {"fmt": 2, "run_id": "t1-x-1", "role": "t1", "lane": "",
              "doc": d,
              "meta": {"pipeline_dir": self.pdir, "wrapped": False,
                       "from": "flow", "from_version": 1},
              "trigger": "t1", "kind": "native",
              "params": state_params if state_params is not None else
                  {"m": "claude-sonnet-5", "ticket": "AE-1", "eff": "high"},
              "run": {"id": "t1-x-1", "pipeline": "flow", "trigger": "t1",
                      "repo": self.repo},
              "started": 0, "sessions": 0,
              "units": units or dict((u, {"status": "pending"})
                                     for u in pipeline._top_units(d)),
              "container_pos": {}, "rounds": {}, "bounces": {},
              "nodes_done": done or [], "status": "in_progress"}
        with open(self.state, "w") as fh:
            json.dump(st, fh)

    def _one_node(self, brief_text, runs_as=None):
        node = {"id": "a", "type": "pick", "brief_ref": "a.md"}
        if runs_as:
            node["runs_as"] = runs_as
        self._write(self._doc([node], []), {"a.md": brief_text})

    def test_validator_accepts_refs_in_activity_fields_now(self):
        d = self._doc([{"id": "a", "type": "pick", "brief_ref": "a.md"},
                       {"id": "b", "type": "agent_task", "brief_ref": "b.md",
                        "runs_as": {"model": "${params.m}",
                                    "effort": "${params.eff}"}}],
                      [{"from": "a", "to": "b", "on": "success"}])
        self.assertEqual(pipeline.validate_doc(d, None), [])

    def test_brief_text_interpolates_params(self):
        self._one_node("Work ${params.ticket} now")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("Work AE-1 now", fh.read())

    def test_runs_as_whole_value_substitution_is_typed(self):
        self._one_node("plain", runs_as={"model": "${params.m}"})
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        self.assertEqual(steps[0]["runs_as"]["model"], "claude-sonnet-5")

    def test_bad_resolved_effort_refuses_and_leaves_unit_pending(self):
        self._one_node("plain", runs_as={"effort": "${params.eff}"})
        # overwrite state params with a non-effort value
        with open(self.state) as fh:
            st = json.load(fh)
        st["params"]["eff"] = "not-an-effort"
        with open(self.state, "w") as fh:
            json.dump(st, fh)
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)
        with open(self.state) as fh:
            after = json.load(fh)
        self.assertEqual(after["units"]["a"]["status"], "pending")

    def test_upstream_output_ref_resolves_from_sidecar(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "work on ${nodes.a.output.branch}"},
                    done=[{"id": "a", "outcome": "success", "unit": "a"}],
                    units={"a": {"status": "success"},
                           "b": {"status": "pending"}})
        sidecar = os.path.join(self.logdir, ".pipeline-run-t1.a.outputs.json")
        pipeline.write_output(sidecar, "branch", "feat/x")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("work on feat/x", fh.read())

    def test_missing_upstream_output_refuses(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "on ${nodes.a.output.branch}"},
                    done=[{"id": "a", "outcome": "success", "unit": "a"}],
                    units={"a": {"status": "success"},
                           "b": {"status": "pending"}})
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)

    def test_stray_unknown_ref_in_brief_refuses(self):
        # validate_doc never reads brief BODIES, so a stray ref surfaces at
        # prepare -- refuse the dispatch, never send a template to an agent.
        self._one_node("do ${ghost.thing}")
        with self.assertRaises(pipeline.PipelineError):
            pipeline.ready_set(self.state, self.logdir, 1)

    def test_escaped_literal_in_brief_passes_through(self):
        self._one_node("cost is $${params.ticket} literally")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertIn("cost is ${params.ticket} literally", fh.read())

    def test_outputs_footer_only_when_downstream_consumer_exists(self):
        nodes = [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                 {"id": "b", "type": "agent_task", "brief_ref": "b.md"}]
        edges = [{"from": "a", "to": "b", "on": "success"}]
        self._write(self._doc(nodes, edges),
                    {"a.md": "pick", "b.md": "on ${nodes.a.output.branch}"})
        steps = pipeline.ready_set(self.state, self.logdir, 1)   # node a
        with open(steps[0]["prompt"]) as fh:
            text = fh.read()
        self.assertIn("pipeline:outputs", text)
        self.assertIn(".pipeline-run-t1.a.outputs.json", text)

    def test_no_footer_without_consumer(self):
        self._one_node("plain work")
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            self.assertNotIn("pipeline:outputs", fh.read())

    def test_param_value_with_ref_stays_literal_in_brief(self):
        # THE inertness invariant carried from Phase A (single-pass re.sub):
        # a param VALUE containing ${...} is data, never re-resolved.
        self._one_node("t is ${params.ticket}",)
        with open(self.state) as fh:
            st = json.load(fh)
        st["params"]["ticket"] = "${run.id}"
        with open(self.state, "w") as fh:
            json.dump(st, fh)
        steps = pipeline.ready_set(self.state, self.logdir, 1)
        with open(steps[0]["prompt"]) as fh:
            text = fh.read()
        self.assertIn("t is ${run.id}", text)          # literal, not t1-x-1
        self.assertNotIn("t is t1-x-1", text)

    def test_param_value_with_ref_in_runs_as_refused_not_resolved(self):
        # Same invariant on the runs_as channel: a single substitute pass
        # leaves the value's literal ${...} in place, and the concrete
        # re-check REFUSES it -- it is never re-parsed as a reference.
        self._one_node("plain", runs_as={"model": "${params.m}"})
        with open(self.state) as fh:
            st = json.load(fh)
        st["params"]["m"] = "${run.repo}"
        with open(self.state, "w") as fh:
            json.dump(st, fh)
        with self.assertRaises(pipeline.PipelineError) as cm:
            pipeline.ready_set(self.state, self.logdir, 1)
        # refused as leftover-${, NOT resolved into the repo path
        self.assertNotIn(self.repo, str(cm.exception))


class StartRunTriggerTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.pdir = os.path.join(self.repo, ".autonomy", "pipelines", "flow")
        self.tdir = os.path.join(self.repo, ".autonomy", "triggers")
        self.logdir = os.path.join(self.repo, "var", "autonomy-logs")
        for d in (self.pdir, self.tdir, self.logdir):
            os.makedirs(d)
        # start_run_trigger verifies the trigger name against enabled EVENT
        # roles (CP2: the collision gate must hold at the python chokepoint,
        # not only in enumeration) -- the config is required context.
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("engine:\n  label: t\n")
        self.state = os.path.join(self.logdir, ".pipeline-run-t1.json")
        doc = {"name": "flow", "version": 1,
               "params": [
                   {"name": "repo", "type": "repo", "required": True},
                   {"name": "m", "type": "model",
                    "default": "claude-sonnet-5"},
                   {"name": "tok", "type": "secret"}],
               "caps": {"max_sessions_per_run": 4},
               "nodes": [{"id": "a", "type": "pick", "brief_ref": "a.md"}],
               "edges": []}
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.pdir, "a.md"), "w") as fh:
            fh.write("pick work in ${params.repo}")

    def _trigger(self, **params):
        t = {"name": "t1", "pipeline": "flow",
             "params": dict({"repo": "/reg/checkout"}, **params),
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)

    def _start(self, **kw):
        kw.setdefault("known_repos", lambda: {"/reg/checkout"})
        kw.setdefault("known_accounts", lambda: {"acct-a"})
        return pipeline.start_run_trigger(self.repo, "t1", self.state, **kw)

    def test_start_resolves_params_into_state(self):
        self._trigger()
        st = self._start()
        self.assertEqual(st["trigger"], "t1")
        self.assertEqual(st["kind"], "native")
        self.assertEqual(st["params"]["m"], "claude-sonnet-5")
        self.assertEqual(st["run"]["pipeline"], "flow")
        self.assertEqual(st["run"]["trigger"], "t1")
        self.assertEqual(st["run"]["repo"], self.repo)

    def test_required_unset_refuses_before_any_state_write(self):
        t = {"name": "t1", "pipeline": "flow", "params": {},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()
        self.assertFalse(os.path.exists(self.state))

    def test_unregistered_repo_param_refuses(self):
        self._trigger()
        with self.assertRaises(pipeline.PipelineError):
            self._start(known_repos=lambda: {"/other"})

    def test_unreadable_registry_refuses_runs_that_use_repo_type(self):
        self._trigger()

        def broken():
            raise OSError("no registry")
        with self.assertRaises(pipeline.PipelineError):
            self._start(known_repos=broken)

    def test_unknown_account_param_refuses(self):
        # swap the doc's param decl to account-typed via a fresh pipeline
        with open(os.path.join(self.pdir, "pipeline.json")) as fh:
            doc = json.load(fh)
        doc["params"] = [{"name": "acct", "type": "account",
                          "required": True}]
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        with open(os.path.join(self.pdir, "a.md"), "w") as fh:
            fh.write("no refs")
        t = {"name": "t1", "pipeline": "flow",
             "params": {"acct": "ghost"},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()

    def test_secret_value_supplied_refuses_and_never_echoes_value(self):
        self._trigger(tok="hunter2-value")
        with self.assertRaises(pipeline.PipelineError) as cm:
            self._start()
        self.assertNotIn("hunter2-value", str(cm.exception))
        self.assertIn("tok", str(cm.exception))

    def test_secret_with_pipeline_default_refuses_too(self):
        # Codex CP1: a saved default would resolve through secret_lookup
        # into state['params'] on disk -- the same refusal must cover it.
        with open(os.path.join(self.pdir, "pipeline.json")) as fh:
            doc = json.load(fh)
        doc["params"] = [p if p["name"] != "tok" else
                         {"name": "tok", "type": "secret", "default": "KEY"}
                         for p in doc["params"]]
        with open(os.path.join(self.pdir, "pipeline.json"), "w") as fh:
            json.dump(doc, fh)
        self._trigger()
        with self.assertRaises(pipeline.PipelineError) as cm:
            self._start()
        self.assertIn("tok", str(cm.exception))

    def test_declared_valueless_secret_is_inert(self):
        self._trigger()          # 'tok' declared, no default, no value
        st = self._start()
        self.assertNotIn("tok", st["params"])

    def test_missing_pipeline_refuses(self):
        t = {"name": "t1", "pipeline": "ghost", "params": {},
             "firing": {"mode": "continuous"}}
        with open(os.path.join(self.tdir, "t1.json"), "w") as fh:
            json.dump(t, fh)
        with self.assertRaises(pipeline.PipelineError):
            self._start()

    def test_event_role_collision_refuses_at_start(self):
        # CP2 defense in depth: enumeration refuses the collision, but a
        # start that arrives another way (manual marker, direct CLI) must
        # refuse at the chokepoint too -- event roles stay on the legacy bus.
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  t1:\n    enabled: true\n"
                     "    trigger:\n      type: event\n"
                     "      on: [pr.opened]\n")
        self._trigger()
        with self.assertRaises(pipeline.PipelineError) as cm:
            self._start()
        self.assertIn("event", str(cm.exception))

    def test_config_unreadable_refuses_native_start(self):
        # Can't verify the event-collision gate = don't run (fail-safe).
        os.remove(os.path.join(self.repo, ".autonomy", "config.yaml"))
        self._trigger()
        with self.assertRaises(pipeline.PipelineError):
            self._start()

    def test_shim_state_shape_matches(self):
        # start_run gains trigger/kind/params/run too -- ONE state shape.
        with open(os.path.join(self.repo, ".autonomy", "config.yaml"),
                  "w") as fh:
            fh.write("roles:\n  coder:\n    enabled: true\n")
        with open(os.path.join(self.repo, ".autonomy", "loop_prompt.md"),
                  "w") as fh:
            fh.write("loop")
        st = pipeline.start_run(self.repo, "coder",
                                os.path.join(self.logdir,
                                             ".pipeline-run-coder.json"))
        self.assertEqual(st["trigger"], "coder")
        self.assertEqual(st["kind"], "shim")
        self.assertEqual(st["params"], {})
        self.assertEqual(st["run"]["trigger"], "coder")


class SecretMessageAuditTest(unittest.TestCase):
    def test_secret_failure_message_names_param_never_value(self):
        # Secret error paths must carry the NAME only -- the message flows
        # to supervisor.log via stderr (SD-8 redaction belt).
        declared = [{"name": "tok", "type": "secret"}]
        with self.assertRaises(pipeline.PipelineError) as cm:
            pipeline.resolve_params(declared, {"tok": "hunter2-value"},
                                    secret_lookup=None)
        self.assertIn("tok", str(cm.exception))
        self.assertNotIn("hunter2-value", str(cm.exception))


class JournalTriggerFieldTest(unittest.TestCase):
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

    def test_journal_line_carries_additive_trigger_field(self):
        pipeline.start_run(self.repo, "coder", self.state)
        pipeline.next_node(self.state, os.path.join(self.repo, "brief.md"))
        pipeline.record_outcome(self.state, "act", "success",
                                session_log="/x/session-1.log",
                                journal_path=self.journal)
        with open(self.journal) as fh:
            rec = json.loads(fh.read().splitlines()[0])
        self.assertEqual(rec["trigger"], "coder")
        self.assertEqual(rec["role"], "coder")      # ledger keys stay put


class CheckRefsTest(unittest.TestCase):
    def _doc(self, nodes=None, edges=None, params=None):
        d = {"name": "flow", "version": 1,
             "caps": {"max_sessions_per_run": 16},
             "params": params if params is not None else
                 [{"name": "m", "type": "model", "default": "claude-sonnet-5"},
                  {"name": "tok", "type": "secret"}],
             "nodes": nodes or
                 [{"id": "a", "type": "pick", "brief_ref": "a.md"},
                  {"id": "b", "type": "agent_task", "brief_ref": "b.md"}],
             "edges": edges if edges is not None else
                 [{"from": "a", "to": "b", "on": "success"}]}
        return d

    def _errs(self, doc):
        errors = []
        pipeline.check_refs(doc, errors)
        return errors

    def test_declared_param_ref_ok(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.m}"}
        self.assertEqual(self._errs(d), [])

    def test_undeclared_param_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.ghost}"}
        self.assertTrue(any("ghost" in e for e in self._errs(d)))

    def test_secret_param_ref_refused_everywhere(self):
        # Phase B has no safe sink for a secret (briefs/argv are files) --
        # SD-8. The env channel lands with Phase C.
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"account": "${params.tok}"}
        self.assertTrue(any("secret" in e for e in self._errs(d)))

    def test_upstream_node_output_ref_ok(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.a.output.model}"}
        self.assertEqual(self._errs(d), [])

    def test_downstream_or_sibling_node_ref_refused(self):
        d = self._doc()
        d["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.x}"}   # downstream
        self.assertTrue(self._errs(d))
        d2 = self._doc(edges=[])                                       # siblings
        d2["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.x}"}
        self.assertTrue(self._errs(d2))

    def test_self_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.b.output.x}"}
        self.assertTrue(self._errs(d))

    def test_unknown_node_ref_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${nodes.ghost.output.x}"}
        self.assertTrue(self._errs(d))

    def test_run_fields_closed_set(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${run.id}"}
        self.assertEqual(self._errs(d), [])
        d["nodes"][1]["runs_as"] = {"model": "${run.hostname}"}
        self.assertTrue(self._errs(d))

    def test_function_allowlist_and_arity_static(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${default(params.m, 'x')}"}
        self.assertEqual(self._errs(d), [])
        d["nodes"][1]["runs_as"] = {"model": "${danger(params.m)}"}
        self.assertTrue(self._errs(d))
        d["nodes"][1]["runs_as"] = {"model": "${slug()}"}
        self.assertTrue(self._errs(d))

    def test_brief_ref_and_legacy_prompt_stay_ref_free(self):
        d = self._doc(nodes=[{"id": "a", "type": "pick",
                              "brief_ref": "${params.m}.md"}], edges=[])
        self.assertTrue(self._errs(d))
        d2 = self._doc(nodes=[{"id": "a", "type": "agent_task",
                               "legacy_prompt": "${params.m}"}], edges=[])
        self.assertTrue(self._errs(d2))

    def test_malformed_body_refused(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "${params.m"}      # unterminated
        self.assertTrue(self._errs(d))

    def test_escaped_literal_ignored(self):
        d = self._doc()
        d["nodes"][1]["runs_as"] = {"model": "$${params.m}"}
        # An escaped literal is prose, not a ref -- but runs_as.model with a
        # literal '${' still fails the CONCRETE model check at prepare time;
        # statically it is not a reference error.
        self.assertEqual([e for e in self._errs(d) if "reference" in e], [])

    def test_scalar_block_shapes_never_crash_the_checker(self):
        # Review round 1 (PR #375): check_refs is the totality boundary for
        # its own scan -- a scalar where a list belongs (children: true,
        # params: 5, nodes: 5, containers: 5) must degrade to the SHAPE
        # checks' refusal, never TypeError out of the validator.
        for bad in ({"containers": [{"id": "c", "children": True}]},
                    {"containers": [{"id": "c", "children": 5}]},
                    {"params": 5}, {"nodes": 5}, {"containers": 5}):
            d = self._doc()
            d.update(bad)
            self.assertTrue(pipeline.validate_doc(d, None))   # errors, no crash


def _findings_doc():
    """The spec S2.1 example, expressed with today's back-edge rule:
    pick -> stage[code] -> qa, qa --failure,back--> stage."""
    return {
        "name": "t2m", "version": 1, "caps": {"max_sessions_per_run": 10},
        "params": [], "outputs": [],
        "nodes": [
            {"id": "pick", "type": "pick", "brief_ref": "pick.md"},
            {"id": "code", "type": "agent_task", "brief_ref": "code.md"},
            {"id": "qa", "type": "check", "brief_ref": "qa.md"},
        ],
        "containers": [{"id": "st", "kind": "stage", "children": ["code"]}],
        "edges": [
            {"from": "pick", "to": "st", "on": "success"},
            {"from": "st", "to": "qa", "on": "success"},
            {"from": "qa", "to": "st", "on": "failure", "back": True,
             "max_bounces": 3},
        ],
    }


class SoftBackEdgeRefTest(unittest.TestCase):
    def test_bare_future_ref_refuses(self):
        doc = _findings_doc()
        doc["nodes"][1]["runs_as"] = {"model": "${nodes.qa.output.findings}"}
        errs = pipeline.validate_doc(doc)
        self.assertTrue(any("strict upstream" in e for e in errs), errs)

    def test_future_ref_inside_default_validates(self):
        # exercised through a STRING FIELD the scanner walks; brief text is
        # checked by the same _check_expr_static at compile time
        doc = _findings_doc()
        doc["params"] = [{"name": "m", "type": "model", "required": False,
                          "default": "claude-sonnet-5"}]
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(nodes.qa.output.model_hint, params.m)}"}
        self.assertEqual(pipeline.validate_doc(doc), [])

    def test_default_second_arg_gets_no_soft_pass(self):
        doc = _findings_doc()
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(params_missing_entirely, nodes.qa.output.h)}"}
        errs = pipeline.validate_doc(doc)
        self.assertTrue(errs)   # both args refuse: bad ref + non-soft position

    def test_soft_set_requires_the_bounce_path(self):
        # qa's back-edge removed -> code may NOT soft-reference qa
        doc = _findings_doc()
        doc["edges"] = doc["edges"][:2]
        doc["nodes"][1]["runs_as"] = {
            "model": "${default(nodes.qa.output.h, 'x')}"}
        self.assertTrue(pipeline.validate_doc(doc))


class SiblingRefTest(unittest.TestCase):
    def _doc(self):
        return {
            "name": "sib", "version": 1, "caps": {"max_sessions_per_run": 9},
            "nodes": [
                {"id": "a", "type": "agent_task", "brief_ref": "a.md"},
                {"id": "b", "type": "agent_task", "brief_ref": "b.md"},
                {"id": "c", "type": "agent_task", "brief_ref": "c.md"},
            ],
            "containers": [{"id": "st", "kind": "stage",
                            "children": ["a", "b"]}],
            "edges": [{"from": "st", "to": "c", "on": "success"}],
        }

    def test_earlier_sibling_ref_validates(self):
        doc = self._doc()
        doc["nodes"][1]["runs_as"] = {"model": "${nodes.a.output.m}"}
        self.assertEqual(pipeline.validate_doc(doc), [])

    def test_later_sibling_ref_refuses(self):
        doc = self._doc()
        doc["nodes"][0]["runs_as"] = {"model": "${nodes.b.output.m}"}
        self.assertTrue(pipeline.validate_doc(doc))

    def test_upstream_container_child_ref_validates(self):
        doc = self._doc()
        doc["nodes"][2]["runs_as"] = {"model": "${nodes.b.output.m}"}
        self.assertEqual(pipeline.validate_doc(doc), [])


class LazyDefaultTest(unittest.TestCase):
    CTX = {"params": {"x": "v"}, "nodes": {"done": {"branch": "b1"}},
           "run": {"id": "r"}}

    def test_missing_node_output_is_typed(self):
        with self.assertRaises(pipeline.MissingNodeOutput):
            pipeline.substitute("${nodes.ghost.output.x}", self.CTX)
        with self.assertRaises(pipeline.MissingNodeOutput):
            pipeline.substitute("${nodes.done.output.ghost}", self.CTX)

    def test_default_tolerates_missing_node_output(self):
        out = pipeline.substitute(
            "${default(nodes.ghost.output.findings, 'none yet')}", self.CTX)
        self.assertEqual(out, "none yet")

    def test_default_still_resolves_present_output(self):
        out = pipeline.substitute(
            "${default(nodes.done.output.branch, 'none')}", self.CTX)
        self.assertEqual(out, "b1")

    def test_default_does_not_mask_param_typos(self):
        with self.assertRaises(pipeline.PipelineError):
            pipeline.substitute("${default(params.ghost, 'x')}", self.CTX)

    def test_default_empty_first_arg_still_falls_back(self):
        ctx = {"params": {"m": ""}, "nodes": {}, "run": {}}
        self.assertEqual(
            pipeline.substitute("${default(params.m, 'fb')}", ctx), "fb")


if __name__ == "__main__":
    unittest.main()
