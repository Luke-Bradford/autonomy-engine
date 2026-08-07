#!/usr/bin/env python3
"""Local-LLM "system concierge" -- token-free whole-system Q&A + visibility.

The operator asks about the engine in plain language ("is the loop alive? what's
it working on? what's left on the board?") and gets an answer from a LOCAL
OpenAI-compatible endpoint (Ollama etc.), so it costs ZERO subscription quota and
can run continuously. This module builds a compact summary of the engine's live
state and calls the endpoint; the dashboard wires it to a chat panel.

Design:
  build_context(repos)  -- pure: live state dicts -> a system-prompt string.
  chat(...)             -- the one network edge: POST /chat/completions, return
                           the reply text. Raises on transport error so the
                           caller can degrade gracefully (endpoint down etc.).
  _reply_text(body)     -- pure: OpenAI chat JSON -> assistant text (testable
                           without a network).

Stdlib only (urllib), mirroring lib/accounts.py's local-endpoint HTTP.
"""
import json
import re
import urllib.request

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)


def strip_thinking(text):
    """Drop <think>...</think> spans that reasoning models (qwen3, deepseek-r1)
    emit, leaving just the operator-facing answer. Idempotent; returns the input
    unchanged when there are no such spans. A dangling unclosed <think> (a
    truncated reply) drops everything from the tag onward."""
    if not text:
        return ""
    out = _THINK_RE.sub("", text)
    i = out.find("<think>")
    if i != -1:
        out = out[:i]
    return out.strip()


def _fmt_reset(hours):
    """'+4.9h' / '-0.3h' for a hours-from-now float; '' if not a number."""
    try:
        return "%+.1fh" % float(hours)
    except (TypeError, ValueError):
        return ""


def build_context(repos, now_note=None):
    """A compact plain-text summary of the whole system for the LLM's system
    prompt. `repos` is a list of build_repo_state()-shaped dicts (one per
    registered loop). Reads every field defensively (.get) so a shape change
    omits a line rather than crashing -- the concierge must never be the thing
    that breaks. `now_note` is an optional caller-supplied line (e.g. wall
    clock) appended verbatim."""
    out = ["You are the system concierge for an autonomy engine: it runs "
           "AI coding-agent loops (Claude Code / Codex / local LLMs) against "
           "git repos, drains their issue boards, and merges via a review gate.",
           "", "LIVE STATE:"]
    if not repos:
        out.append("- no repos registered.")
    for r in repos:
        repo = r.get("repo") or r.get("path") or "?"
        loop = r.get("loop") or {}
        state = loop.get("state") or r.get("loop_state") or "unknown"
        out.append("- repo `%s`: loop %s" % (repo, state))
        sess = r.get("session") or {}
        ticket = sess.get("ticket")
        if ticket:
            step = sess.get("step") or sess.get("current_step") or ""
            out.append("    working #%s %s" % (ticket, step))
        started = sess.get("started_at") or sess.get("age")
        if started:
            out.append("    last session: %s" % started)
        quota = r.get("quota") or {}
        qbits = []
        for wt, label in (("five_hour", "5h"), ("seven_day", "7d")):
            w = quota.get(wt)
            if isinstance(w, dict) and w.get("utilization") is not None:
                qbits.append("%s %d%%" % (label, round(float(w["utilization"]) * 100)))
        if qbits:
            out.append("    quota: " + ", ".join(qbits))
        issues = r.get("open_issues") or r.get("issues")
        if isinstance(issues, (int, float)):
            out.append("    open issues: %d" % int(issues))
    if now_note:
        out.append("")
        out.append(now_note)
    out.append("")
    out.append("Answer the operator's question about THIS system, concisely and "
               "specifically. If they ask to raise a ticket, pause/resume a loop, "
               "or push a ticket forward, state exactly what action you would take "
               "(e.g. 'file issue: <title>') -- a human confirms and the app "
               "executes it; you do not act directly.")
    return "\n".join(out)


def _reply_text(body):
    """Assistant text from an OpenAI /chat/completions JSON body. Returns '' on
    any shape problem -- pure, so it's unit-testable with no network."""
    try:
        return (body["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        return ""


def chat(base_url, model, context, message, history=None, timeout=60):
    """POST an OpenAI-compatible /chat/completions request to a LOCAL endpoint
    and return the assistant reply text. Token-free (the endpoint is local).

    `context` is the build_context() system prompt; `history` is a list of prior
    {"role","content"} turns (may be None). Raises urllib.error.URLError / OSError
    on a transport failure -- the caller (dashboard) catches and shows "local
    endpoint unreachable" rather than 500ing.
    """
    messages = [{"role": "system", "content": context}]
    for turn in (history or []):
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})
    payload = json.dumps({"model": model, "messages": messages,
                          "stream": False}).encode("utf-8")
    url = base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    return _reply_text(body)
