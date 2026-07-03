#!/usr/bin/env python3
"""autonomy console -- a foreground terminal control app for the engine.

Run it and you get a VISIBLE running application: it launches the web dashboard,
streams the engine's logs as they happen, shows status, and takes commands
(status / pause / resume / chat / web / logs / quit). Ctrl-C or `quit` stops it.

Cross-platform by design -- Python stdlib only (subprocess / threading /
webbrowser), no bash and no launchd -- so it runs the same on macOS, Linux, and
Windows. The rich helpers below are the testable core; the read-eval loop and the
log-tail thread at the bottom are thin I/O.

  bin/console.py [--port N] [--no-dashboard]
"""
import os
import sys
import subprocess
import threading
import time
import webbrowser

ENGINE_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE_HOME, "lib"))
import concierge  # noqa: E402
try:                                   # optional at import: keep the console usable
    import accounts as accts           # even if a lib is briefly unavailable
except Exception:                      # pragma: no cover
    accts = None
try:
    import dashboard_state as ds
except Exception:                      # pragma: no cover
    ds = None

REPOS_FILE = os.path.expanduser("~/.config/autonomy/repos")
PAUSE_NAME = "autonomy-PAUSE"
_LOGDIR = ("var", "autonomy-logs")

HELP = """commands:
  status            loop + dashboard status
  pause [repo]      pause a loop (all registered if repo omitted)
  resume [repo]     resume a loop
  chat <message>    ask the LOCAL LLM about the system (token-free)
  web               open the dashboard in a browser
  logs on|off       toggle the live log stream
  help              this list
  quit              stop the dashboard and exit  (Ctrl-C also works)"""


def registered_repos(repos_file=None):
    """Registered loop repos, one per non-blank line; [] if the registry is
    absent/unreadable (the console must still start)."""
    try:
        with open(repos_file or REPOS_FILE) as fh:
            return [ln.strip() for ln in fh if ln.strip()]
    except OSError:
        return []


def _pid_alive(pid):
    try:
        os.kill(pid, 0)            # signal 0 = liveness probe (POSIX)
        return True
    except OSError:
        return False
    except (ValueError, TypeError):
        return False


def loop_state(repo, pid_alive=_pid_alive):
    """running | paused | stopped for one repo -- from the supervisor lock pid
    and the PAUSE sentinel (a Python read of the same files start(1) uses).
    Fail-safe: anything uncertain reads stopped, never a false running.
    `pid_alive` is injected so tests need no real process."""
    pause = os.path.join(repo, *_LOGDIR, PAUSE_NAME)
    lock_pid = os.path.join(repo, "var", "autonomy-supervisor.lock", "pid")
    try:
        with open(lock_pid) as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        return "stopped"
    if not pid_alive(pid):
        return "stopped"
    return "paused" if os.path.exists(pause) else "running"


def status_lines(repos=None):
    """Human-readable status block: one line per registered loop."""
    reps = registered_repos() if repos is None else repos
    if not reps:
        return ["no repos registered -- './start /path/to/repo' to onboard one"]
    return ["%-8s %s" % (loop_state(r), r) for r in reps]


def _pause_resume(verb, arg):
    """pause/resume by writing/removing the PAUSE sentinel (best-effort, per
    repo). arg empty -> all registered repos."""
    reps = [arg] if arg else registered_repos()
    if not reps:
        return "no repos registered"
    out = []
    for r in reps:
        sentinel = os.path.join(r, *_LOGDIR, PAUSE_NAME)
        try:
            if verb == "pause":
                os.makedirs(os.path.dirname(sentinel), exist_ok=True)
                open(sentinel, "a").close()
                out.append("paused  " + r)
            else:
                if os.path.exists(sentinel):
                    os.remove(sentinel)
                out.append("resumed " + r)
        except OSError as exc:
            out.append("failed %s: %s" % (r, exc))
    return "\n".join(out)


