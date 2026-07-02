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


class Accounts:
    def __init__(self, index_path=None, credentials=None):
        self.index_path = index_path or default_index_path()
        self.credentials = (credentials if credentials is not None
                            else _credentials.Credentials())

    def _load(self):
        try:
            with open(self.index_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
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
        if not _NAME_RE.match(name or ""):
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
        data = self._load()
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
        data = self._load()
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
        secret = self.credentials.get_secret(entry.get("credential"))
        if not secret:
            raise LookupError(
                "account %r credential %r has no secret in the Keychain"
                % (name, entry.get("credential")))
        return {"kind": kind, "env": {var: secret}}
