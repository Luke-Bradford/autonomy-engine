#!/usr/bin/env python3
"""autonomy console -- the engine's single foreground service, in your terminal.

Default (`bin/console.py`): it becomes THE running service -- it owns the web
dashboard that hosts the site and streams the live work log in the foreground, a
running log of work like a dev-server task. No prompt. Ctrl-C stops it; re-run to
restart. It first boots out the background launchd dashboard daemon so there is
ONE service, not two fighting for the port.

`--interactive` gives the older command console instead (a prompt with
status / pause / resume / chat / web / logs / quit), for when you want to poke at
the system rather than watch it.

Cross-platform by design -- Python stdlib only (subprocess / threading /
webbrowser), so it runs the same on macOS, Linux, and Windows (the launchd
bootout is a no-op off macOS). The rich helpers are the testable core; the
service loop and REPL at the bottom are thin I/O.

  bin/console.py [--port N] [--interactive] [--no-dashboard]
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


# --- log streaming + service loop -------------------------------------------

def _emit_new_log_lines(offsets):
    """One pass: for each registered repo's supervisor.log, print newly-appended
    lines (prefixed '│'). Mutates `offsets` (path -> byte offset); first sight of
    a file records its end so only NEW work streams (no history dump). Portable
    seek/read poll -- no `tail -f` dependency."""
    for r in registered_repos():
        path = os.path.join(r, *_LOGDIR, "supervisor.log")
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        start = offsets.get(path)
        if start is None:
            offsets[path] = size              # first sight -> only tail new
            continue
        if size < start:                      # rotated/truncated
            start = 0
        if size <= start:
            continue
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


def _stop_background_dashboard():
    """Best-effort: bootout the launchd dashboard DAEMON so this console is the
    single service hosting the site (no port fight). macOS-only; a no-op where
    there is no launchd (Windows/Linux without it -- no daemon there anyway)."""
    if sys.platform != "darwin":          # launchctl is macOS-only
        return
    try:
        subprocess.run(
            ["launchctl", "bootout", "gui/%d/com.autonomy.dashboard" % os.getuid()],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        pass


def _reap(proc, timeout=5):
    """Best-effort: terminate a child and WAIT for it so it does not linger as a
    zombie. Escalates to kill() if it ignores SIGTERM; swallows every error
    (shutdown path -- a reap hiccup must never mask the real exit)."""
    if proc is None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except Exception:                 # SIGTERM ignored / wait timed out
            proc.kill()
            proc.wait(timeout=timeout)
    except Exception:
        pass


def _launch_dashboard(port, quiet=False):
    """Start the dashboard subprocess. Default service mode INHERITS this
    terminal's stdout/stderr so the dashboard's own logs stream into the running
    log; quiet=True (interactive mode) silences it to keep the prompt clean.
    None on failure."""
    out = subprocess.DEVNULL if quiet else None
    try:
        return subprocess.Popen(
            [sys.executable, os.path.join(ENGINE_HOME, "bin", "dashboard.py"),
             "--port", str(port)], stdout=out, stderr=out)
    except Exception as exc:
        print("could not start dashboard: %s" % exc)
        return None


def run_stream(port, launch=True):
    """THE service (default mode): own the dashboard that hosts the site and
    stream the live work log in the foreground -- a running log of work, like a
    dev-server task. No prompt. Ctrl-C stops it; re-run to restart. Relaunches
    the dashboard if it exits, so the site stays up while the console runs."""
    dash = None
    if launch:
        _stop_background_dashboard()          # consolidate to ONE dashboard
        dash = _launch_dashboard(port)
        time.sleep(1.0)
    print("\n== autonomy service ==  hosting http://127.0.0.1:%s/  "
          "(Ctrl-C to stop; re-run to restart)" % port)
    for ln in status_lines():
        print("  " + ln)
    print("─ live work log " + "─" * 34)
    sys.stdout.flush()                        # show the header now, not on first log line
    offsets = {}
    try:
        while True:
            if dash is not None and dash.poll() is not None:
                sys.stdout.write("│ (dashboard exited rc=%s -- relaunching)\n"
                                 % dash.returncode)
                sys.stdout.flush()
                dash = _launch_dashboard(port)
            _emit_new_log_lines(offsets)
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        _reap(dash)
        print("\nservice stopped.")


def _tail_logs(state):
    """Background log stream for interactive mode (the foreground there is the
    command prompt)."""
    offsets = {}
    while not state.get("quit"):
        if state.get("logs", True):
            _emit_new_log_lines(offsets)
        time.sleep(1.0)


def _run_repl(port, launch=True):
    """Interactive mode (--interactive): the dashboard runs quietly and you get a
    command prompt (status/pause/resume/chat/web/logs/quit); logs stream in a
    background thread."""
    state = {"port": port, "logs": True, "quit": False, "dash": None}
    if launch:
        state["dash"] = _launch_dashboard(port, quiet=True)
    print("== autonomy console (interactive) ==  http://127.0.0.1:%s/" % port)
    print("\n".join(status_lines()))
    print("type 'help' for commands; Ctrl-C to stop.\n")
    threading.Thread(target=_tail_logs, args=(state,), daemon=True).start()
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
        _reap(state.get("dash"))
        print("\nstopped.")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port, launch, interactive = 8787, True, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--port" and i + 1 < len(argv):
            port = argv[i + 1]
            i += 2
        elif a == "--no-dashboard":
            launch = False
            i += 1
        elif a in ("--interactive", "-i"):
            interactive = True
            i += 1
        else:
            i += 1
    if interactive:
        _run_repl(port, launch)
    else:
        run_stream(port, launch)


if __name__ == "__main__":
    main()
