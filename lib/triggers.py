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

CLI verbs: dispatch, cron, event, manual, show, validate,
trust <repo> <journal> (per-trigger rows + per-pipeline rollup).
"""
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline                                             # noqa: E402
from pipeline import PipelineError                          # noqa: E402

_TRIGGER_KEYS = frozenset(("name", "pipeline", "params", "firing",
                           "concurrency", "enabled", "lane", "run_windows"))
_FIRING_KEYS = frozenset(("mode", "schedule", "event", "map"))
_CONCURRENCY_KEYS = frozenset(("policy", "max"))
FIRING_MODES = ("continuous", "schedule", "manual", "event")
# Closed event vocabulary = the four EXTERNAL kinds the W2 bus polls;
# session.done stays a shim-internal loop edge (the validator names it).
EVENT_KINDS = ("pr.opened", "issue.created", "merge.done", "pr.synchronize")
EVENT_FIELDS = ("item", "sha", "event")
CONCURRENCY_POLICIES = ("queue", "skip", "parallel")
MAX_TRIGGER_PARALLEL = 8          # mirrors pipeline.MAX_PARALLEL_CEIL
_WINDOW_KEYS = frozenset(("start", "end", "days"))
WINDOW_DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MAX_RUN_WINDOWS = 16


def _is_scalar(v):
    return isinstance(v, (str, int, float, bool)) or v is None


def _hhmm(value):
    """'HH:MM' -> minutes-since-midnight, or None when malformed.
    Charset-explicit (prevention-log #6): only ASCII digits."""
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    hh, mm = value[:2], value[3:]
    if not all(c in "0123456789" for c in hh + mm):
        return None
    h, m = int(hh), int(mm)
    if h > 23 or m > 59:
        return None
    return h * 60 + m


def _validate_window(w, idx):
    errs = []
    if not isinstance(w, dict):
        return ["run_windows[%d] must be an object" % idx]
    for k in w:
        if k not in _WINDOW_KEYS:
            errs.append("run_windows[%d]: unknown key %r" % (idx, k))
    start, end = _hhmm(w.get("start")), _hhmm(w.get("end"))
    if start is None:
        errs.append("run_windows[%d].start must be 'HH:MM' (UTC)" % idx)
    if end is None:
        errs.append("run_windows[%d].end must be 'HH:MM' (UTC)" % idx)
    if start is not None and start == end:
        errs.append("run_windows[%d]: start == end is a zero-length window"
                    " -- omit run_windows for always-on, or widen it" % idx)
    days = w.get("days")
    if days is not None:
        if not isinstance(days, list) or not days:
            errs.append("run_windows[%d].days must be a non-empty list"
                        " of day names" % idx)
        else:
            for d in days:
                if d not in WINDOW_DAYS:
                    errs.append("run_windows[%d].days: unknown day %r"
                                " (mon..sun, lowercase)" % (idx, d))
    return errs


def in_run_window(trig, now_epoch):
    """True when NEW dispatch is allowed at now_epoch. UTC clock -- the
    same clock as the cron parser (roles.cron_next_fire). ONE public rule
    (CP1 finding 3): a MISSING run_windows key means always-dispatchable,
    and the empty list `[]` is its defaults-synthesised twin
    (_apply_defaults writes it; the validator refuses an EXPLICIT [] in an
    authored file as a foot-gun, so a validated file never carries one).
    end <= start wraps past midnight; a wrapped window's `days` list names
    the window's START day. Start inclusive, end exclusive.

    Fail-closed on junk (CP1 finding 2, prevention-log #12/#18): a
    PRESENT-but-malformed run_windows value (non-list) opens nothing, and
    a malformed window entry or days value contributes NO open time --
    the operator wrote a restriction, so an unreadable restriction must
    restrict, never widen. In-flight runs are never gated here: only the
    four dispatch-facing CLI verbs consult this, and in-flight tokens
    never pass through enumeration."""
    windows = trig.get("run_windows")
    if windows is None or windows == []:
        return True
    if not isinstance(windows, list):
        return False
    try:
        dt = datetime.datetime.fromtimestamp(int(now_epoch),
                                             datetime.timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return False
    minutes = dt.hour * 60 + dt.minute
    dow = WINDOW_DAYS[dt.weekday()]            # weekday(): mon=0 .. sun=6
    prev = WINDOW_DAYS[(dt.weekday() - 1) % 7]
    for w in windows:
        if not isinstance(w, dict):
            continue
        start, end = _hhmm(w.get("start")), _hhmm(w.get("end"))
        if start is None or end is None:
            continue
        days = w.get("days")
        if days is None:
            days = WINDOW_DAYS
        elif (not isinstance(days, list)
              or not all(isinstance(d, str) and d in WINDOW_DAYS
                         for d in days)
              or not days):
            continue                    # junk days: no open time
        if end > start:
            if dow in days and start <= minutes < end:
                return True
        else:
            if dow in days and minutes >= start:
                return True
            if prev in days and minutes < end:
                return True
    return False


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
    elif "." in nm and nm.rsplit(".", 1)[-1] in \
            pipeline._RESERVED_SIDECAR_SUFFIXES:
        # <name>.outputs/.verdict/.outcome state files would be skipped by
        # the supervisor's token scan (sidecars share the glob namespace):
        # the run could start but never advance. Refuse at mint (Phase C).
        errors.append("name %r ends in a reserved sidecar suffix (%s) -- "
                      "rename the trigger"
                      % (nm, "/".join(sorted(
                          pipeline._RESERVED_SIDECAR_SUFFIXES))))
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
        if mode not in FIRING_MODES:
            errors.append("firing.mode: must be one of %s"
                          % ", ".join(FIRING_MODES))
        if mode == "event":
            ev = firing.get("event")
            if ev not in EVENT_KINDS:
                errors.append("firing.event: must be one of %s "
                              "(session.done is an internal loop edge, "
                              "not a subscribable event)"
                              % ", ".join(EVENT_KINDS))
            mp = firing.get("map")
            if mp is not None:
                if not isinstance(mp, dict):
                    errors.append("firing.map: must be {param: item|sha|event}")
                else:
                    for k, v in mp.items():
                        if not (isinstance(k, str)
                                and pipeline._NAME_RE.match(k)):
                            errors.append("firing.map: key %r invalid "
                                          "charset" % (k,))
                        if v not in EVENT_FIELDS:
                            errors.append("firing.map.%s: field must be one "
                                          "of %s" % (k, ", ".join(EVENT_FIELDS)))
                        elif v == "sha" and ev != "pr.synchronize":
                            errors.append("firing.map.%s: 'sha' exists only "
                                          "on pr.synchronize payloads" % k)
                        if isinstance(params, dict) and k in params:
                            errors.append("firing.map.%s: also set in params "
                                          "-- one source per param, remove "
                                          "one" % k)
        else:
            for k in ("event", "map"):
                if k in firing:
                    errors.append("firing.%s: only valid with mode=event" % k)
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
            elif pol == "queue" and isinstance(trig.get("firing"), dict) \
                    and trig["firing"].get("mode") == "event":
                errors.append("concurrency: queue is not valid for event "
                              "mode -- the event seen-set redelivers "
                              "unhandled tokens, which IS the queue")
    windows = trig.get("run_windows")
    if windows is not None:
        if not isinstance(windows, list) or not windows:
            errors.append("run_windows must be a non-empty list of window"
                          " objects (omit the key for always-dispatchable)")
        elif len(windows) > MAX_RUN_WINDOWS:
            errors.append("run_windows: at most %d windows" % MAX_RUN_WINDOWS)
        else:
            for i, w in enumerate(windows):
                errors.extend(_validate_window(w, i))
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
    # [] = the defaults-synthesised twin of "no run_windows key" (always
    # dispatchable). An EXPLICIT [] in an authored file refuses at
    # validation, so a loaded trigger only ever gets one here.
    out.setdefault("run_windows", [])
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
    trigger; every enabled cron role -> a synthetic schedule trigger; every
    enabled event role -> a synthetic event trigger carrying its on: list as
    events_csv (Phase C cutover -- the supervisor routes event shims through
    the LEGACY per-role wake body verbatim, so semantics are byte-identical;
    events_csv is a shim-internal field, never valid in a native file).

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
    for name, sched in roles.all_cron_roles(config):
        out.append(_shim(name, {"mode": "schedule", "schedule": sched}))
    for name, events in roles.all_event_roles(config):
        out.append(_shim(name, {"mode": "event",
                                "events_csv": ",".join(events)}))
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


def enumerate_triggers(repo, lane=None, dispatchable_only=True):
    """(triggers, warnings) for one lane. Native file triggers (validated,
    kind='native') + shims for roles no file supersedes (kind='shim').
    Every refusal becomes a warning string -- a refused trigger is OUT of
    the dispatchable list AND its same-name shim stays suppressed (never
    fall back to role dispatch for a broken/shadowing trigger). Raises
    PipelineError when the config (the shim source) is unreadable.
    dispatchable_only=False returns every VALID trigger regardless of
    enabled/lane (trust/inspection callers -- a pause must not hide
    evidence); refusals stay refused either way."""
    import roles
    cfg, rc = roles._load_config(repo)
    if rc != 0 or cfg is None:
        raise PipelineError("config unreadable/unparseable for %s (rc %d) "
                            "-- cannot enumerate triggers" % (repo, rc))
    target_lane = lane if lane is not None else roles.default_lane(cfg)
    declared = roles.lane_names(cfg)
    warnings, out, native_stems = [], [], set()
    stems, bad = _trigger_stems(repo)
    for stem in bad:
        warnings.append("refused trigger file %r: invalid name charset"
                        % stem)
    for stem in stems:
        native_stems.add(stem)      # even a BROKEN file suppresses the shim
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
    if not dispatchable_only:
        # trust/inspection callers: every VALID trigger, disabled and
        # off-lane included (a pause must not hide evidence). Refusals
        # stayed refused above -- this widens nothing invalid.
        return out, warnings
    return ([t for t in out if t.get("enabled", True) and _in_lane(t)],
            warnings)


def marker_basename(name, lane_suffix):
    """The ONE python twin of _trigger_ctl_path's basename rule
    (bin/supervisor.sh): <name> bare for the default-lane supervisor
    (AUTONOMY_LANE=""), <name>--<lane> under a lane supervisor. Charset
    gates BOTH parts (prevention-log #6 -- these become filenames); raises
    PipelineError so a caller can never path-join an ungated string.
    Phase D1: dashboard_state (marker reads) + dashboard_control (marker
    writes) both consume this -- one source, no drift."""
    if not (isinstance(name, str) and pipeline._NAME_RE.match(name)):
        raise PipelineError("trigger name %r has invalid charset" % (name,))
    if not lane_suffix:
        return name
    if not (isinstance(lane_suffix, str)
            and pipeline._NAME_RE.match(lane_suffix)):
        raise PipelineError("lane %r has invalid charset" % (lane_suffix,))
    return "%s--%s" % (name, lane_suffix)


def trust_rollup(repo, journal_path, trigs=None):
    """Per-trigger trust rows + per-pipeline rollup (design spec §6).
    The rollup is a fail-safe floor: a pipeline reads `auto` only when
    EVERY contributing trigger's tier is `auto` (prevention-log #18 --
    the reassuring verdict is earned, never the default).

    trigs (Phase D1): an already-loaded (triggers, warnings) tuple from
    enumerate_triggers(repo, dispatchable_only=False), so the dashboard
    builder enumerates ONCE per payload. Anything that isn't that exact
    shape is ignored and re-enumerated (total reader -- a junk preload
    must never change the verdict). Default None = the CLI path,
    behaviour byte-identical."""
    if (isinstance(trigs, tuple) and len(trigs) == 2
            and isinstance(trigs[0], list) and isinstance(trigs[1], list)):
        trigs, warnings = trigs
    else:
        trigs, warnings = enumerate_triggers(repo, dispatchable_only=False)
    rows, by_pipeline = [], {}
    for t in trigs:
        pname = t.get("pipeline") or t["name"]  # wrapped role: doc name == role name
        led = pipeline.ledger(journal_path, t["name"], pipeline_name=pname,
                              native=(t.get("kind") == "native"))
        rows.append({"trigger": t["name"], "pipeline": pname,
                     "kind": t.get("kind", ""), "runs": led["runs"],
                     "passes": led["passes"], "tier": led["tier"]})
        by_pipeline.setdefault(pname, []).append(led["tier"])
    rollup = dict((p, "auto" if all(x == "auto" for x in tiers) else "watch")
                  for p, tiers in by_pipeline.items())
    return rows, rollup, warnings


def fire_params_check(repo, name, path):
    """Classify a run-now fire-marker PAYLOAD for the supervisor (Phase D2,
    #383). Returns (cls, reason):
      "ok"        -- payload usable (or empty = no overrides).
      "payload"   -- DETERMINISTICALLY bad payload (unparseable, non-object,
                     non-scalar value, undeclared key, secret target, or a
                     resolve failure ONLY the merged set has): the caller
                     removes the marker loudly -- keeping it would retry a
                     deterministic refusal forever.
      "transient" -- the trigger/pipeline side failed (unreadable trigger,
                     missing doc) OR the SAVED params already fail without
                     the payload (the pre-existing D1 bound): keep + defer,
                     under-fire is the safe side.
    Both dry runs go through pipeline._resolve_run_params -- the EXACT call
    start_run_trigger makes -- so the verdict inherits the start-time
    repo/account existence checks too (start-parity by construction).
    Secret refusals name the KEY only, never the value (SD-8)."""
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read(65537)
    except OSError as exc:
        return "transient", "payload unreadable: %s" % exc
    if len(raw) > 65536:
        return "payload", "run-now payload exceeds 65536 bytes"
    if not raw.strip():
        return "ok", None
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        return "payload", "run-now payload is not valid JSON: %s" % exc
    if not isinstance(payload, dict):
        return "payload", "run-now payload must be a JSON object"
    try:
        trig = load_trigger(repo, name)
        doc, _meta = pipeline.resolve_pipeline_doc(repo, trig["pipeline"])
    except PipelineError as exc:
        return "transient", str(exc)
    decl_types = {p.get("name"): p.get("type")
                  for p in (doc.get("params") or []) if isinstance(p, dict)}
    for k, v in payload.items():
        if decl_types.get(k) == "secret":
            return "payload", ("run-now payload targets secret param %r "
                               "-- a fire payload is never a credential"
                               % k)
        if isinstance(v, (dict, list)):
            return "payload", "run-now param %r must be a scalar" % k
    saved = dict(trig.get("params") or {})
    merged = dict(saved)
    merged.update(payload)
    try:
        pipeline._resolve_run_params(repo, doc, merged)
        return "ok", None
    except PipelineError as merged_exc:
        try:
            pipeline._resolve_run_params(repo, doc, saved)
        except PipelineError:
            return "transient", str(merged_exc)    # saved-only fails too
        return "payload", str(merged_exc)


def _cli_opts(args):
    """Positionals + (--lane, --now). --now is the run-window clock's
    test seam: digits-only epoch (argv-boundary gate, prevention-log #6);
    anything else raises -- a typo'd --now silently meaning 'live clock'
    could open a window that should be closed."""
    lane, now = None, None
    pos, i = [], 0
    while i < len(args):
        if args[i] == "--lane" and i + 1 < len(args):
            lane = args[i + 1]
            i += 2
        elif args[i] == "--now":
            if i + 1 >= len(args):
                raise ValueError("--now needs a digits-only epoch value")
            v = args[i + 1]
            if not v or not all(c in "0123456789" for c in v):
                raise ValueError("--now must be a digits-only epoch")
            now = int(v)
            i += 2
        else:
            pos.append(args[i])
            i += 1
    return pos, lane, now


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        pos, lane, now = _cli_opts(rest)
    except ValueError as exc:
        print("triggers.py: %s" % exc, file=sys.stderr)
        return 2
    if now is None:
        now = int(time.time())
    if cmd in ("dispatch", "cron", "validate", "event") and len(pos) != 1:
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
        trigs = [t for t in trigs if in_run_window(t, now)]
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
        trigs = [t for t in trigs if in_run_window(t, now)]
        for t in trigs:
            if t["firing"]["mode"] == "schedule":
                print("%s\t%s\t%s" % (t["name"], t["firing"]["schedule"],
                                      t["kind"]))
        return 0
    if cmd == "event":
        # Event-mode listing for the supervisor's event resolver. Until the
        # Task 10 cutover shims event roles, this lists NATIVES only (and
        # nothing fires them -- the collision refusals hold, decision 15).
        # evspec = the single event for a native; a shim carries events_csv.
        try:
            trigs, warns = enumerate_triggers(pos[0], lane)
        except PipelineError as exc:
            print("triggers event: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        trigs = [t for t in trigs if in_run_window(t, now)]
        for t in trigs:
            f = t["firing"]
            if f.get("mode") != "event":
                continue
            c = t["concurrency"]
            spec = f.get("events_csv") if t["kind"] == "shim" else f.get("event")
            print("%s\t%s\t%s\t%s\t%d" % (t["name"], t["kind"], spec,
                                          c["policy"], c["max"]))
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
        trigs = [t for t in trigs if in_run_window(t, now)]
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
        print("WINDOW=%s" % ("open" if in_run_window(t, now) else "closed"))
        return 0
    if cmd == "trust":
        if len(pos) != 2:
            print("usage: triggers.py trust <repo> <journal>",
                  file=sys.stderr)
            return 2
        try:
            rows, rollup, warns = trust_rollup(pos[0], pos[1])
        except PipelineError as exc:
            print("triggers trust: %s" % exc, file=sys.stderr)
            return 1
        for w in warns:
            print("WARN %s" % w, file=sys.stderr)
        for r in rows:
            print("TRIGGER\t%s\t%s\t%s\t%d\t%d\t%s" % (
                r["trigger"], r["pipeline"], r["kind"], r["runs"],
                r["passes"], r["tier"]))
        # Refusals land on STDOUT too (CP1 finding 1): the trust surface
        # itself must carry "a trigger here is unreadable" -- a refused
        # file can't be attributed to a pipeline, so no rollup floor can
        # represent it. Tabs in the reason are flattened so the row stays
        # 2-field parseable.
        for w in warns:
            if w.startswith("refused"):
                print("REFUSED\t%s" % w.replace("\t", " "))
        for p in sorted(rollup):
            print("PIPELINE\t%s\t%s" % (p, rollup[p]))
        return 0
    if cmd == "firecheck":
        # Run-now payload classification for resolve_manual_fires (Phase
        # D2, #383): rc 0 = usable, rc 3 = bad payload (caller removes the
        # marker loudly), rc 1 = transient (caller keeps + defers).
        if len(pos) != 3:
            print("usage: triggers.py firecheck <repo> <name> <payload-file>",
                  file=sys.stderr)
            return 2
        cls, reason = fire_params_check(pos[0], pos[1], pos[2])
        if reason:
            print("triggers firecheck: %s" % reason, file=sys.stderr)
        return {"ok": 0, "payload": 3}.get(cls, 1)
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
