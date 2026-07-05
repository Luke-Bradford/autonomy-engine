#!/usr/bin/env python3
"""Global agent-entity registry for the autonomy engine (#87 / SD-30).

An *agent entity* is a named bundle of defaults a repo binding points at:
  - account:     which named account (lib/accounts.py) it authenticates from
  - model:       default model id (optional)
  - effort:      default reasoning effort (optional; one of VALID_EFFORTS)
  - rail:        the role rail it plays (optional reference)
  - description: a human label (optional)

This is DISTINCT from the low-level *adapter* (`bin/agents/<name>.sh` -- which
CLI actually runs); adapters keep their own `roles.<x>.agent` field. Agents are
GLOBAL (one machine-wide roster); bindings stay in each repo's `roles:` block
and carry the per-binding rules (trigger, scope, lane, gate, budget) -- the
repo-agnostic invariant is untouched.

Storage mirrors accounts.py exactly: the index (~/.config/autonomy/agents) is
stdlib JSON, mode 600, written atomically (tmp + os.replace), and holds only
names / refs / labels -- NEVER a secret. Cross-registry existence (does
`account` name a real account? does `rail` name a real role?) is NOT checked
here: a dangling reference degrades to a doctor WARNING + a ⚠ badge in the UI
(SD-30) -- never silently dropped, never fail-open. Reads degrade a corrupt
index to empty (never destructive); writes REFUSE on a corrupt index rather
than overwrite unreadable entries (#59). stdlib only; macOS.
"""
import json
import os
import re
import sys

# The effort SSOT lives in dashboard_control (the control surface already
# validates it there); dashboard_state.py already imports it the same way, so
# the registry, the live control, and the config picker cannot drift.
import dashboard_control as _dcx

# Same shape as accounts/credentials names: 1-64 chars of [A-Za-z0-9._-]. Used
# for the agent name itself AND for the `account`/`rail` references it carries,
# so a malformed ref can never reach a shell or a config write.
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def default_index_path():
    return os.path.expanduser("~/.config/autonomy/agents")


class RegistryError(RuntimeError):
    """The on-disk index exists but is unreadable/corrupt: unparseable JSON, a
    non-dict top level, or an `agents` section of the wrong type. Writes refuse
    (raise this) rather than overwrite the file and silently drop the unreadable
    entries -- fail-safe, never fail-open (#59). Reads degrade to an empty
    registry (a read never destroys data)."""


class Agents:
    def __init__(self, index_path=None):
        self.index_path = index_path or default_index_path()

    def _read(self):
        """Return (data, status). status is 'empty' (file absent -- a
        legitimately new registry), 'corrupt' (present but unparseable, a
        non-dict top level, or a non-dict `agents` section / entry), or 'ok'."""
        try:
            with open(self.index_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return {}, "empty"
        except (OSError, ValueError):
            return {}, "corrupt"
        if not isinstance(data, dict):
            return {}, "corrupt"
        # `in` (not .get()) so an explicit JSON null -- {"agents": null} -- is
        # caught: setdefault is a no-op on a present-null key and would leave
        # data["agents"] = None, crashing every downstream read/write.
        if "agents" in data:
            section = data["agents"]
            if not isinstance(section, dict) or \
                    any(not isinstance(v, dict) for v in section.values()):
                return {}, "corrupt"
        return data, "ok"

    def is_corrupt(self):
        """True when the index exists but cannot be read as a valid registry --
        distinct from an empty/absent one (lets doctor say 'unreadable' instead
        of 'no agents')."""
        return self._read()[1] == "corrupt"

    def _load(self):
        # Reads degrade a corrupt index to empty (never destructive).
        data, _status = self._read()
        data.setdefault("agents", {})
        return data

    def _load_for_write(self):
        # Writes refuse on a corrupt index -- overwriting it would silently drop
        # the unreadable entries (#59). An empty/absent registry is writable.
        data, status = self._read()
        if status == "corrupt":
            raise RegistryError(
                "agents registry at %s is unreadable/corrupt -- refusing to "
                "overwrite; fix or remove it first" % self.index_path)
        data.setdefault("agents", {})
        return data

    def _save(self, data):
        directory = os.path.dirname(os.path.abspath(self.index_path))
        os.makedirs(directory, exist_ok=True)
        tmp = self.index_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, self.index_path)
        os.chmod(self.index_path, 0o600)

    def set(self, name, account, model=None, effort=None, rail=None,
            description=None):
        """Create or overwrite agent `name`. `account` is required (an agent
        with no account could never resolve auth) but its EXISTENCE is not
        verified here -- a dangling ref is a doctor WARNING, not a write refusal
        (SD-30). Optional defaults are validated for shape only; absent ones are
        omitted from the stored entry so `get` reports them as None/''."""
        if not _NAME_RE.fullmatch(name or ""):
            raise ValueError("agent name must be 1-64 chars of [A-Za-z0-9._-]")
        if not _NAME_RE.fullmatch(account or ""):
            raise ValueError("agent requires an account ref of "
                             "1-64 chars [A-Za-z0-9._-]")
        entry = {"account": account}
        if effort is not None:
            if effort not in _dcx.VALID_EFFORTS:
                raise ValueError("effort must be one of %s"
                                 % (_dcx.VALID_EFFORTS,))
            entry["effort"] = effort
        if model is not None:
            if not str(model).strip():
                raise ValueError("model, when set, must be a non-empty id")
            entry["model"] = model
        if rail is not None:
            if not _NAME_RE.fullmatch(rail or ""):
                raise ValueError("rail ref must be 1-64 chars of "
                                 "[A-Za-z0-9._-]")
            entry["rail"] = rail
        if description is not None:
            if not isinstance(description, str):
                raise ValueError("description must be a string")
            entry["description"] = description
        data = self._load_for_write()
        data["agents"][name] = entry
        self._save(data)

    def _project(self, name, entry):
        """The public view of an entry -- optional fields normalised to
        None / '' so callers never KeyError on an omitted default."""
        return {"name": name,
                "account": entry.get("account", ""),
                "model": entry.get("model"),
                "effort": entry.get("effort"),
                "rail": entry.get("rail"),
                "description": entry.get("description", "")}

    def list(self):
        data = self._load()
        return [self._project(name, data["agents"][name])
                for name in sorted(data["agents"])]

    def get(self, name):
        entry = self._load()["agents"].get(name)
        if entry is None:
            return None
        e = self._project(name, entry)
        e.pop("name")   # get() returns the entry body, not the keyed name
        return e

    def delete(self, name):
        data = self._load_for_write()
        if data["agents"].pop(name, None) is not None:
            self._save(data)


