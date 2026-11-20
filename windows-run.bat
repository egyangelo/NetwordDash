@echo off
setlocal
cd /d "%~dp0app"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py %*
) else (
  python app.py %*
)
