@echo off
REM ---------------------------------------------------------------------------
REM  Tango DIBBS + SBIR/STTR contract capture - read-only.
REM
REM  Double-click this file, or run it from any prompt. A thin wrapper so no
REM  long path has to be pasted into a terminal; run-contract-capture.ps1 next
REM  to it holds the actual logic and all the guards.
REM
REM  WHAT IT DOES: five GETs, five records each, from
REM    /api/dibbs/rfqs   /api/dibbs/rfps   /api/dibbs/awards
REM    /api/sbir/topics  /api/sbir/solicitations
REM  and writes ONE json artifact. No database. No writes. No mutation.
REM
REM  WHY: P17's probe answered entitlement and confirmed the pagination
REM  envelope. It captured no response BODIES, so every field type, null
REM  semantic and date format in P40-P43 is still a reading of a published
REM  field NAME. This is the first observation of the record contents, and it
REM  is the "full contract validation" gate the completion matrix has carried
REM  since P40.
REM
REM  The API key is fetched from AWS Secrets Manager by that script, is never
REM  displayed, never passed as an argument, and never written to the artifact.
REM
REM  WHO MAY RUN THIS: an operator, at a keyboard. Plan section 4.6 forbids a
REM  key passing through an agent session; the standing capiro-dev AWS approval
REM  does not override that.
REM
REM  RATE BUDGET: 5 requests. The account allows 25 per ~31s. If you just ran
REM  the P17 probe, wait about half a minute for a fresh window.
REM
REM  Defaults to the checkout that contains this file. Pass a different repo
REM  root as the first argument to override:
REM      contract-capture.cmd C:\dev\capiro-p17-wt
REM ---------------------------------------------------------------------------

set "SCRIPT=%~dp0run-contract-capture.ps1"

if not exist "%SCRIPT%" (
  echo ERROR: capture script not found next to this file:
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
echo Done. The capture path is printed above - send that file back.
echo.
pause
