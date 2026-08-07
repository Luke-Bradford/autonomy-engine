@echo off
REM ==========================================================================
REM  Start Autonomy  (Windows -- double-click me)
REM
REM  Runs the control-room site and opens it in your browser.
REM  Close this window to stop.
REM
REM  To change the port, edit  %USERPROFILE%\.config\autonomy\settings
REM  and add a line:   port = 8787
REM ==========================================================================
cd /d "%~dp0"

set "PORT=8787"
for /f "delims=" %%p in ('python lib\settings.py port 2^>nul') do set "PORT=%%p"

echo == Autonomy control room ==
echo   site:   http://127.0.0.1:%PORT%/
echo   config: %USERPROFILE%\.config\autonomy\settings   (set 'port = N')
echo   stop:   close this window
echo.

start "" "http://127.0.0.1:%PORT%/"
python bin\dashboard.py --port %PORT%