def concierge_reply(message, repos=None):
    """Ask the local LLM about the system. Returns the reply text, or a
    human-readable '(concierge) ...' notice when no local endpoint is usable --
    never raises into the read-eval loop."""
    if accts is None:
        return "(concierge) accounts library unavailable"
    try:
        acc = accts.Accounts()
        local = [a.get("name") for a in acc.list()
                 if a.get("kind") == "openai_compatible"]
    except Exception as exc:
        return "(concierge) account registry error: %s" % exc
    if not local:
        return ("(concierge) no local LLM configured -- register an "
                "openai_compatible account (e.g. Ollama) first")
    name = local[0]
    try:
        base_url = acc.resolve(name)["env"]["OPENAI_BASE_URL"]
        models = acc.list_models(name)
    except Exception as exc:
        return "(concierge) cannot resolve '%s': %s" % (name, exc)
    model = models[0] if models else "qwen3:14b"
    reps = registered_repos() if repos is None else repos
    state = []
    for r in reps:
        entry = {"repo": r, "loop": {"state": loop_state(r)}}
        if ds is not None:
            try:
                entry["quota"] = ds.recent_quota_windows(
                    os.path.join(r, *_LOGDIR))
            except Exception:
                pass
        state.append(entry)
    context = concierge.build_context(state)
    try:
        reply = concierge.chat(base_url, model, context, message, timeout=120)
    except Exception as exc:
        return "(concierge) local endpoint '%s' unreachable: %s" % (name, exc)
    return concierge.strip_thinking(reply) or "(concierge) empty reply"


def dispatch(line, state):
    """Execute one command line; return the text to print (may be ''). `state`
    is a mutable dict shared with the loop (port, logs flag, quit flag). Pure
    w.r.t. everything except the side effects each command names -- so the parse
    + routing is unit-testable."""
    parts = line.strip().split(None, 1)
    if not parts:
        return ""
    verb = parts[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""
    if verb in ("quit", "exit", "q"):
        state["quit"] = True
        return "stopping ..."
    if verb in ("help", "?"):
        return HELP
    if verb == "status":
        return "\n".join(status_lines())
    if verb in ("pause", "resume"):
        return _pause_resume(verb, arg)
    if verb == "chat":
        return concierge_reply(arg) if arg else "usage: chat <message>"
    if verb == "web":
        url = "http://127.0.0.1:%s/" % state.get("port", 8787)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        return "opening " + url
    if verb == "logs":
        state["logs"] = (arg.lower() != "off")
        return "live logs " + ("on" if state["logs"] else "off")
    return "unknown command: %s  (try 'help')" % verb


# --- thin I/O: log-tail thread + read-eval loop -----------------------------

def _tail_logs(state):
    """Follow each repo's supervisor.log and print only newly-appended lines.
    Starts at each file's current end (no history dump). Portable: plain
    seek/read poll, not `tail -f`."""
    offsets = {}
    while not state.get("quit"):
        if state.get("logs", True):
            for r in registered_repos():
                path = os.path.join(r, *_LOGDIR, "supervisor.log")
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue
                start = offsets.get(path)
                if start is None:
                    offsets[path] = size          # first sight -> only tail new
                    continue
                if size < start:                  # rotated/truncated
                    start = 0
                if size > start:
                    try:
                        with open(path, errors="replace") as fh:
                            fh.seek(start)
                            new = fh.read()
                    except OSError:
                        continue
                    offsets[path] = size
                    for ln in new.splitlines():
                        sys.stdout.write("│ %s\n" % ln)
                    sys.stdout.flush()
        time.sleep(1.0)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port, launch = 8787, True
    i = 0
    while i < len(argv):
        if argv[i] == "--port" and i + 1 < len(argv):
            port = argv[i + 1]
            i += 2
        elif argv[i] == "--no-dashboard":
            launch = False
            i += 1
        else:
            i += 1
    state = {"port": port, "logs": True, "quit": False, "dash": None}
    if launch:
        try:
            state["dash"] = subprocess.Popen(
                [sys.executable, os.path.join(ENGINE_HOME, "bin", "dashboard.py"),
                 "--port", str(port)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            print("could not launch dashboard: %s" % exc)
    print("== autonomy console ==  dashboard: http://127.0.0.1:%s/" % port)
    print("\n".join(status_lines()))
    print("type 'help' for commands; Ctrl-C to stop.\n")
    tail = threading.Thread(target=_tail_logs, args=(state,), daemon=True)
    tail.start()
    try:
        while not state["quit"]:
            try:
                line = input("autonomy> ")
            except EOFError:
                break
            out = dispatch(line, state)
            if out:
                print(out)
    except KeyboardInterrupt:
        pass
    finally:
        state["quit"] = True
        dash = state.get("dash")
        if dash is not None:
            try:
                dash.terminate()
            except Exception:
                pass
        print("\nstopped.")


if __name__ == "__main__":
    main()
