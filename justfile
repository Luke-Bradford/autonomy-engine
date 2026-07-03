# autonomy-engine task runner (https://github.com/casey/just).
# `just` lists recipes; `just console` opens the terminal control app.
# These are thin wrappers over ./start so there is ONE source of behaviour.

# default: show the recipe list
default:
    @just --list

# terminal control app: dashboard + live logs + commands (Ctrl-C to stop)
console:
    ./start console

# one-shot health report (dashboard, loops, quota) -- read-only
status:
    ./start status

# hard-stop the background dashboard service
stop:
    ./start stop

# onboard a repo (guided): just onboard /path/to/repo
onboard repo:
    ./start "{{repo}}"
