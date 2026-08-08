@echo off
REM ---------------------------------------------------------------------------
REM  P17 Tango capability probe - read-only.
REM
REM  Double-click this file, or run it from any prompt. A thin wrapper so no
REM  long path has to be pasted into a terminal; run-p17-probe.ps1 next to it
REM  holds the actual logic and all the guards.
REM
REM  The API key is fetched from AWS Secrets Manager by that script, and is
REM  never displayed, never passed as an argument, and never written to disk.
REM
REM  WHO MAY RUN THIS: an operator, at a keyboard. Plan section 4.6 forbids a
REM  key passing through an agent session; the standing capiro-dev AWS approval
REM  does not override that.
REM
REM  Defaults to the checkout that contains this file. Pass a different repo
REM  root as the first argument to override:
REM      p17.cmd C:\dev\capiro-p17-wt
REM ---------------------------------------------------------------------------

set "SCRIPT=%~dp0run-p17-probe.ps1"

if not exist "%SCRIPT%" (
  echo ERROR: probe script not found next to this file:
  echo   %SCRIPT%
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -RepoPath "%~1"
)

echo.
echo ---------------------------------------------------------------------------
echo Done. The report path is printed above.
echo.
pause
