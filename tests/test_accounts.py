"""Unit tests for lib/accounts.py -- the named-account registry (#agent-org increment 1).
An account classifies an auth instance: a subscription (no secret) or an API kind
that points at a credentials.py Keychain label. The index holds names/kinds/labels
only -- never a secret. Tests inject a fake credentials object + a temp index."""
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
import accounts as ac  # noqa: E402


class FakeCreds:
    """Stand-in for credentials.Credentials -- only get_secret is used."""
    def __init__(self, secrets=None):
        self._s = secrets or {}
    def get_secret(self, label):
        return self._s.get(label)


class TestAccountsCrud(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.a = ac.Accounts(index_path=self.index, credentials=FakeCreds())

    def test_set_subscription_then_list(self):
        self.a.set("claude-sub", "claude_subscription")
        entries = self.a.list()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["name"], "claude-sub")
        self.assertEqual(e["kind"], "claude_subscription")
        self.assertIsNone(e["credential"])
        self.assertFalse(e["has_credential"])

    def test_set_api_kind_requires_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("work", "anthropic_api")            # no credential -> reject
        self.a.set("work", "anthropic_api", credential="work-key")
        self.assertEqual(self.a.get("work"), {"kind": "anthropic_api",
                                              "base_url": None,
                                              "credential": "work-key"})

    def test_subscription_kind_forbids_credential(self):
        with self.assertRaises(ValueError):
            self.a.set("claude-sub", "claude_subscription", credential="oops")

    def test_bad_name_and_kind_rejected(self):
        with self.assertRaises(ValueError):
            self.a.set("has space", "claude_subscription")
        with self.assertRaises(ValueError):
            self.a.set("x", "not_a_kind")
        # trailing newline: re.match + `$` would accept it, leaving a name
        # bash can't address later ($() strips the newline). fullmatch rejects.
        with self.assertRaises(ValueError):
            self.a.set("sneaky\n", "claude_subscription")

    def test_set_upserts(self):
        self.a.set("work", "anthropic_api", credential="k1")
        self.a.set("work", "openai_api", credential="k2")   # re-point same name
        self.assertEqual(self.a.get("work"), {"kind": "openai_api",
                                              "base_url": None,
                                              "credential": "k2"})
        self.assertEqual(len(self.a.list()), 1)

    def test_delete_is_idempotent(self):
        self.a.set("work", "claude_subscription")
        self.a.delete("work")
        self.assertEqual(self.a.list(), [])
        self.a.delete("work")   # no raise

    def test_index_is_600_and_has_no_secret(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        mode = stat.S_IMODE(os.stat(self.index).st_mode)
        self.assertEqual(mode, 0o600)
        raw = Path(self.index).read_text()
        self.assertIn("work", raw)          # name + label are fine
        self.assertIn("anthropic_api", raw)
        self.assertNotIn("sk-", raw)        # no secret material ever

    def test_missing_index_is_empty(self):
        a = ac.Accounts(index_path=os.path.join(self.tmp, "absent"), credentials=FakeCreds())
        self.assertEqual(a.list(), [])
        self.assertIsNone(a.get("nope"))

    def test_non_dict_index_degrades_to_empty_on_read(self):
        # A file that parses as valid JSON but is not a dict (bare list/scalar)
        # must degrade to an empty registry for READS, NOT raise AttributeError.
        # (Writes on such a corrupt index refuse -- see the #59 test below.)
        Path(self.index).write_text("[]")
        self.assertEqual(self.a.list(), [])
        self.assertIsNone(self.a.get("nope"))
        Path(self.index).write_text('"a bare string"')
        self.assertEqual(self.a.list(), [])

    def test_corrupt_index_refuses_writes_without_clobber(self):
        # #59: a corrupt index (unparseable, non-dict top-level, or a non-dict
        # `accounts` section) must REFUSE set()/delete() -- never overwrite it
        # and silently drop the unreadable entries. Reads still degrade to empty.
        # incl. a per-ENTRY corruption: the `accounts` section is a dict but an
        # entry value is not (which would crash list()/get() with AttributeError
        # on a raw read).
        for corrupt in ('{"accounts": bad', "[]", '{"accounts": []}',
                        '{"accounts": {"work": []}}', '{"accounts": null}'):
            Path(self.index).write_text(corrupt)
            before = Path(self.index).read_bytes()
            self.assertTrue(self.a.is_corrupt(), msg=corrupt)
            with self.assertRaises(ac.RegistryError, msg=corrupt):
                self.a.set("work", "claude_subscription")
            with self.assertRaises(ac.RegistryError, msg=corrupt):
                self.a.delete("work")
            self.assertEqual(Path(self.index).read_bytes(), before, msg=corrupt)
            self.assertEqual(self.a.list(), [], msg=corrupt)      # read degrades
            self.assertIsNone(self.a.get("work"), msg=corrupt)    # no crash

    def test_missing_index_is_not_corrupt_and_writable(self):
        # empty != corrupt: a fresh (absent) registry is writable.
        a = ac.Accounts(index_path=os.path.join(self.tmp, "fresh"), credentials=FakeCreds())
        self.assertFalse(a.is_corrupt())
        a.set("work", "claude_subscription")
        self.assertEqual([e["name"] for e in a.list()], ["work"])


class TestResolve(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.index = os.path.join(self.tmp, "accounts")
        self.creds = FakeCreds({"work-key": "sk-ant-SECRET", "oai": "sk-openai-SECRET"})
        self.a = ac.Accounts(index_path=self.index, credentials=self.creds)

    def test_subscription_exports_nothing(self):
        self.a.set("claude-sub", "claude_subscription")
        r = self.a.resolve("claude-sub")
        self.assertEqual(r, {"kind": "claude_subscription", "env": {}})

    def test_anthropic_api_exports_key(self):
        self.a.set("work", "anthropic_api", credential="work-key")
        r = self.a.resolve("work")
        self.assertEqual(r["kind"], "anthropic_api")
        self.assertEqual(r["env"], {"ANTHROPIC_API_KEY": "sk-ant-SECRET"})

    def test_openai_api_exports_key(self):
        self.a.set("side", "openai_api", credential="oai")
        self.assertEqual(self.a.resolve("side")["env"], {"OPENAI_API_KEY": "sk-openai-SECRET"})

    def test_unknown_account_raises_keyerror(self):
        with self.assertRaises(KeyError):
            self.a.resolve("ghost")

    def test_api_with_missing_secret_raises_lookuperror(self):
        # credential label present in the index but the Keychain has no secret
        self.a.set("stale", "anthropic_api", credential="gone")
        with self.assertRaises(LookupError):
            self.a.resolve("stale")

    def test_unrecognized_kind_raises_lookuperror(self):
        # a hand-edited index (or version skew: a newer engine wrote a kind
        # this code doesn't know) must never silently export a var named
        # "None" -- resolve must fail-safe, not fail-open.
        self.a.set("work", "anthropic_api", credential="work-key")
        with open(self.index, encoding="utf-8") as fh:
            data = json.load(fh)
        data["accounts"]["future"] = {"kind": "bedrock_api", "credential": "work-key"}
        with open(self.index, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        with self.assertRaises(LookupError):
            self.a.resolve("future")

    def test_api_kind_without_credential_raises_lookuperror(self):
        # must not reach the real Keychain / crash with TypeError when the
        # index entry has no credential label at all.
        with open(self.index, "w", encoding="utf-8") as fh:
            json.dump({"accounts": {"broken": {"kind": "anthropic_api"}}}, fh)
        with self.assertRaises(LookupError):
            self.a.resolve("broken")

    def test_codex_subscription_exports_nothing(self):
        self.a.set("codex-sub", "codex_subscription")
        r = self.a.resolve("codex-sub")
        self.assertEqual(r, {"kind": "codex_subscription", "env": {}})


class TestCli(unittest.TestCase):
    """_main returns clean exit codes and prints resolve env as VAR=value
    lines for bash consumers. Patch Accounts to a temp index + fake creds so
    the CLI never touches the real Keychain."""
    def _run(self, argv, secrets=None):
        import io
        tmp = tempfile.mkdtemp()
        orig = ac.Accounts.__init__
        def patched(self, index_path=None, credentials=None):
            orig(self, index_path=os.path.join(tmp, "accounts"),
                 credentials=FakeCreds(secrets or {}))
        ac.Accounts.__init__ = patched
        out, err = io.StringIO(), io.StringIO()
        so, se = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            rc = ac._main(argv)
        finally:
            ac.Accounts.__init__ = orig
            sys.stdout, sys.stderr = so, se
        return rc, out.getvalue(), err.getvalue(), tmp

    def test_set_then_resolve_subscription_prints_nothing(self):
        # reuse one temp dir across two _main calls by pinning the index path
        import io
        tmp = tempfile.mkdtemp()
        idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds())
        try:
            self.assertEqual(ac._main(["set", "claude-sub", "claude_subscription"]), 0)
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "claude-sub"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "")   # subscription: no env lines

    def test_resolve_api_prints_var_line(self):
        import io
        tmp = tempfile.mkdtemp(); idx = os.path.join(tmp, "accounts")
        orig = ac.Accounts.__init__
        ac.Accounts.__init__ = lambda self, index_path=None, credentials=None: orig(
            self, index_path=idx, credentials=FakeCreds({"k": "sk-ant-X"}))
        try:
            ac._main(["set", "work", "anthropic_api", "k"])
            out = io.StringIO(); so = sys.stdout; sys.stdout = out
            try:
                rc = ac._main(["resolve", "work"])
            finally:
                sys.stdout = so
        finally:
            ac.Accounts.__init__ = orig
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue().strip(), "ANTHROPIC_API_KEY=sk-ant-X")

    def test_resolve_unknown_exits_1(self):
        rc, _out, _err, _tmp = self._run(["resolve", "ghost"])
        self.assertEqual(rc, 1)

    def test_bad_kind_exits_1(self):
        rc, _out, err, _tmp = self._run(["set", "x", "bogus_kind"])
        self.assertEqual(rc, 1)
        self.assertIn("kind", err)


