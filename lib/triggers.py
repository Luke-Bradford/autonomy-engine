#!/usr/bin/env python3
"""Trigger objects (pipeline+trigger model Phase B, spec S2.2/S5/S7).

A trigger is a first-class JSON file `.autonomy/triggers/<name>.json` that
binds ONE pipeline, supplies its parameter values, and says when it fires
(continuous/schedule/manual) and how overlapping runs behave (queue/skip/
parallel). Legacy `roles:` configs are auto-shimmed into synthetic triggers
(shim_triggers) so nothing breaks the day this ships. Stdlib only.

Fail-safe: a malformed trigger REFUSES (named reason) and NEVER falls back
to legacy role dispatch -- a broken trigger that shadows a role name must
not silently resurrect the role path the operator replaced.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline                                             # noqa: E402
from pipeline import PipelineError                          # noqa: E402

_TRIGGER_KEYS = frozenset(("name", "pipeline", "params", "firing",
                           "concurrency", "enabled", "lane"))
_FIRING_KEYS = frozenset(("mode", "schedule"))
_CONCURRENCY_KEYS = frozenset(("policy", "max"))
FIRING_MODES = ("continuous", "schedule", "manual")
DEFERRED_FIRING_MODES = {"event": "the event-bus payload mapping (Phase C)"}
CONCURRENCY_POLICIES = ("queue", "skip", "parallel")
MAX_TRIGGER_PARALLEL = 8          # mirrors pipeline.MAX_PARALLEL_CEIL


def _is_scalar(v):
    return isinstance(v, (str, int, float, bool)) or v is None


def effective_trigger_path(repo, name):
    """SD-34 applied to trigger FILES: the var-live shadow
    <repo>/var/autonomy/triggers/<name>.json wins when it exists, else the
    committed <repo>/.autonomy/triggers/<name>.json. A SYMLINKED shadow is
    ignored (not a sanctioned shadow -- the resolver can never be redirected
    out of var/). A present-but-INVALID shadow is NOT a fallback case: the
    file exists, so this returns it and load_trigger refuses it (fail-safe,
    prevention-log #3). Pure fs check; PRECONDITION: name is charset-valid."""
    committed = os.path.join(repo, ".autonomy", "triggers", "%s.json" % name)
    try:
        shadow = os.path.join(repo, "var", "autonomy", "triggers",
                              "%s.json" % name)
        if os.path.isfile(shadow) and not os.path.islink(shadow):
            return shadow
    except (OSError, TypeError):
        pass
    return committed


def validate_trigger(trig, stem):
    """Schema validation for one trigger object. [] = valid. `stem` is the
    filename stem -- name==stem is enforced so a rename can't silently fork
    identity (mirrors the pipeline name==folder gate, SD-37)."""
    if not isinstance(trig, dict):
        return ["trigger must be a JSON object"]
    errors = []
    for k in trig:
        if k not in _TRIGGER_KEYS:
            errors.append("unknown key %r -- not consumed in Phase B, "
                          "remove it (accepted-and-ignored would be the "
                          "fail-open prevention-log #3 forbids)" % k)
    nm = trig.get("name")
    if not (isinstance(nm, str) and pipeline._NAME_RE.match(nm or "")):
        errors.append("name: required, charset [A-Za-z0-9._-]{1,64}")
    elif nm != stem:
        errors.append("name %r != filename stem %r" % (nm, stem))
    if not pipeline.valid_pipeline_name(trig.get("pipeline")):
        errors.append("pipeline: required, charset [A-Za-z0-9._-]{1,64} "
                      "(existence is checked at run start)")
    params = trig.get("params")
    if params is not None:
        if not isinstance(params, dict):
            errors.append("params: must be a mapping of name -> scalar")
        else:
            for k, v in params.items():
                if not (isinstance(k, str) and pipeline._NAME_RE.match(k)):
                    errors.append("params: key %r invalid charset" % (k,))
                if not _is_scalar(v):
                    errors.append("params.%s: must be a scalar (typed "
                                  "checking happens in resolve_params)" % k)
    firing = trig.get("firing")
    if not isinstance(firing, dict):
        errors.append("firing: required, {mode: continuous|schedule|manual}")
    else:
        for k in firing:
            if k not in _FIRING_KEYS:
                errors.append("firing: unknown key %r" % k)
        mode = firing.get("mode")
        if mode in DEFERRED_FIRING_MODES:
            errors.append("firing.mode %r needs engine machinery Phase B "
                          "does not have -- lands with %s"
                          % (mode, DEFERRED_FIRING_MODES[mode]))
        elif mode not in FIRING_MODES:
            errors.append("firing.mode: must be one of %s"
                          % ", ".join(FIRING_MODES))
        if mode == "schedule":
            sched = firing.get("schedule")
            if not (isinstance(sched, str) and sched.strip()):
                errors.append("firing.schedule: required for mode=schedule")
            else:
                import roles           # lazy, path set at module top
                if roles.cron_next_fire(sched.strip(), 0) is None:
                    errors.append("firing.schedule: not a parseable 5-field "
                                  "cron expression")
        elif "schedule" in firing:
            errors.append("firing.schedule: only valid with mode=schedule "
                          "(an ignored schedule would be a silent no-op)")
    conc = trig.get("concurrency")
    if conc is not None:
        if not isinstance(conc, dict):
            errors.append("concurrency: must be {policy, max}")
        else:
            for k in conc:
                if k not in _CONCURRENCY_KEYS:
                    errors.append("concurrency: unknown key %r" % k)
            pol = conc.get("policy")
            if pol not in CONCURRENCY_POLICIES:
                errors.append("concurrency.policy: must be one of %s"
                              % ", ".join(CONCURRENCY_POLICIES))
            mx = conc.get("max")
            if not isinstance(mx, int) or isinstance(mx, bool) or not (
                    1 <= mx <= MAX_TRIGGER_PARALLEL):
                errors.append("concurrency.max: must be 1..%d"
                              % MAX_TRIGGER_PARALLEL)
            elif pol == "queue" and mx != 1:
                errors.append("concurrency: queue is bounded at max 1 "
                              "(spec S11 -- deeper queues risk stale runs)")
    if "enabled" in trig and not isinstance(trig["enabled"], bool):
        errors.append("enabled: must be a bool")
    lane = trig.get("lane")
    if lane is not None and not (isinstance(lane, str)
                                 and pipeline._NAME_RE.match(lane)):
        errors.append("lane: charset [A-Za-z0-9._-]{1,64}")
    return errors


def _apply_defaults(trig):
    out = dict(trig)
    out.setdefault("params", {})
    out.setdefault("concurrency", {"policy": "skip", "max": 1})
    out.setdefault("enabled", True)
    return out


def load_trigger(repo, name):
    """Load + validate one trigger by name (shadow-aware). Raises
    PipelineError on any failure -- charset first (the name may come from a
    filename or CLI argv: prevention-log #6), then unreadable/corrupt/
    invalid. Never falls back."""
    if not (isinstance(name, str) and pipeline._NAME_RE.match(name)):
        raise PipelineError("trigger name %r has invalid charset" % (name,))
    path = effective_trigger_path(repo, name)
    try:
        with open(path, encoding="utf-8") as fh:
            trig = json.load(fh)
    except OSError as exc:
        raise PipelineError("trigger %r unreadable: %s" % (name, exc))
    except ValueError as exc:
        raise PipelineError("trigger %r corrupt JSON (%s): %s"
                            % (name, path, exc))
    errs = validate_trigger(trig, name)
    if errs:
        raise PipelineError("trigger %r invalid: %s" % (name, "; ".join(errs)))
    return _apply_defaults(trig)


def shim_triggers(config):
    """Auto-shim (spec S7): every enabled loop role -> a synthetic continuous
    trigger; every enabled cron role -> a synthetic schedule trigger. Event
    roles are NOT shimmed -- the event bus fires them through the legacy role
    path until Phase C wires event triggers (a shim would double-dispatch).

    The shim carries FIRING identity only: name==role (byte-equal -- ledger/
    fingerprint/state-file continuity, the Phase E trust argument), params={},
    and the role's pipeline binding verbatim ('' = wrapped role). A shim run
    resolves settings through resolve_pipeline(repo, role) exactly as before
    -- prompts, scope, accounts, model precedence all ride the role path."""
    import roles
    roles_blk = (config.get("roles") or {}) if isinstance(config, dict) else {}
    if not isinstance(roles_blk, dict):
        roles_blk = {}

    def _binding(name):
        cfg = roles_blk.get(name)
        b = cfg.get("pipeline") if isinstance(cfg, dict) else None
        return b.strip() if isinstance(b, str) else ""

    def _shim(name, firing):
        return {"name": name, "pipeline": _binding(name), "params": {},
                "firing": firing,
                "concurrency": {"policy": "skip", "max": 1},
                "enabled": True, "lane": roles.lane_of_role(config, name),
                "kind": "shim"}

    out = []
    for name in roles._all_loop_roles(config):
        out.append(_shim(name, {"mode": "continuous"}))
    for name, sched in roles._all_cron_roles(config):
        out.append(_shim(name, {"mode": "schedule", "schedule": sched}))
    return out


def _trigger_stems(repo):
    """Union of committed + shadow trigger filename stems. Filenames are DISK
    INPUT: stems that fail the charset gate are returned in the second slot
    so the caller can warn (never silently dropped, never path-joined)."""
    stems, bad = [], []
    for d in (os.path.join(repo, ".autonomy", "triggers"),
              os.path.join(repo, "var", "autonomy", "triggers")):
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            continue
        for fn in entries:
            if not fn.endswith(".json"):
                continue
            stem = fn[:-len(".json")]
            if not pipeline._NAME_RE.match(stem):
                bad.append(stem)
            elif stem not in stems:
                stems.append(stem)
    return stems, bad


def enumerate_triggers(repo, lane=None):
    """(triggers, warnings) for one lane. Native file triggers (validated,
    kind='native') + shims for roles no file supersedes (kind='shim').
    Every refusal becomes a warning string -- a refused trigger is OUT of
    the dispatchable list AND its same-name shim stays suppressed (never
    fall back to role dispatch for a broken/shadowing trigger). Raises
    PipelineError when the config (the shim source) is unreadable."""
    import roles
    cfg, rc = roles._load_config(repo)
    if rc != 0 or cfg is None:
        raise PipelineError("config unreadable/unparseable for %s (rc %d) "
                            "-- cannot enumerate triggers" % (repo, rc))
    target_lane = lane if lane is not None else roles.default_lane(cfg)
    declared = roles.lane_names(cfg)
    warnings, out, native_stems = [], [], set()
    event_names = set(n for (n, _ev) in roles.all_event_roles(cfg))
    stems, bad = _trigger_stems(repo)
    for stem in bad:
        warnings.append("refused trigger file %r: invalid name charset"
                        % stem)
    for stem in stems:
        native_stems.add(stem)      # even a BROKEN file suppresses the shim
        if stem in event_names:
            # Event roles stay on the legacy bus until Phase C; a same-name
            # native trigger would DOUBLE-DISPATCH this name (Codex CP1).
            warnings.append("refused trigger %r: collides with an enabled "
                            "event role -- event triggers land in Phase C"
                            % stem)
            continue
        try:
            trig = load_trigger(repo, stem)
        except PipelineError as exc:
            warnings.append("refused trigger %r: %s" % (stem, exc))
            continue
        trig["kind"] = "native"
        out.append(trig)
    for t in shim_triggers(cfg):
        if t["name"] in native_stems:
            warnings.append("trigger %r supersedes the role shim of the "
                            "same name" % t["name"])
            continue
        out.append(t)

    def _in_lane(t):
        tl = t.get("lane") or roles.default_lane(cfg)
        return tl in declared and tl == target_lane
    return ([t for t in out if t.get("enabled", True) and _in_lane(t)],
            warnings)


def _cli_lane(args):
    opts = {"--lane": None}
    pos, i = [], 0
    while i < len(args):
        if args[i] == "--lane" and i + 1 < len(args):
            opts["--lane"] = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos, opts["--lane"]


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    pos, lane = _cli_lane(rest)
    if cmd in ("dispatch", "cron", "validate") and len(pos) != 1:
        print("usage: triggers.py %s <repo> [--lane <l>]" % cmd,
              file=sys.stderr)
        return 2
    if cmd == "dispatch":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers dispatch: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            if t["firing"]["mode"] == "continuous":
                c = t["concurrency"]
                print("%s\t%s\t%s\t%d" % (t["name"], t["kind"],
                                          c["policy"], c["max"]))
        return 0
    if cmd == "cron":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers cron: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            if t["firing"]["mode"] == "schedule":
                print("%s\t%s\t%s" % (t["name"], t["firing"]["schedule"],
                                      t["kind"]))
        return 0
    if cmd == "manual":
        # The manual-fire DISPATCH gate (Codex CP2): derived from
        # enumerate_triggers so validity / event-role collision / lane /
        # enabled gating is inherited -- a bare load_trigger (show) would
        # bypass the collision refusal that only enumeration knows about.
        if len(pos) != 1:
            print("usage: triggers.py manual <repo> [--lane <l>]",
                  file=sys.stderr)
            return 2
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers manual: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for t in trigs:
            if t["firing"]["mode"] == "manual":
                c = t["concurrency"]
                print("%s\t%s\t%d" % (t["name"], c["policy"], c["max"]))
        return 0
    if cmd == "show":
        if len(pos) != 2:
            print("usage: triggers.py show <repo> <name>", file=sys.stderr)
            return 2
        try:
            t = load_trigger(pos[0], pos[1])
        except PipelineError as exc:
            print("triggers show: %s" % exc, file=sys.stderr)
            return 1
        c = t["concurrency"]
        print("NAME=%s" % t["name"])
        print("PIPELINE=%s" % t["pipeline"])
        print("MODE=%s" % t["firing"]["mode"])
        print("POLICY=%s" % c["policy"])
        print("MAX=%d" % c["max"])
        print("ENABLED=%s" % ("true" if t.get("enabled", True) else "false"))
        return 0
    if cmd == "validate":
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers validate: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w)
        for t in trigs:
            print("OK %s (%s, %s)" % (t["name"], t["kind"],
                                      t["firing"]["mode"]))
        # Only REFUSALS fail the report -- a supersession note is
        # informational (the 'refused ' prefix is the contract; a test pins
        # that a superseding-but-valid native trigger exits 0).
        return 1 if any(w.startswith("refused") for w in warns) else 0
    print("unknown subcommand %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
