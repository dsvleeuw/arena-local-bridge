@echo off
rem install.bat - the Windows entry point (no WSL, no Git Bash).
rem
rem   install.bat --email you@example.com
rem   install.bat --status
rem   install.bat --stop
rem
rem `bash install.sh` from cmd.exe only reaches the WSL launcher, which reports
rem "Windows Subsystem for Linux has no installed distributions". This script
rem runs the same installer in Node instead: bin/install.mjs. All arguments are
rem passed to Node unchanged, so `install.bat --help` lists the options.
setlocal
set "ROOT=%~dp0"

set "NODE="
if defined ARENA_NODE_PATH if exist "%ARENA_NODE_PATH%" set "NODE=%ARENA_NODE_PATH%"
if not defined NODE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ROOT%runtime\node.exe" set "NODE=%ROOT%runtime\node.exe"

if not defined NODE (
  if not defined ARENA_NODE_BOOTSTRAPPED (
    rem No Node yet. Install it, then re-enter this script with the SAME
    rem arguments: PowerShell's own parameter parsing would eat the leading
    rem dashes of --email/--port, so the arguments never pass through it.
    set "ARENA_NODE_BOOTSTRAPPED=1"
    where powershell.exe >nul 2>nul
    if errorlevel 1 (
      echo ERROR: Windows PowerShell was not found. It is part of Windows 10/11.
      exit /b 1
    )
    echo ==^> [0/7] Windows bootstrap ^(Node.js for bin/install.mjs^)
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%bin\bootstrap-node.ps1"
    if errorlevel 1 exit /b 1
    call "%~f0" %*
    if errorlevel 1 exit /b 1
    exit /b 0
  )
  echo ERROR: Node.js 20 or newer is required.
  echo        Install it from https://nodejs.org/en/download ^(or: winget install OpenJS.NodeJS.LTS^)
  echo        then run install.bat again.
  exit /b 1
)

if not exist "%ROOT%bin\install.mjs" (
  echo ERROR: bin\install.mjs is missing from %ROOT%. Extract the complete project folder.
  exit /b 1
)

"%NODE%" "%ROOT%bin\install.mjs" %*
set "CODE=%ERRORLEVEL%"

rem A double-clicked window must stay open long enough to read a failure.
rem ARENA_NO_PAUSE=1 suppresses the pause in unattended runs; --status exits 1
rem when the bridge is down, which is an answer rather than a failure to read.
set "PAUSE_ON_ERROR=1"
if "%ARENA_NO_PAUSE%"=="1" set "PAUSE_ON_ERROR=0"
if /i "%~1"=="--status" set "PAUSE_ON_ERROR=0"

if not "%CODE%"=="0" if "%PAUSE_ON_ERROR%"=="1" (
  echo.
  echo Command failed with exit code %CODE%.
  pause
)
exit /b %CODE%