class TestOpenAICompatible(unittest.TestCase):
    """openai_compatible: a role points at any OpenAI-compatible endpoint
    (local Ollama/LM Studio or a remote gateway). The index stores the URL
    (+ optional credential LABEL), never a secret (#78)."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.idx = os.path.join(self.tmp, "accounts")
        self.acc = ac.Accounts(index_path=self.idx,
                               credentials=FakeCreds({"gw-key": "sk-remote-9"}))

    def test_set_and_get_base_url(self):
        self.acc.set("local-llm", "openai_compatible",
                     base_url="http://localhost:11434/v1")
        self.assertEqual(self.acc.get("local-llm"),
                         {"kind": "openai_compatible",
                          "base_url": "http://localhost:11434/v1",
                          "credential": None})

    def test_resolve_local_exports_base_url_and_dummy_key(self):
        self.acc.set("local-llm", "openai_compatible",
                     base_url="http://localhost:11434/v1")
        self.assertEqual(
            self.acc.resolve("local-llm"),
            {"kind": "openai_compatible",
             "env": {"OPENAI_BASE_URL": "http://localhost:11434/v1",
                     "OPENAI_API_KEY": "local"}})

    def test_resolve_with_credential_exports_real_key(self):
        self.acc.set("remote", "openai_compatible",
                     base_url="https://gw.example/v1", credential="gw-key")
        env = self.acc.resolve("remote")["env"]
        self.assertEqual(env["OPENAI_BASE_URL"], "https://gw.example/v1")
        self.assertEqual(env["OPENAI_API_KEY"], "sk-remote-9")

    def test_resolve_credential_without_secret_refuses(self):
        # a labelled credential with no secret in the Keychain must refuse,
        # never fall back to the "local" dummy key (fail-safe).
        self.acc.set("remote", "openai_compatible",
                     base_url="https://gw.example/v1", credential="missing")
        with self.assertRaises(LookupError):
            self.acc.resolve("remote")

    def test_set_requires_base_url(self):
        with self.assertRaises(ValueError):
            self.acc.set("bad", "openai_compatible")

    def test_set_rejects_malformed_base_url(self):
        for bad in ("ftp://x", "localhost:11434", "not a url", ""):
            with self.assertRaises(ValueError):
                self.acc.set("bad", "openai_compatible", base_url=bad)

    def test_base_url_rejected_for_non_openai_kind(self):
        with self.assertRaises(ValueError):
            self.acc.set("x", "claude_subscription",
                         base_url="http://localhost:11434/v1")
        with self.assertRaises(ValueError):
            self.acc.set("y", "anthropic_api", credential="lbl",
                         base_url="http://localhost:11434/v1")

    def test_resolve_missing_base_url_refuses(self):
        # a hand-corrupted entry with no base_url must not resolve to a
        # partial env (fail-safe, never fail-open).
        self.acc.set("local-llm", "openai_compatible",
                     base_url="http://localhost:11434/v1")
        data = self.acc._load()
        del data["accounts"]["local-llm"]["base_url"]
        self.acc._save(data)
        with self.assertRaises(LookupError):
            self.acc.resolve("local-llm")

    def test_index_holds_no_secret(self):
        self.acc.set("remote", "openai_compatible",
                     base_url="https://gw.example/v1", credential="gw-key")
        with open(self.idx, encoding="utf-8") as fh:
            raw = fh.read()
        self.assertIn("gw-key", raw)          # the LABEL is stored
        self.assertNotIn("sk-remote-9", raw)  # the SECRET never is


class TestListModels(unittest.TestCase):
    def setUp(self):
        # Neutralize the live claude_subscription source (#206) so the curated
        # fallback is deterministic and NO real Keychain/network is touched --
        # on darwin the default token reader would otherwise read a real token.
        self._saved_live = ac.live_claude_models
        ac.live_claude_models = lambda *a, **k: None
        ac.reset_live_models_cache()

    def tearDown(self):
        ac.live_claude_models = self._saved_live
        ac.reset_live_models_cache()

    def test_list_models_parses_openai_shape(self):
        payload = {"data": [{"id": "qwen3:14b"}, {"id": "deepseek-r1:14b"}]}
        got = ac._parse_models_payload(json.dumps(payload).encode())
        self.assertEqual(got, ["qwen3:14b", "deepseek-r1:14b"])

    def test_list_models_bad_payload_is_empty(self):
        self.assertEqual(ac._parse_models_payload(b"not json"), [])
        self.assertEqual(ac._parse_models_payload(b'{"data": null}'), [])
        self.assertEqual(ac._parse_models_payload(b'{"data": [{"no_id": 1}]}'), [])

    def test_list_models_claude_subscription_returns_curated(self):
        # claude_subscription has no models API -> the curated in-repo roster
        # is the discovery source (single-sourced in _SUBSCRIPTION_MODELS).
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("sub", "claude_subscription")
        self.assertEqual(acc.list_models("sub"),
                         ac._SUBSCRIPTION_MODELS["claude_subscription"])
        # the curated claude roster is non-empty and holds the shipped ids.
        self.assertIn("claude-opus-4-8", acc.list_models("sub"))

    def test_list_models_codex_subscription_is_empty_seam(self):
        # codex model ids are unverified in-repo -> the curated roster is an
        # explicit empty seam ('fill when verified'); discovery degrades to the
        # free-text field rather than shipping invented ids.
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("cx", "codex_subscription")
        self.assertEqual(acc.list_models("cx"), [])

    def test_list_models_curated_is_a_copy(self):
        # callers must not be able to mutate the shared curated roster.
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("sub", "claude_subscription")
        got = acc.list_models("sub")
        got.append("tampered")
        self.assertNotIn("tampered",
                         ac._SUBSCRIPTION_MODELS["claude_subscription"])

    def test_list_models_api_kind_and_missing_are_empty(self):
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("api", "anthropic_api", credential="k")
        self.assertEqual(acc.list_models("api"), [])
        self.assertEqual(acc.list_models("ghost"), [])

    def test_subscription_models_is_the_single_source(self):
        # the module-level accessor both Accounts.list_models AND the dashboard
        # (bin/dashboard.py MODEL_CHOICES injection) read -- one roster, no
        # hand-kept duplicate. Returns a copy so no caller can mutate it.
        self.assertEqual(ac.subscription_models("claude_subscription"),
                         ac._SUBSCRIPTION_MODELS["claude_subscription"])
        self.assertIn("claude-opus-4-8",
                      ac.subscription_models("claude_subscription"))
        self.assertEqual(ac.subscription_models("codex_subscription"), [])
        self.assertEqual(ac.subscription_models("openai_compatible"), [])
        self.assertEqual(ac.subscription_models("nonsense"), [])
        got = ac.subscription_models("claude_subscription")
        got.append("tampered")
        self.assertNotIn("tampered",
                         ac._SUBSCRIPTION_MODELS["claude_subscription"])

    def test_model_source_maps_kind_to_discovery_source(self):
        # the config picker (#82) asks accounts, not bin/, which SOURCE a kind
        # uses -- so the decision cannot drift from list_models. openai_compatible
        # discovers live; a CLI-login subscription serves the curated roster;
        # anything else (api key / unknown) has no roster to offer.
        self.assertEqual(ac.model_source("openai_compatible"), "live")
        # claude_subscription now ATTEMPTS live discovery (#206) -> "live";
        # discover_models reports the runtime result (live vs curated fallback).
        self.assertEqual(ac.model_source("claude_subscription"), "live")
        self.assertEqual(ac.model_source("codex_subscription"), "curated")
        self.assertEqual(ac.model_source("anthropic_api"), "none")
        self.assertEqual(ac.model_source("openai_api"), "none")
        self.assertEqual(ac.model_source("nonsense"), "none")

    def test_list_models_credential_failure_is_empty(self):
        # an unexpected failure from the credentials backend must degrade to
        # [] -- discovery is best-effort and never propagates (never raises).
        class _BoomCreds:
            def get_secret(self, label):
                raise RuntimeError("keychain exploded")
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=_BoomCreds())
        acc.set("remote", "openai_compatible",
                base_url="https://gw.example/v1", credential="k")
        self.assertEqual(acc.list_models("remote"), [])


class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body if isinstance(body, bytes) else body.encode()
        self.closed = False

    def read(self):
        return self._body

    def close(self):
        self.closed = True


class TestLiveSubscriptionModels(unittest.TestCase):
    """#206: live claude_subscription roster via GET /v1/models, cached, with a
    curated fallback on ANY failure. Every seam injected -- no network/Keychain.
    The OAuth token must ride the header only, never a return value or error."""
    TOKEN = "sk-oauth-SECRET-do-not-leak"
    PAYLOAD = {"data": [{"id": "claude-opus-4-8", "display_name": "Opus 4.8"},
                        {"id": "claude-fable-5", "display_name": "Fable 5"}]}

    def setUp(self):
        ac.reset_live_models_cache()

    def tearDown(self):
        ac.reset_live_models_cache()

    def _opener(self, status, body, box=None):
        def opener(req, timeout=None):
            if box is not None:
                box["auth"] = req.get_header("Authorization")
            return _FakeResp(status, body)
        return opener

    def test_fetch_parses_ids_skips_bad_rows(self):
        payload = {"data": [{"id": "a"}, {"no_id": 1}, {"id": ""},
                            {"id": "b"}, "garbage"]}
        got = ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(200, json.dumps(payload)))
        self.assertEqual(got, ["a", "b"])

    def test_fetch_non_200_and_bad_payloads_are_none(self):
        self.assertIsNone(ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(401, "")))
        self.assertIsNone(ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(200, "not json")))
        self.assertIsNone(ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(200, '{"data": null}')))
        self.assertIsNone(ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(200, '{"data": [{"no_id": 1}]}')))

    def test_fetch_empty_token_no_call(self):
        self.assertIsNone(ac._fetch_live_claude_models(""))
        self.assertIsNone(ac._fetch_live_claude_models(None))

    def test_token_rides_header_not_return(self):
        box = {}
        got = ac._fetch_live_claude_models(
            self.TOKEN, opener=self._opener(200, json.dumps(self.PAYLOAD), box))
        self.assertIn(self.TOKEN, box["auth"])          # header carries it
        self.assertNotIn(self.TOKEN, json.dumps(got))   # return never does

    def test_fetch_transport_error_is_none(self):
        def boom(req, timeout=None):
            raise urllib.error.URLError("offline")
        self.assertIsNone(ac._fetch_live_claude_models(self.TOKEN, opener=boom))

    def test_live_caches_and_throttles(self):
        calls = {"n": 0}

        def fetcher(token):
            calls["n"] += 1
            return ["claude-opus-4-8"]
        first = ac.live_claude_models(now=1000.0, token_reader=lambda: self.TOKEN,
                                      fetcher=fetcher)
        second = ac.live_claude_models(now=1100.0, token_reader=lambda: self.TOKEN,
                                       fetcher=fetcher)
        self.assertEqual(first, ["claude-opus-4-8"])
        self.assertEqual(second, ["claude-opus-4-8"])
        self.assertEqual(calls["n"], 1)                 # throttled within ttl

    def test_live_failure_replaces_prior_value(self):
        ac.live_claude_models(now=1000.0, token_reader=lambda: self.TOKEN,
                              fetcher=lambda t: ["claude-opus-4-8"])
        # ttl elapsed + fetch now fails -> None REPLACES the cached live value
        # (fail-safe: never serve stale-live).
        out = ac.live_claude_models(now=2000.0, token_reader=lambda: self.TOKEN,
                                    fetcher=lambda t: None)
        self.assertIsNone(out)

    def test_live_no_token_is_none_no_fetch(self):
        called = {"n": 0}

        def fetcher(token):
            called["n"] += 1
            return ["x"]
        out = ac.live_claude_models(now=1.0, token_reader=lambda: None,
                                    fetcher=fetcher)
        self.assertIsNone(out)
        self.assertEqual(called["n"], 0)

    def _acc_with_sub(self):
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("sub", "claude_subscription")
        return acc

    def test_list_models_live_first_then_curated(self):
        acc = self._acc_with_sub()
        saved = ac.live_claude_models
        try:
            ac.live_claude_models = lambda *a, **k: ["claude-fable-5", "claude-opus-4-8"]
            self.assertEqual(acc.list_models("sub"),
                             ["claude-fable-5", "claude-opus-4-8"])
            ac.live_claude_models = lambda *a, **k: None
            self.assertEqual(acc.list_models("sub"),
                             ac._SUBSCRIPTION_MODELS["claude_subscription"])
        finally:
            ac.live_claude_models = saved

    def test_discover_models_source_truthful(self):
        acc = self._acc_with_sub()
        saved = ac.live_claude_models
        try:
            ac.live_claude_models = lambda *a, **k: ["claude-fable-5"]
            self.assertEqual(acc.discover_models("sub"),
                             {"source": "live", "models": ["claude-fable-5"]})
            ac.live_claude_models = lambda *a, **k: None
            self.assertEqual(
                acc.discover_models("sub"),
                {"source": "curated",
                 "models": ac._SUBSCRIPTION_MODELS["claude_subscription"]})
        finally:
            ac.live_claude_models = saved

    def test_discover_models_openai_and_none(self):
        tmp = tempfile.mkdtemp()
        acc = ac.Accounts(index_path=os.path.join(tmp, "accounts"),
                          credentials=FakeCreds())
        acc.set("api", "anthropic_api", credential="k")
        self.assertEqual(acc.discover_models("api"),
                         {"source": "none", "models": []})
        self.assertEqual(acc.discover_models("ghost"),
                         {"source": "none", "models": []})


if __name__ == "__main__":
    unittest.main()
