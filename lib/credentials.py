#!/usr/bin/env python3
"""Named-credential store for the autonomy engine (#51).

Subscriptions (the claude/codex CLI logins the Coder loop uses) are the
default auth and need nothing here. This module is for the OPTIONAL API-key
path: multiple keys, each with a label, assignable to roles.

Split of responsibility:
  - SECRETS live in a keystore -- macOS Keychain in production (one generic
    password per label under service 'autonomy-engine'). Secrets are never
    written to a file by this module, never returned by list(), never logged.
  - The NON-SECRET index (~/.config/autonomy/credentials.json) holds only
    {label -> {provider, created_at}} and {role -> label} assignments.

The keystore is injected, so tests use an in-memory double and never touch
the real login keychain. `get_secret` / `resolve_for_role` are the only
paths that return a secret and exist solely for run-time consumers.

stdlib only; macOS. CLI at the bottom reads secrets from STDIN (never argv,
which would leak via `ps`).
"""
import json
import os
import re
import subprocess
import sys
import time

SERVICE = "autonomy-engine"
_LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_PROVIDER_RE = re.compile(r"^[A-Za-z0-9._-]{0,32}$")


def default_index_path():
    return os.path.expanduser("~/.config/autonomy/credentials.json")


class KeychainStore:
    """macOS Keychain backend. Thin shim over `security(1)` -- kept free of
    logic so the tested surface is the pure store in Credentials. Not unit
    tested (it would mutate the real login keychain); exercised manually."""

    def get(self, label):
        try:
            out = subprocess.run(
                ["security", "find-generic-password", "-s", SERVICE,
                 "-a", label, "-w"],
                capture_output=True, text=True)
        except OSError:
            return None
        if out.returncode != 0:
            return None
        return out.stdout.rstrip("\n")

    def set(self, label, secret):
        # -U updates in place if the item exists. The secret rides argv to
        # `security` (the tool has no stdin path); the exposure is a brief
        # same-user subprocess on the operator's own Mac.
        subprocess.run(
            ["security", "add-generic-password", "-U", "-s", SERVICE,
             "-a", label, "-w", secret],
            capture_output=True, text=True, check=True)

    def delete(self, label):
        subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE, "-a", label],
            capture_output=True, text=True)


class Credentials:
    def __init__(self, store=None, index_path=None):
        self.store = store if store is not None else KeychainStore()
        self.index_path = index_path or default_index_path()

    # --- index io -------------------------------------------------------------
    def _load(self):
        try:
            with open(self.index_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
        data.setdefault("credentials", {})
        data.setdefault("assignments", {})
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

    # --- credentials ----------------------------------------------------------
    def set(self, label, secret, provider="", now=None):
        if not _LABEL_RE.match(label or ""):
            raise ValueError("label must be 1-64 chars of [A-Za-z0-9._-]")
        if not (secret or "").strip():
            raise ValueError("secret must not be empty")
        if not _PROVIDER_RE.match(provider or ""):
            raise ValueError("provider must be <=32 chars of [A-Za-z0-9._-]")
        data = self._load()
        entry = data["credentials"].get(label, {})
        if "created_at" not in entry:
            entry["created_at"] = int(now if now is not None else time.time())
        entry["provider"] = provider or ""
        data["credentials"][label] = entry
        # store the secret only after the index write would be valid, but
        # before persisting -- if the keystore write throws, we don't record
        # a label with no backing secret.
        self.store.set(label, secret)
        self._save(data)

    def list(self):
        data = self._load()
        out = []
        for label in sorted(data["credentials"]):
            e = data["credentials"][label]
            out.append({
                "label": label,
                "provider": e.get("provider", ""),
                "created_at": e.get("created_at"),
                "is_set": self.store.get(label) is not None,
            })
        return out

    def get_secret(self, label):
        return self.store.get(label)

    def delete(self, label):
        self.store.delete(label)
        data = self._load()
        data["credentials"].pop(label, None)
        data["assignments"] = {r: lbl for r, lbl in data["assignments"].items()
                               if lbl != label}
        self._save(data)

    # --- role assignment ------------------------------------------------------
    def assign(self, role, label):
        if not (role or "").strip():
            raise ValueError("role must not be empty")
        data = self._load()
        if label not in data["credentials"]:
            raise KeyError("no credential labelled %r" % (label,))
        data["assignments"][role] = label
        self._save(data)

    def unassign(self, role):
        data = self._load()
        data["assignments"].pop(role, None)
        self._save(data)

    def assignments(self):
        return dict(self._load()["assignments"])

    def resolve_for_role(self, role):
        label = self._load()["assignments"].get(role)
        return self.get_secret(label) if label else None


def _main(argv):
    c = Credentials()
    if not argv:
        print("usage: credentials.py list | set <label> [provider] (secret on stdin) | "
              "get <label> | delete <label> | assign <role> <label> | "
              "unassign <role> | assignments | resolve-role <role>", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "list":
            print(json.dumps(c.list()))
        elif cmd == "assignments":
            print(json.dumps(c.assignments()))
        elif cmd == "set":
            if not rest:
                print("set needs <label>", file=sys.stderr); return 2
            secret = sys.stdin.read().rstrip("\n")  # never on argv
            c.set(rest[0], secret, provider=rest[1] if len(rest) > 1 else "")
        elif cmd == "get":
            s = c.get_secret(rest[0]) if rest else None
            if s is None:
                return 1
            sys.stdout.write(s)
        elif cmd == "delete":
            c.delete(rest[0])
        elif cmd == "assign":
            c.assign(rest[0], rest[1])
        elif cmd == "unassign":
            c.unassign(rest[0])
        elif cmd == "resolve-role":
            s = c.resolve_for_role(rest[0]) if rest else None
            if s is None:
                return 1
            sys.stdout.write(s)
        else:
            print("unknown command %r" % cmd, file=sys.stderr)
            return 2
    except (ValueError, KeyError, IndexError) as e:
        print("credentials.py: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
