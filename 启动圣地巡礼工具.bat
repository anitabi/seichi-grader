@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  where python3 >nul 2>nul
  if not errorlevel 1 set "PY=python3"
)

if not defined PY (
  echo Python 3 was not found.
  echo Install Python 3.7 or newer from https://www.python.org/downloads/
  echo Tick "Add Python to PATH" during setup, then double-click this file again.
  pause
  exit /b 1
)

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Python 3.7 or newer is required.
  pause
  exit /b 1
)

%PY% -u "%~dp0tools\serve-windows.py" %*
if errorlevel 1 pause