def doctor_report(agents_index=None, accounts_index=None):
    """The doctor-WARNING half of SD-30: return report lines (WARN/OK) for the
    agents registry -- a corrupt index and dangling entity->account refs
    degrade to WARNs, never a crash, never silence. An absent/empty registry
    returns [] (the common healthy case -- no noise). The OK verdict is
    EARNED: agents exist, the accounts registry is readable, every ref
    resolves (prevention-log #18).

    A corrupt ACCOUNTS index is its own single cannot-verify WARN -- the naive
    set-lookup would accuse every agent of a dangling ref (fail-open, #3).

    `rail` refs are deliberately NOT validated here: entities are
    machine-global while rails resolve against a repo's `roles:` block, and
    the binding key tying an entity to a repo is an open #87 design fork --
    checking rails repo-wide before bindings exist would WARN on every repo
    that lacks the rail. Import is lazy so the registry CRUD path never pays
    for (or fails on) the accounts module."""
    import accounts as _accounts
    reg = Agents(index_path=agents_index)
    if reg.is_corrupt():
        return ["WARN agents registry %s is unreadable/corrupt -- reads "
                "degrade to empty and writes refuse; fix or remove it"
                % reg.index_path]
    entities = reg.list()
    if not entities:
        return []
    accts = _accounts.Accounts(index_path=accounts_index)
    if accts.is_corrupt():
        return ["WARN accounts registry %s is unreadable/corrupt -- cannot "
                "verify agent account refs (%d agent(s) unchecked)"
                % (accts.index_path, len(entities))]
    known = set()
    for row in accts.list():
        known.add(row["name"])
    lines = []
    for e in entities:
        acct = e["account"]
        # Total over hand-edited entries (prevention-log #12): a non-string /
        # empty ref would raise unhashable TypeError in the set lookup, and
        # doctor.sh's best-effort guard turns that crash into SILENCE -- the
        # one thing SD-30 forbids. Malformed gets its own WARN instead.
        if not isinstance(acct, str) or not acct:
            lines.append("WARN agent '%s' has a malformed account ref (%r) "
                         "-- fix or re-create the registry entry"
                         % (e["name"], acct))
        elif acct not in known:
            lines.append("WARN agent '%s' references unknown account '%s' -- "
                         "register the account or fix the ref (dangling refs "
                         "degrade to WARNING, SD-30)"
                         % (e["name"], acct))
    if not lines:
        lines.append("OK   agents registry: %d agent(s), all account refs "
                     "resolve" % len(entities))
    return lines


def _main(argv):
    a = Agents()
    if not argv:
        print("usage: agents.py list | get <name> | delete <name> | "
              "set <name> <account> [model] [effort] [rail] [description] | "
              "doctor-report [agents_index] [accounts_index]",
              file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "list":
            print(json.dumps(a.list()))
        elif cmd == "get":
            e = a.get(rest[0]) if rest else None
            if e is None:
                return 1
            print(json.dumps(e))
        elif cmd == "delete":
            if not rest:
                print("delete needs <name>", file=sys.stderr)
                return 2
            a.delete(rest[0])
        elif cmd == "doctor-report":
            for line in doctor_report(
                    agents_index=rest[0] if len(rest) > 0 else None,
                    accounts_index=rest[1] if len(rest) > 1 else None):
                print(line)
        elif cmd == "set":
            if len(rest) < 2:
                print("set needs <name> <account> [model] [effort] [rail] "
                      "[description]", file=sys.stderr)
                return 2
            name, account = rest[0], rest[1]
            a.set(name, account,
                  model=rest[2] if len(rest) > 2 else None,
                  effort=rest[3] if len(rest) > 3 else None,
                  rail=rest[4] if len(rest) > 4 else None,
                  description=rest[5] if len(rest) > 5 else None)
        else:
            print("unknown command %r" % cmd, file=sys.stderr)
            return 2
    except (RegistryError, ValueError, IndexError) as e:
        print("agents.py: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
