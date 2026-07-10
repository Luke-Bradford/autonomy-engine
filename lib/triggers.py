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


def main(argv):
    print("triggers.py: CLI lands in a later task", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
