#!/usr/bin/env python3
"""Named-account registry for the autonomy engine (agent-org increment 1).

An account classifies an auth instance an agent can call from:
  - claude_subscription / codex_subscription: the CLI login already on the
    machine -- no secret, nothing to export.
  - anthropic_api / openai_api: points at a credentials.py Keychain label
    (#51); the secret stays in the Keychain.

The index (~/.config/autonomy/accounts) holds only names, kinds, and
credential LABELS -- never a secret. The credentials object is injected so
tests never touch the real Keychain. stdlib only; macOS.
"""
import json
import os
import re
import sys

import credentials as _credentials

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
VALID_KINDS = ("claude_subscription", "codex_subscription",
               "anthropic_api", "openai_api")
_SUBSCRIPTION_KINDS = ("claude_subscription", "codex_subscription")
# API kind -> the env var its key is exported as (used in Task 2)
_API_ENV = {"anthropic_api": "ANTHROPIC_API_KEY", "openai_api": "OPENAI_API_KEY"}


def default_index_path():
    return os.path.expanduser("~/.config/autonomy/accounts")


class RegistryError(RuntimeError):
    """The on-disk index exists but is unreadable/corrupt: unparseable JSON,
    a non-dict top level, or a required section of the wrong type. Writes
    refuse (raise this) rather than overwrite the file and silently drop the
    unreadable entries -- fail-safe, never fail-open (#59). Reads degrade to an
    empty registry (a read never destroys data)."""


class Accounts:
    def __init__(self, index_path=None, credentials=None):
        self.index_path = index_path or default_index_path()
        self.credentials = (credentials if credentials is not None
                            else _credentials.Credentials())

    def _read(self):
        """Return (data, status). status is 'empty' (file absent -- a
        legitimately new registry), 'corrupt' (present but unparseable, a
        non-dict top level, or a non-dict `accounts` section), or 'ok'."""
        try:
            with open(self.index_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return {}, "empty"
        except (OSError, ValueError):
            return {}, "corrupt"
        if not isinstance(data, dict):
            return {}, "corrupt"
        # Use `in` (not .get()) so an explicit JSON null -- {"accounts": null}
        # -- is caught: .get() returns None for both absent and null, but a
        # present-null section would slip past a `is not None` guard and leave
        # data["accounts"] = None (setdefault is a no-op on a present key),
        # crashing downstream reads/writes. Absent is fine (setdefault fills it).
        if "accounts" in data:
            section = data["accounts"]
            # the section must be a dict AND every entry a dict -- a non-dict
            # entry would crash list()/get() with AttributeError on a read and
            # let a write persist unreadable data.
            if not isinstance(section, dict) or \
                    any(not isinstance(v, dict) for v in section.values()):
                return {}, "corrupt"
        return data, "ok"

    def is_corrupt(self):
        """True when the index exists but cannot be read as a valid registry --
        distinct from an empty/absent one. Lets callers (doctor) say
        'unreadable' instead of 'no accounts'."""
        return self._read()[1] == "corrupt"

    def _load(self):
        # Reads degrade a corrupt index to empty (never destructive).
        data, _status = self._read()
        data.setdefault("accounts", {})
        return data

    def _load_for_write(self):
        # Writes refuse on a corrupt index -- overwriting it would silently drop
        # the unreadable entries (#59). An empty/absent registry is writable.
        data, status = self._read()
        if status == "corrupt":
            raise RegistryError(
                "accounts registry at %s is unreadable/corrupt -- refusing to "
                "overwrite; fix or remove it first" % self.index_path)
        data.setdefault("accounts", {})
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

    def set(self, name, kind, credential=None):
        if not _NAME_RE.fullmatch(name or ""):
            raise ValueError("account name must be 1-64 chars of [A-Za-z0-9._-]")
        if kind not in VALID_KINDS:
            raise ValueError("kind must be one of %s" % (VALID_KINDS,))
        if kind in _SUBSCRIPTION_KINDS:
            if credential:
                raise ValueError("subscription accounts take no credential")
            credential = None
        else:
            if not (credential or "").strip():
                raise ValueError("API accounts require a credential label")
        data = self._load_for_write()
        entry = {"kind": kind}
        if credential:
            entry["credential"] = credential
        data["accounts"][name] = entry
        self._save(data)

    def list(self):
        data = self._load()
        out = []
        for name in sorted(data["accounts"]):
            e = data["accounts"][name]
            cred = e.get("credential")
            out.append({"name": name, "kind": e.get("kind", ""),
                        "credential": cred, "has_credential": bool(cred)})
        return out

    def get(self, name):
        e = self._load()["accounts"].get(name)
        if e is None:
            return None
        return {"kind": e.get("kind", ""), "credential": e.get("credential")}

    def delete(self, name):
        data = self._load_for_write()
        if data["accounts"].pop(name, None) is not None:
            self._save(data)

    def resolve(self, name):
        """Resolve an account to {kind, env}. Subscriptions export nothing
        (CLI login); API kinds export their Keychain-backed key. Raises
        KeyError (no such account) / LookupError (API key unresolvable) --
        the caller must never run with broken auth (fail-safe)."""
        entry = self.get(name)
        if entry is None:
            raise KeyError(name)
        kind = entry["kind"]
        if kind in _SUBSCRIPTION_KINDS:
            return {"kind": kind, "env": {}}
        var = _API_ENV.get(kind)
        if var is None:
            raise LookupError(
                "account %r has unrecognized kind %r" % (name, kind))
        label = entry.get("credential")
        secret = self.credentials.get_secret(label) if label else None
        if not secret:
            raise LookupError(
                "account %r credential %r has no secret in the Keychain"
                % (name, label))
        return {"kind": kind, "env": {var: secret}}


def _main(argv):
    a = Accounts()
    if not argv:
        print("usage: accounts.py list | set <name> <kind> [credential] | "
              "get <name> | delete <name> | resolve <name>", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "list":
            print(json.dumps(a.list()))
        elif cmd == "set":
            if len(rest) < 2:
                print("set needs <name> <kind> [credential]", file=sys.stderr)
                return 2
            a.set(rest[0], rest[1], credential=rest[2] if len(rest) > 2 else None)
        elif cmd == "get":
            e = a.get(rest[0]) if rest else None
            if e is None:
                return 1
            print(json.dumps(e))
        elif cmd == "delete":
            a.delete(rest[0])
        elif cmd == "resolve":
            r = a.resolve(rest[0])   # raises KeyError/LookupError -> caught below
            for var, val in sorted(r["env"].items()):
                sys.stdout.write("%s=%s\n" % (var, val))
        else:
            print("unknown command %r" % cmd, file=sys.stderr)
            return 2
    except (RegistryError, ValueError, KeyError, LookupError, IndexError) as e:
        print("accounts.py: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
